#!/usr/bin/env python3
"""RTSP→MJPEG bridge with ROI overlay drawn on every frame."""
import cv2, os, time, threading, json
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RTSP = "rtsp://admin:swips2026@192.168.1.242:554/stream1"
PORT = 9997
ROI_PATH = "/home/pi/swips_project/roi_config_camera_dual.json"
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

# Load ROI polygons (calibrated for 736x416 stream1)
ROI_POLYS = {}
try:
    with open(ROI_PATH) as f:
        cfg = json.load(f)
    for key, color, label in [
        ("crosswalk_roi",      (0, 255, 0),   "CROSSWALK"),
        ("sidewalk_left_roi",  (0, 200, 255), "SIDEWALK L"),
        ("sidewalk_right_roi", (0, 200, 255), "SIDEWALK R"),
    ]:
        if key in cfg and isinstance(cfg[key], list) and len(cfg[key]) >= 3:
            pts = np.array(cfg[key], dtype=np.int32)
            # Skip placeholder polygons (the [[0,0],[0,1],[1,1],[1,0]] ones)
            if pts.max() > 5:
                ROI_POLYS[key] = (pts, color, label)
    print(f"[BRIDGE] Loaded {len(ROI_POLYS)} ROI polygons", flush=True)
except Exception as e:
    print(f"[BRIDGE] ROI load failed: {e}", flush=True)

def draw_overlay(frame):
    """Draw ROI polygons + a header on the frame."""
    if not ROI_POLYS:
        return frame
    h, w = frame.shape[:2]
    # ROI is calibrated for stream1 native (736x416). Scale only if frame differs.
    sx, sy = w / 736.0, h / 416.0
    overlay = frame.copy()
    for key, (pts, color, label) in ROI_POLYS.items():
        scaled = np.stack([
            (pts[:, 0] * sx).astype(np.int32),
            (pts[:, 1] * sy).astype(np.int32),
        ], axis=1)
        cv2.fillPoly(overlay, [scaled], color)
    cv2.addWeighted(overlay, 0.20, frame, 0.80, 0, frame)
    for key, (pts, color, label) in ROI_POLYS.items():
        scaled = np.stack([
            (pts[:, 0] * sx).astype(np.int32),
            (pts[:, 1] * sy).astype(np.int32),
        ], axis=1)
        cv2.polylines(frame, [scaled], True, color, 2, cv2.LINE_AA)
        # Label at top-left of polygon
        anchor = scaled[np.argmin(scaled[:, 0] + scaled[:, 1])]
        cv2.rectangle(frame, (anchor[0], max(0, anchor[1] - 18)),
                      (anchor[0] + len(label) * 7 + 6, anchor[1] - 2), color, -1)
        cv2.putText(frame, label, (anchor[0] + 3, anchor[1] - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)
    return frame

latest = [None]
cond = threading.Condition()

def grabber():
    while True:
        try:
            cap = cv2.VideoCapture(RTSP, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                print("[BRIDGE] RTSP open failed, retry 3s", flush=True)
                time.sleep(3); continue
            print("[BRIDGE] RTSP connected", flush=True)
            while True:
                cap.grab(); cap.grab()
                ret, frame = cap.read()
                if not ret:
                    print("[BRIDGE] frame drop, reconnecting", flush=True)
                    break
                frame = draw_overlay(frame)
                ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    with cond:
                        latest[0] = buf.tobytes()
                        cond.notify_all()
            cap.release()
        except Exception as e:
            print(f"[BRIDGE] err {e}", flush=True)
            time.sleep(2)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while True:
                with cond:
                    cond.wait(timeout=2.0)
                    f = latest[0]
                if f is None: continue
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                                 str(len(f)).encode() + b"\r\n\r\n" + f + b"\r\n")
        except Exception:
            return

threading.Thread(target=grabber, daemon=True).start()
print(f"[BRIDGE] MJPEG on http://0.0.0.0:{PORT}/video", flush=True)
ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
