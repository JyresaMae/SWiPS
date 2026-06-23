#!/usr/bin/env python3
"""
SWiPS ROI Calibration Tool
Browser-based click-to-define crosswalk polygon
Runs on Pi, access from laptop browser
"""
from flask import Flask, Response, request, jsonify, render_template_string
import cv2, os, json, time, numpy as np

app = Flask(__name__)

RTSP = os.environ.get("SWIPS_RTSP", "rtsp://admin:swips2026@192.168.0.60:554/stream2")
ROI_CONFIG = os.environ.get("SWIPS_ROI_CONFIG", "/home/pi/swips_project/roi_config_camera_dual.json")

def grab_frame():
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
    cap = cv2.VideoCapture(RTSP, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    for _ in range(3):
        cap.grab()
    ret, frame = cap.read()
    cap.release()
    if ret:
        return frame
    return None

HTML = """<!DOCTYPE html>
<html>
<head>
<title>SWiPS ROI Calibrator</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; color: #e0e0e0; font-family: monospace; padding: 16px; }
h1 { color: #00ff88; font-size: 1.2em; margin-bottom: 4px; }
.sub { color: #888; font-size: 0.8em; margin-bottom: 12px; }
#wrap { position: relative; display: inline-block; border: 2px solid #333; }
#camImg { display: block; max-width: 100%; }
#overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair; }
.controls { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 0.9em; }
#btnRefresh { background: #1e3a5f; color: #7eb8f7; }
#btnClear   { background: #3a1e1e; color: #f77e7e; }
#btnSave    { background: #1e3a2a; color: #00ff88; font-weight: bold; }
#btnSave:disabled { opacity: 0.4; cursor: not-allowed; }
#status { margin-top: 10px; padding: 8px 12px; border-radius: 4px; background: #1a1a2e; font-size: 0.85em; min-height: 36px; }
#status.ok  { color: #00ff88; border-left: 3px solid #00ff88; }
#status.err { color: #f77e7e; border-left: 3px solid #f77e7e; }
#status.info{ color: #7eb8f7; border-left: 3px solid #7eb8f7; }
.pts-list { margin-top: 8px; color: #aaa; font-size: 0.8em; }
.hint { color: #666; font-size: 0.78em; margin-top: 6px; }
</style>
</head>
<body>
<h1>⬡ SWiPS ROI Calibrator</h1>
<div class="sub">Click 4 corners of the crosswalk polygon on the live frame → Save</div>

<div id="wrap">
  <img id="camImg" src="/snapshot" alt="Loading frame...">
  <canvas id="overlay"></canvas>
</div>

<div class="controls">
  <button id="btnRefresh" onclick="refreshFrame()">↺ Refresh Frame</button>
  <button id="btnClear" onclick="clearPts()">✕ Clear Points</button>
  <button id="btnSave" onclick="savePts()" disabled>💾 Save to JSON</button>
  <span style="color:#888;font-size:0.85em" id="ptCount">0 / 4 points</span>
</div>

<div class="pts-list" id="ptsList"></div>
<div id="status" class="info">Load a frame, then click 4 corners of the crosswalk (any order, going around the polygon).</div>
<div class="hint">Tip: click top-left → top-right → bottom-right → bottom-left for clean winding order.</div>

<script>
const canvas = document.getElementById('overlay');
const img    = document.getElementById('camImg');
const ctx    = canvas.getContext('2d');
let pts = [];
let imgW = 1, imgH = 1;      // actual image pixel dimensions
let dispW = 1, dispH = 1;    // displayed canvas dimensions

const COLORS = ['#ff4444','#ffaa00','#00ccff','#00ff88'];

function syncCanvas() {
  dispW = img.clientWidth;
  dispH = img.clientHeight;
  canvas.width  = dispW;
  canvas.height = dispH;
}

img.onload = () => {
  imgW = img.naturalWidth;
  imgH = img.naturalHeight;
  syncCanvas();
  draw();
};

function toDisp(px, py) {
  return [px * dispW / imgW, py * dispH / imgH];
}
function toImg(dx, dy) {
  return [Math.round(dx * imgW / dispW), Math.round(dy * imgH / dispH)];
}

canvas.addEventListener('click', e => {
  if (pts.length >= 4) return;
  const rect = canvas.getBoundingClientRect();
  const dx = e.clientX - rect.left;
  const dy = e.clientY - rect.top;
  const [px, py] = toImg(dx, dy);
  pts.push([px, py]);
  updateUI();
  draw();
});

function draw() {
  syncCanvas();
  ctx.clearRect(0, 0, dispW, dispH);
  if (pts.length === 0) return;

  // Draw polygon fill if 4 pts
  if (pts.length === 4) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [dx, dy] = toDisp(p[0], p[1]);
      i === 0 ? ctx.moveTo(dx, dy) : ctx.lineTo(dx, dy);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,255,136,0.15)';
    ctx.fill();
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    // Draw partial lines
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [dx, dy] = toDisp(p[0], p[1]);
      i === 0 ? ctx.moveTo(dx, dy) : ctx.lineTo(dx, dy);
    });
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5,4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw points
  pts.forEach((p, i) => {
    const [dx, dy] = toDisp(p[0], p[1]);
    ctx.beginPath();
    ctx.arc(dx, dy, 7, 0, 2*Math.PI);
    ctx.fillStyle = COLORS[i];
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i+1, dx, dy);
  });
}

function updateUI() {
  const n = pts.length;
  document.getElementById('ptCount').textContent = n + ' / 4 points';
  document.getElementById('btnSave').disabled = (n !== 4);
  const listEl = document.getElementById('ptsList');
  listEl.innerHTML = pts.map((p,i) =>
    `<span style="color:${COLORS[i]}">●</span> P${i+1}: [${p[0]}, ${p[1]}]`
  ).join('  ');
  if (n === 4) setStatus('4 points set. Click 💾 Save to write to roi_config_camera_dual.json', 'ok');
  else setStatus(`Click point ${n+1} on the crosswalk corner`, 'info');
}

function clearPts() {
  pts = [];
  updateUI();
  draw();
  setStatus('Cleared. Click 4 corners of the crosswalk.', 'info');
}

function refreshFrame() {
  setStatus('Grabbing fresh frame…', 'info');
  img.src = '/snapshot?t=' + Date.now();
}

async function savePts() {
  if (pts.length !== 4) return;
  setStatus('Saving…', 'info');
  try {
    const res = await fetch('/save_roi', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({crosswalk_roi: pts})
    });
    const data = await res.json();
    if (data.ok) {
      setStatus('✅ Saved to ' + data.path, 'ok');
    } else {
      setStatus('❌ Error: ' + data.error, 'err');
    }
  } catch(e) {
    setStatus('❌ Network error: ' + e, 'err');
  }
}

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls;
}

window.addEventListener('resize', () => { syncCanvas(); draw(); });
</script>
</body>
</html>
"""

@app.route('/')
def index():
    return render_template_string(HTML)

@app.route('/snapshot')
def snapshot():
    frame = grab_frame()
    if frame is None:
        # Return a simple error image
        frame = np.zeros((416, 736, 3), dtype=np.uint8)
        cv2.putText(frame, "CAMERA ERROR", (200, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0,0,255), 3)

    # Draw existing ROI if present
    try:
        with open(ROI_CONFIG) as f:
            cfg = json.load(f)
        roi = cfg.get("crosswalk_roi", [])
        if len(roi) >= 3:
            pts_arr = np.array(roi, dtype=np.int32)
            cv2.polylines(frame, [pts_arr], True, (0,255,136), 2)
            for i, (x,y) in enumerate(roi):
                cv2.circle(frame, (x,y), 5, (0,200,255), -1)
                cv2.putText(frame, str(i+1), (x+7,y-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,255), 1)
    except:
        pass

    _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return Response(buf.tobytes(), mimetype='image/jpeg')

@app.route('/save_roi', methods=['POST'])
def save_roi():
    try:
        data = request.get_json()
        new_roi = data['crosswalk_roi']

        # Load existing config to preserve other fields
        try:
            with open(ROI_CONFIG) as f:
                cfg = json.load(f)
        except:
            cfg = {"video": "LIVE_CAMERA", "sidewalk_left_roi": [[0,0],[0,1],[1,1],[1,0]], "sidewalk_right_roi": [[0,0],[0,1],[1,1],[1,0]]}

        cfg['crosswalk_roi'] = new_roi

        # Backup first
        bak = ROI_CONFIG + '.bak.' + time.strftime('%Y%m%d_%H%M%S')
        try:
            with open(ROI_CONFIG) as f:
                with open(bak, 'w') as fb:
                    fb.write(f.read())
        except:
            pass

        with open(ROI_CONFIG, 'w') as f:
            json.dump(cfg, f, indent=2)

        return jsonify(ok=True, path=ROI_CONFIG, roi=new_roi)
    except Exception as e:
        return jsonify(ok=False, error=str(e))

if __name__ == '__main__':
    print(f"[ROI] Camera: {RTSP}")
    print(f"[ROI] Config: {ROI_CONFIG}")
    print(f"[ROI] Open browser: http://<pi-ip>:5050")
    app.run(host='0.0.0.0', port=5050, debug=False)
