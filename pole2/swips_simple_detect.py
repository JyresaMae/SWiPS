#!/usr/bin/env python3
"""
SWiPS — Simplified Detection Pipeline (C-zone ROI, 3-state)
═══════════════════════════════════════════════════════════
Pedestrian-advisory system for unsignalized crossings at MSU-IIT.
Scope: pedestrian-facing only. Driver responsibilities are covered by RA 4136.

States (3 only):
  IDLE          → no pedestrian in crosswalk ROI    → logo + "SYSTEM MONITORING"
  CROSSING      → ≥1 pedestrian in crosswalk ROI    → green + "PEDESTRIAN CROSSING"
  OBSTRUCTION   → crossing state held > 30 seconds  → red flash + "CLEAR CROSSWALK"

Debounce + Grace:
  C ∈ {0, 1} with 5-frame debounce to prevent flicker (~450ms at 11 FPS).
  When pedestrian leaves CW, a 2-second grace window holds the dwell timer
  before resetting. Tolerates transient occlusions (chair, tricycle, lighting).

MQTT publish policy:
  swips/detection → edge-triggered + 1 Hz heartbeat
  swips/alert     → OBSTRUCTION (critical) + OBSTRUCTION_CLEARED (info)
  swips/system    → 0.2 Hz (every 5s), enriched with mode + fps + location

Video pipeline (session 2 v4):
  - FFmpeg target URL: tcp://127.0.0.1:9998 (raw TCP, not HTTP).
    Server.js side uses net.createServer(). HTTP framing was triggering
    Node's strict parser and EPIPE-looping the encoder.
  - VIDEO_FPS = 25. MPEG-1 only supports a fixed set of frame rates
    (23.976, 24, 25, 29.97, 30, 50, 59.94, 60). 15 is NOT legal —
    encoder init fails with "MPEG-1/2 does not support 15/1 fps".
  - Frame-skip gate retained for back-pressure protection during
    transient CPU spikes.

Architecture:
  Thread 1 (detection) — YOLO person detector, ROI filter, state machine, MQTT
  Thread 2 (video)     — RTSP → annotate → FFmpeg → JSMpeg (dashboard video)
"""

import os, cv2, json, time, sys
import numpy as np, subprocess, threading
import paho.mqtt.client as mqtt
from ultralytics import YOLO
from datetime import datetime, timedelta
from collections import deque

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

# ══════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════
RTSP        = os.environ.get("SWIPS_RTSP", "rtsp://admin:swips2026@192.168.0.60:554/stream2")
POLE_ID     = os.environ.get("SWIPS_POLE", "pole-1")
POLE_LOC    = os.environ.get("SWIPS_LOCATION", "msu-iit-crosswalk")
W, H        = 736, 416     # native RTSP stream resolution (no upscaling)
CONF        = 0.50          # person detection confidence
VIDEO_FPS   = 25            # MUST be a legal MPEG-1 rate: 24, 25, 29.97, 30, 50, 59.94, 60
VIDEO_BITRATE = "800k"      # FFmpeg target bitrate
FRAME_W     = 736           # output frame width for FFmpeg (native RTSP res)
FRAME_H     = 416           # output frame height for FFmpeg (native RTSP res)

# Video sink — TCP socket that server.js (net.createServer) listens on
VIDEO_SINK_URL = "tcp://127.0.0.1:9998"

# ROI config
ROI_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "roi_config_camera_dual.json")
ENABLE_ROI_OVERLAY = True

# State machine
OBSTRUCTION_SEC   = 30
DEBOUNCE_FRAMES   = 3
LOSS_GRACE_SEC    = 8.0

# MQTT publish cadence
DET_HEARTBEAT_SEC = 1.0
SYS_HEARTBEAT_SEC = 5.0

# Snapshot config
SNAPSHOT_ENABLED   = True
SNAPSHOT_DIR       = "/home/pi/swips_project/snapshots"
SNAPSHOT_MAX_DAYS  = 30

# Alert cooldowns (seconds)
ALERT_COOLDOWN = {
    "OBSTRUCTION": 30,
}

# MQTT
MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1883
MQTT_TOPIC_DET = "swips/detection"
MQTT_TOPIC_ALERT = "swips/alert"
MQTT_TOPIC_SYS = "swips/system"

# ══════════════════════════════════════════════════════════════
# MODEL PATHS (person detection only — no vehicle, no pose)
# ══════════════════════════════════════════════════════════════
PROJECT = "/home/pi/swips_project"

DET_PATH_NCNN = os.path.join(PROJECT, "models", "best_ncnn_model")
DET_PATH_PT   = os.path.join(PROJECT, "models", "swips_final_v1", "weights", "best.pt")

# ══════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════
if SNAPSHOT_ENABLED:
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)

_last_alert = {}

def can_fire_alert(atype):
    now = time.time()
    cd = ALERT_COOLDOWN.get(atype, 5)
    if now - _last_alert.get(atype, 0) >= cd:
        _last_alert[atype] = now
        return True
    return False

def save_snapshot(frame, atype, meta=None):
    if not SNAPSHOT_ENABLED:
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    fname = f"{atype}_{ts}.jpg"
    fpath = os.path.join(SNAPSHOT_DIR, fname)
    cv2.imwrite(fpath, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if meta:
        with open(fpath.replace(".jpg", ".json"), "w") as f:
            json.dump({"alert_type": atype, "timestamp": datetime.now().isoformat(),
                       "filename": fname, **meta}, f, indent=2)
    return fname

def cleanup_snapshots():
    if not SNAPSHOT_ENABLED or not os.path.exists(SNAPSHOT_DIR):
        return
    cutoff = datetime.now() - timedelta(days=SNAPSHOT_MAX_DAYS)
    removed = 0
    for f in os.listdir(SNAPSHOT_DIR):
        fp = os.path.join(SNAPSHOT_DIR, f)
        if os.path.isfile(fp) and datetime.fromtimestamp(os.path.getmtime(fp)) < cutoff:
            os.remove(fp); removed += 1
    if removed:
        print(f"[CLEANUP] Deleted {removed} old snapshots", flush=True)

def cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000, 1)
    except:
        return 0.0

def point_in_polygon(pt, poly):
    """Ray-casting point-in-polygon test. poly is np.int32 of shape (N, 2)."""
    x, y = pt
    n = len(poly)
    inside = False
    px, py = poly[0]
    for i in range(1, n + 1):
        qx, qy = poly[i % n]
        if min(py, qy) < y <= max(py, qy) and x <= max(px, qx):
            xi = px
            if py != qy:
                xi = (y - py) * (qx - px) / (qy - py) + px
            if px == qx or x <= xi:
                inside = not inside
        px, py = qx, qy
    return inside

def determine_safety(mode):
    """3-state → safety level for dashboard display."""
    if mode == "OBSTRUCTION":
        return "LOW"
    if mode == "CROSSING":
        return "MODERATE"
    return "HIGH"

# ══════════════════════════════════════════════════════════════
# LOAD ROI (crosswalk polygon is REQUIRED — it's our filter)
# ══════════════════════════════════════════════════════════════
print(f"[SWiPS] {POLE_ID} | RTSP: {RTSP}", flush=True)
cleanup_snapshots()

CW_ROI = None
_roi_polygons_raw = {}

try:
    with open(ROI_CONFIG_PATH) as _f:
        _roi_cfg = json.load(_f)
    if "crosswalk_roi" not in _roi_cfg:
        raise ValueError("roi_config is missing 'crosswalk_roi' key")
    CW_ROI = np.array(_roi_cfg["crosswalk_roi"], dtype=np.int32)
    if len(CW_ROI) < 3:
        raise ValueError(f"crosswalk_roi has only {len(CW_ROI)} vertices (need ≥3)")
    print(f"[OK] Crosswalk ROI loaded: {len(CW_ROI)} vertices", flush=True)

    if ENABLE_ROI_OVERLAY:
        for _name in ("crosswalk_roi", "sidewalk_left_roi", "sidewalk_right_roi"):
            if _name in _roi_cfg and isinstance(_roi_cfg[_name], list) and len(_roi_cfg[_name]) >= 3:
                _roi_polygons_raw[_name] = np.array(_roi_cfg[_name], dtype=np.int32)
except Exception as e:
    print(f"[FATAL] Cannot load crosswalk ROI from {ROI_CONFIG_PATH}: {e}", flush=True)
    sys.exit(1)

# ══════════════════════════════════════════════════════════════
# LOAD MODEL (person detection only)
# ══════════════════════════════════════════════════════════════
print("[OK] Loading person detection model...", flush=True)
if os.path.exists(DET_PATH_NCNN):
    det_model = YOLO(DET_PATH_NCNN)
    print(f"[OK] Using NCNN model: {DET_PATH_NCNN}", flush=True)
elif os.path.exists(DET_PATH_PT):
    det_model = YOLO(DET_PATH_PT)
    print(f"[OK] Using PyTorch model: {DET_PATH_PT}", flush=True)
else:
    det_model = YOLO("yolov8n.pt")
    print("[WARN] Using generic yolov8n.pt (no custom model found)", flush=True)

print("[OK] Models ready", flush=True)

# ══════════════════════════════════════════════════════════════
# MQTT
# ══════════════════════════════════════════════════════════════
mc = mqtt.Client(client_id=f"swips-{POLE_ID}")
try:
    mc.connect(MQTT_HOST, MQTT_PORT, 60)
    mc.loop_start()
    print(f"[MQTT] Connected to {MQTT_HOST}:{MQTT_PORT}", flush=True)
except Exception as e:
    print(f"[MQTT] WARNING: {e} — running without MQTT", flush=True)
    mc = None

def mqtt_pub(topic, data):
    if mc and mc.is_connected():
        try:
            mc.publish(topic, json.dumps(data))
        except:
            pass

# ══════════════════════════════════════════════════════════════
# SHARED STATE (between detection + video threads)
# ══════════════════════════════════════════════════════════════
data_lock = threading.Lock()
latest_frame = None
latest_boxes = []
latest_mode = "IDLE"
latest_safety = "HIGH"
det_fps = 0.0
g_frame_count = 0

# ══════════════════════════════════════════════════════════════
# FFmpeg pipe — writes mpegts to a raw TCP socket (server.js listens)
# ══════════════════════════════════════════════════════════════
def start_ffmpeg():
    return subprocess.Popen([
        "ffmpeg", "-y",
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-f", "rawvideo", "-vcodec", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{FRAME_W}x{FRAME_H}", "-r", "25",
        "-i", "-",
        "-codec:v", "mpeg1video", "-b:v", "400k",
        "-r", "25", "-bf", "0", "-an",
        "-flush_packets", "1",
        "-f", "mpegts",
        VIDEO_SINK_URL,
    ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
       bufsize=0)

# ══════════════════════════════════════════════════════════════
# DRAWING HELPERS
# ══════════════════════════════════════════════════════════════
COLORS = {
    "PEDESTRIAN_IN":  (0, 255, 100),
    "PEDESTRIAN_OUT": (120, 120, 120),
}

ROI_COLORS = {
    "crosswalk_roi":      (255, 220, 0),
    "sidewalk_left_roi":  (0, 180, 255),
    "sidewalk_right_roi": (0, 180, 255),
}
ROI_LABELS = {
    "crosswalk_roi":      "CROSSWALK",
    "sidewalk_left_roi":  "SIDEWALK L",
    "sidewalk_right_roi": "SIDEWALK R",
}

def draw_roi_polygons(img, sx, sy):
    if not _roi_polygons_raw:
        return img
    overlay = img.copy()
    for name, pts_raw in _roi_polygons_raw.items():
        pts = np.stack([(pts_raw[:, 0] * sx).astype(np.int32),
                        (pts_raw[:, 1] * sy).astype(np.int32)], axis=1)
        cv2.fillPoly(overlay, [pts], ROI_COLORS[name])
    cv2.addWeighted(overlay, 0.18, img, 0.82, 0, img)
    for name, pts_raw in _roi_polygons_raw.items():
        pts = np.stack([(pts_raw[:, 0] * sx).astype(np.int32),
                        (pts_raw[:, 1] * sy).astype(np.int32)], axis=1)
        cv2.polylines(img, [pts], isClosed=True, color=ROI_COLORS[name],
                      thickness=2, lineType=cv2.LINE_AA)
        anchor_idx = int(np.argmin(pts[:, 0] + pts[:, 1]))
        lx, ly = int(pts[anchor_idx, 0]), int(pts[anchor_idx, 1])
        label = ROI_LABELS[name]
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.38, 1)
        ly_text = max(ly - 4, th + 2)
        cv2.rectangle(img, (lx, ly_text - th - 3), (lx + tw + 6, ly_text + 2),
                      (0, 0, 0), -1)
        cv2.putText(img, label, (lx + 3, ly_text - 1),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.38, ROI_COLORS[name], 1, cv2.LINE_AA)
    return img

def draw_boxes(img, persons):
    for d in persons:
        x1, y1, x2, y2 = d["x1"], d["y1"], d["x2"], d["y2"]
        in_cw = d.get("in_cw", False)
        color = COLORS["PEDESTRIAN_IN"] if in_cw else COLORS["PEDESTRIAN_OUT"]
        label = f"PEDESTRIAN {int(d['conf']*100)}%"
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
        cv2.rectangle(img, (x1, y1 - th - 6), (x1 + tw + 6, y1), color, -1)
        cv2.putText(img, label, (x1 + 3, y1 - 3),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)
    return img

def draw_status(img, mode, ped_count, fps):
    return img

# ══════════════════════════════════════════════════════════════
# THREAD 1: Detection (YOLO → ROI filter → debounce → state machine → MQTT)
# ══════════════════════════════════════════════════════════════
def detection_thread():
    global latest_boxes, latest_mode, latest_safety, det_fps, g_frame_count

    cross_t = None
    last_seen_t = None
    in_grace = False
    prev_mode = "IDLE"
    last_sys = 0.0
    last_det_pub = 0.0
    boot_t = time.time()

    c_history = deque(maxlen=DEBOUNCE_FRAMES)
    c_debounced = 0

    fps_q = deque(maxlen=30)
    prev_t = time.time()
    det_frame_count = 0

    while True:
        det_cap = None
        try:
            print("[DET] Opening dedicated RTSP cap", flush=True)
            det_cap = cv2.VideoCapture(RTSP, cv2.CAP_FFMPEG)
            det_cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not det_cap.isOpened():
                print("[DET] RTSP open failed, retry 5s", flush=True)
                time.sleep(5)
                continue
            print("[DET] RTSP connected - fresh frames", flush=True)
            while True:
                det_cap.grab()
                det_cap.grab()
                ret, frame = det_cap.read()
                if not ret or frame is None:
                    print("[DET] Frame fail, reconnecting", flush=True)
                    break
                frame = cv2.resize(frame, (W, H))
                t0 = time.time()
                det_frame_count += 1
                dr = det_model(frame, conf=CONF, classes=[0], verbose=False)
                pboxes = []
                for b in dr[0].boxes:
                    x1, y1, x2, y2 = map(int, b.xyxy[0])
                    cf = float(b.conf[0])
                    bh = y2 - y1
                    bw = x2 - x1
                    if bh >= 40 and bw / max(bh, 1) > 0.15:
                        pboxes.append((x1, y1, x2, y2, cf))
                pedestrians = []
                peds_in_cw = 0
                for pb in pboxes:
                    x1, y1, x2, y2, cf = pb
                    foot = ((x1 + x2) // 2, y2)
                    in_cw = point_in_polygon(foot, CW_ROI)
                    if in_cw:
                        peds_in_cw += 1
                    pedestrians.append({
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "conf": round(cf, 2), "in_cw": in_cw,
                    })
                c_raw = 1 if peds_in_cw > 0 else 0
                c_history.append(c_raw)
                if len(c_history) == DEBOUNCE_FRAMES:
                    if all(v == 1 for v in c_history):
                        c_debounced = 1
                    elif all(v == 0 for v in c_history):
                        c_debounced = 0
                now_ts = time.time()
                if c_debounced == 1:
                    if cross_t is None:
                        cross_t = now_ts
                    last_seen_t = now_ts
                    in_grace = False
                    duration = now_ts - cross_t
                    mode = "OBSTRUCTION" if duration > OBSTRUCTION_SEC else "CROSSING"
                else:
                    if cross_t is not None and last_seen_t is not None:
                        lost_for = now_ts - last_seen_t
                        if lost_for < LOSS_GRACE_SEC:
                            in_grace = True
                            duration = now_ts - cross_t
                            mode = "OBSTRUCTION" if duration > OBSTRUCTION_SEC else "CROSSING"
                        else:
                            cross_t = None
                            last_seen_t = None
                            in_grace = False
                            mode = "IDLE"
                    else:
                        mode = "IDLE"
                obstruction_dur = (now_ts - cross_t) if cross_t else None
                safety = determine_safety(mode)
                now = time.time()
                elapsed = now - prev_t
                if elapsed > 0:
                    fps_q.append(1.0 / elapsed)
                prev_t = now
                cur_fps = sum(fps_q) / len(fps_q) if fps_q else 0
                latency = round((now - t0) * 1000, 1)
                with data_lock:
                    latest_boxes = pedestrians
                    latest_mode = mode
                    latest_safety = safety
                    det_fps = cur_fps
                    g_frame_count += 1
                state_changed = (mode != prev_mode)
                heartbeat_due = (now - last_det_pub) >= DET_HEARTBEAT_SEC
                if state_changed or heartbeat_due:
                    mqtt_pub(MQTT_TOPIC_DET, {
                        "mode": mode,
                        "crosswalk": peds_in_cw,
                        "safetyLevel": safety,
                        "dwellSeconds": round(obstruction_dur, 1) if obstruction_dur else 0,
                        "inGrace": in_grace,
                        "latency": latency,
                        "fps": round(cur_fps, 2),
                        "frame": g_frame_count,
                        "source": "camera",
                        "pole": POLE_ID,
                        "location": POLE_LOC,
                        "edge": state_changed,
                        "timestamp": datetime.now().isoformat(),
                    })
                    last_det_pub = now
                if mode == "OBSTRUCTION" and prev_mode != "OBSTRUCTION":
                    if can_fire_alert("OBSTRUCTION"):
                        snap = save_snapshot(frame, "OBSTRUCTION", {
                            "pedestrian_count": peds_in_cw,
                            "duration": round(obstruction_dur or 0, 1),
                            "pole": POLE_ID,
                        })
                        mqtt_pub(MQTT_TOPIC_ALERT, {
                            "type": "OBSTRUCTION",
                            "severity": "critical",
                            "location": POLE_LOC,
                            "pole": POLE_ID,
                            "message": f"Crosswalk obstruction (>{OBSTRUCTION_SEC}s)",
                            "pedestrianCount": peds_in_cw,
                            "duration": round(obstruction_dur or 0, 1),
                            "snapshot": snap,
                            "timestamp": datetime.now().isoformat(),
                        })
                        print(f"  OBSTRUCTION | peds={peds_in_cw}", flush=True)
                if prev_mode == "OBSTRUCTION" and mode != "OBSTRUCTION":
                    mqtt_pub(MQTT_TOPIC_ALERT, {
                        "type": "OBSTRUCTION_CLEARED",
                        "severity": "info",
                        "location": POLE_LOC,
                        "pole": POLE_ID,
                        "message": "Crosswalk cleared",
                        "pedestrianCount": peds_in_cw,
                        "newState": mode,
                        "timestamp": datetime.now().isoformat(),
                    })
                    print(f"  OBSTRUCTION CLEARED -> {mode}", flush=True)
                prev_mode = mode
                if time.time() - last_sys > SYS_HEARTBEAT_SEC:
                    try:
                        load = os.getloadavg()[0]
                        cores = os.cpu_count() or 1
                        cpu_usage = round(load * 100 / cores, 1)
                    except:
                        cpu_usage = 0.0
                    mqtt_pub(MQTT_TOPIC_SYS, {
                        "node": POLE_ID,
                        "location": POLE_LOC,
                        "mode": mode,
                        "fps": round(cur_fps, 2),
                        "uptimeSeconds": round(time.time() - boot_t, 1),
                        "cpuTemp": cpu_temp(),
                        "cpuUsage": cpu_usage,
                        "memoryUsage": 14.0,
                        "batteryVoltage": 12.4,
                        "batteryPercent": 85,
                        "timestamp": datetime.now().isoformat(),
                    })
                    last_sys = time.time()
                if det_frame_count % 10 == 0:
                    grace_flag = " [GRACE]" if in_grace else ""
                    print(f"  [F{det_frame_count}] {mode}{grace_flag} | CW:{peds_in_cw} c_deb:{c_debounced} | {latency}ms | {cur_fps:.1f} FPS",
                          flush=True)
        except Exception as e:
            print(f"[DET] Error: {e}, reconnecting in 5s", flush=True)
            time.sleep(5)
        finally:
            if det_cap:
                try: det_cap.release()
                except: pass
def video_thread():
    global latest_frame
    frame_interval = 1.0 / VIDEO_FPS
    vid_frame_count = 0
    skipped_frames = 0
    ffpipe = None

    while True:
        cap = None
        try:
            print(f"[CONNECT] Opening RTSP: {RTSP}", flush=True)
            cap = cv2.VideoCapture(RTSP, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                print("[ERROR] Cannot open stream, retry in 5s", flush=True)
                time.sleep(5)
                continue

            if ffpipe is None or ffpipe.poll() is not None:
                try:
                    if ffpipe: ffpipe.kill()
                except: pass
                for attempt in range(5):
                    try:
                        ffpipe = start_ffmpeg()
                        time.sleep(0.5)
                        if ffpipe.poll() is None:
                            print(f"[OK] FFmpeg pipe started ({VIDEO_FPS} FPS @ {VIDEO_BITRATE} → {VIDEO_SINK_URL})", flush=True)
                            break
                    except:
                        pass
                    print(f"[WARN] FFmpeg start attempt {attempt+1}/5 failed, retrying...", flush=True)
                    time.sleep(2)

            print("[OK] Stream opened, streaming...", flush=True)

            while True:
                t_start = time.time()

                cap.grab()
                # Flush stale buffer — get only the freshest frame
                for _ in range(3):
                    cap.grab()
                ret, frame = cap.read()
                if not ret:
                    print("[WARN] Frame drop, reconnecting...", flush=True)
                    break

                frame = cv2.resize(frame, (W, H))
                vid_frame_count += 1

                with data_lock:
                    latest_frame = frame.copy()

                budget_used = time.time() - t_start
                behind_schedule = budget_used > (frame_interval * 0.8)

                if behind_schedule:
                    skipped_frames += 1
                else:
                    with data_lock:
                        boxes = list(latest_boxes)
                        d_fps = det_fps
                        mode = latest_mode

                    out = cv2.resize(frame, (FRAME_W, FRAME_H))
                    sx, sy = FRAME_W / W, FRAME_H / H
                    scaled_persons = [{
                        "x1": int(b["x1"]*sx), "y1": int(b["y1"]*sy),
                        "x2": int(b["x2"]*sx), "y2": int(b["y2"]*sy),
                        "conf": b["conf"], "in_cw": b["in_cw"],
                    } for b in boxes]
                    if ENABLE_ROI_OVERLAY:
                        out = draw_roi_polygons(out, sx, sy)
                    out = draw_boxes(out, scaled_persons)
                    out = draw_status(out, mode, len(boxes), d_fps)

                    if ffpipe and ffpipe.poll() is None and ffpipe.stdin:
                        try:
                            ffpipe.stdin.write(out.tobytes())
                            ffpipe.stdin.flush()
                        except (BrokenPipeError, OSError):
                            try: ffpipe.kill()
                            except: pass
                            ffpipe = None
                            time.sleep(0.5)
                            try:
                                ffpipe = start_ffmpeg()
                                print("[OK] FFmpeg pipe restarted", flush=True)
                            except:
                                ffpipe = None
                    else:
                        if ffpipe is None or (ffpipe and ffpipe.poll() is not None):
                            try:
                                if ffpipe: ffpipe.kill()
                            except: pass
                            try:
                                ffpipe = start_ffmpeg()
                                time.sleep(0.3)
                            except:
                                ffpipe = None

                if vid_frame_count % 100 == 0:
                    skip_pct = (skipped_frames / vid_frame_count * 100) if vid_frame_count else 0
                    print(f"  [VID F{vid_frame_count}] target={VIDEO_FPS}FPS  skip={skip_pct:.1f}%", flush=True)
                    # Restart FFmpeg every 100 frames to flush buffer backlog
                    if ffpipe:
                        try: ffpipe.kill()
                        except: pass
                    try:
                        ffpipe = start_ffmpeg()
                        print("[OK] FFmpeg buffer cleared", flush=True)
                    except: ffpipe = None

                elapsed = time.time() - t_start
                wait = frame_interval - elapsed
                if wait > 0:
                    time.sleep(wait)

        except Exception as e:
            print(f"[ERROR] {e}, reconnecting in 5s...", flush=True)
            time.sleep(5)
        finally:
            if cap: cap.release()


# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print("═" * 60, flush=True)
    print(f"  SWiPS Detection — {POLE_ID.upper()} | 3-state C-only", flush=True)
    print(f"  Camera : {RTSP}", flush=True)
    print(f"  CW ROI : {len(CW_ROI)} vertices", flush=True)
    print(f"  Debounce: {DEBOUNCE_FRAMES} frames | Grace: {LOSS_GRACE_SEC}s", flush=True)
    print(f"  Dwell  : {OBSTRUCTION_SEC}s → OBSTRUCTION", flush=True)
    print(f"  Conf   : {CONF} (person)", flush=True)
    print(f"  Video  : {VIDEO_FPS} FPS @ {VIDEO_BITRATE} ({FRAME_W}x{FRAME_H}) → {VIDEO_SINK_URL}", flush=True)
    print(f"  MQTT   : det=edge+{DET_HEARTBEAT_SEC}s | sys={SYS_HEARTBEAT_SEC}s | alert=edge", flush=True)
    print(f"  Snapshots: {SNAPSHOT_DIR if SNAPSHOT_ENABLED else 'disabled'}", flush=True)
    print("═" * 60, flush=True)

    t_det = threading.Thread(target=detection_thread, daemon=True)
    t_vid = threading.Thread(target=video_thread, daemon=True)

    t_det.start()

    print("[WAIT] Waiting 5s for API server...", flush=True)
    time.sleep(5)

    t_vid.start()

    print("[OK] Detection + Video threads running", flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[EXIT] Shutting down...", flush=True)
    finally:
        if mc:
            mc.loop_stop()
            mc.disconnect()
