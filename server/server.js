// ═══════════════════════════════════════════════════════════════
// SWiPS Edge API Server
// Runs 100% offline on the Raspberry Pi 5
// MQTT → InfluxDB bridge + REST API + WebSocket + Static Dashboard
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const net     = require('net');
const WebSocket = require('ws');
const mqtt    = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '..', 'swips-dashboard')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ─── InfluxDB ───────────────────────────────────────────────
const influx = new InfluxDB({
  url: process.env.INFLUX_URL,
  token: process.env.INFLUX_TOKEN,
});

function getWriteApi(bucket) {
  const api = influx.getWriteApi(process.env.INFLUX_ORG, bucket, 'ms');
  return api;
}

const queryApi = influx.getQueryApi(process.env.INFLUX_ORG);

// ─── MQTT ───────────────────────────────────────────────────
const mqttClient = mqtt.connect(process.env.MQTT_URL);
mqttClient.on('connect', () => {
  console.log('[MQTT] Connected to local broker');
  mqttClient.subscribe('swips/#');
});

// ─── Live State (mirrors your swips_v12 variables) ──────────
let liveState = {
  node: "pole-1",
  crosswalkState: 'IDLE',
  crosswalkCount: 0,
  pedestrianCount: 0,
  jaywalkerCount: 0,
  detectedNow: 0,
  latency: 0,
  inferenceSpeed: 0,
  cpuTemp: 0,
  cpuUsage: 0,
  memoryUsage: 0,
  batteryVoltage: 12.6,
  batteryPercent: 100,
  activeAlerts: 0,
  safetyLevel: 'HIGH',
  pedestriansToday: 0,
  jaywalkersToday: 0,
  obstructionsToday: 0,
  lastAlertTime: null,
  source: 'none',
  videoName: '',
  frameNumber: 0,
  totalFrames: 0,
  videoProgress: 0,
};

// ─── Violation & Alert Tracking ───────────────────────────
let violationState = {
  today: {
    jaywalking: 0,
    massJaywalking: 0,
    obstruction: 0,
    obstructionWarning: 0,
    totalAlerts: 0,
    criticalAlerts: 0,
  },
  alertHistory: [],
  lastResetDate: new Date().toDateString(),
};

// ─── Crossing Event Tracker ─────────────────────────────────
let previousMode = 'IDLE';
let lastIdleTime = Date.now();
let inCrossingEvent = false;
const IDLE_DEBOUNCE_MS = 5000;

// Midnight reset
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    liveState.pedestriansToday = 0;
    liveState.jaywalkersToday = 0;
    liveState.obstructionsToday = 0;
    liveState.activeAlerts = 0;
    previousMode = 'IDLE';
    violationState.today = {
      jaywalking: 0, massJaywalking: 0, obstruction: 0,
      obstructionWarning: 0,
      totalAlerts: 0, criticalAlerts: 0,
    };
    violationState.alertHistory = [];
    violationState.lastResetDate = new Date().toDateString();
    console.log('[System] Midnight reset — all counters cleared');
    scheduleMidnightReset();
  }, midnight - now);
}
scheduleMidnightReset();

// ─── MQTT Message Handler ───────────────────────────────────
mqttClient.on('message', (topic, message) => {
  let data;
  try { data = JSON.parse(message.toString()); } catch { return; }

  switch (topic) {

    case 'swips/detection': {
      const THIS_NODE = 'pole-1';
      const msgNode = data.node || THIS_NODE;
      const isLocal = (msgNode === THIS_NODE);

      const currentMode = data.mode || 'IDLE';
      const crosswalkNow = data.crosswalk || 0;
      const pedestrianNow = data.pedestrian || 0;
      const jaywalkerNow = data.jaywalker || 0;
      const personsNow = crosswalkNow + pedestrianNow + jaywalkerNow;

      if (isLocal) {
        liveState.crosswalkCount  = crosswalkNow;
        liveState.pedestrianCount = pedestrianNow;
        liveState.jaywalkerCount  = jaywalkerNow;
        liveState.detectedNow     = personsNow;
        liveState.latency         = data.latency || 0;
        liveState.inferenceSpeed  = data.fps || 0;
        liveState.source          = data.source || 'video';
        liveState.videoName       = data.videoName || '';
        liveState.frameNumber     = data.frame || 0;
        liveState.totalFrames     = data.totalFrames || 0;
        liveState.videoProgress   = data.progress || 0;
      }

      const statePriority = { 'IDLE': 0, 'CROSSING': 1, 'OBSTRUCTION': 2 };

      if (isLocal) {
        liveState._localState = currentMode;
      } else {
        liveState._remoteState = currentMode;
        console.log(`[SYNC] Remote ${msgNode}: ${currentMode}`);
      }

      const localPri  = statePriority[liveState._localState  || 'IDLE'] || 0;
      const remotePri = statePriority[liveState._remoteState || 'IDLE'] || 0;
      const effectiveState = localPri >= remotePri
        ? (liveState._localState  || 'IDLE')
        : (liveState._remoteState || 'IDLE');
      liveState.crosswalkState = effectiveState;

      if (isLocal) {
        const isCrossing = effectiveState.startsWith('CROSSING') || effectiveState === 'OBSTRUCTION';

        if (!isCrossing) {
          if (inCrossingEvent) {
            lastIdleTime = Date.now();
            inCrossingEvent = false;
          }
        } else if (isCrossing && !inCrossingEvent) {
          const idleDuration = Date.now() - lastIdleTime;

          if (idleDuration >= IDLE_DEBOUNCE_MS) {
            inCrossingEvent = true;
            const eventCount = crosswalkNow + pedestrianNow;
            liveState.pedestriansToday += eventCount;
            liveState.jaywalkersToday += jaywalkerNow;

            console.log(`[EVENT] Crossing started: ${eventCount} pedestrians, ${jaywalkerNow} jaywalkers (idle was ${Math.round(idleDuration/1000)}s)`);
          }
        }

        // === State transition logger (Design B) =========================
        // Writes a crossing_event record on every state change.
        // dwell_time captures how long the PREVIOUS state lasted.
        if (effectiveState !== liveState._loggedState) {
          const nowMs = Date.now();
          const prevEnteredMs = liveState._loggedStateEnteredAt || nowMs;
          const dwellSec = (nowMs - prevEnteredMs) / 1000.0;
          const prevState = liveState._loggedState || 'IDLE';

          const writeApi = getWriteApi(process.env.INFLUX_BUCKET);
          const transitionPoint = new Point('crossing_event')
            .tag('location', data.location || 'msu-iit-crosswalk')
            .tag('source', data.source || 'video')
            .tag('node', THIS_NODE)
            .tag('prev_state', prevState)
            .stringField('state', effectiveState)
            .floatField('dwell_time', dwellSec)
            .intField('pedestrians', crosswalkNow + pedestrianNow)
            .intField('jaywalkers', jaywalkerNow)
            .floatField('latency', data.latency || 0);
          writeApi.writePoint(transitionPoint);
          writeApi.flush();

          console.log(`[TRANSITION] ${prevState} -> ${effectiveState} (dwell: ${dwellSec.toFixed(1)}s)`);

          liveState._loggedState = effectiveState;
          liveState._loggedStateEnteredAt = nowMs;
        }

        previousMode = effectiveState;

        if (data.safetyLevel) {
          liveState.safetyLevel = data.safetyLevel;
        } else {
          if (liveState.crosswalkState === 'OBSTRUCTION' || liveState.activeAlerts > 5)
            liveState.safetyLevel = 'LOW';
          else if (liveState.jaywalkerCount > 0 || liveState.activeAlerts > 2)
            liveState.safetyLevel = 'MODERATE';
          else
            liveState.safetyLevel = 'HIGH';
        }

        const IDLE_LOG_INTERVAL_MS = 5000;
        const isActiveState = effectiveState !== 'IDLE';
        const nowTs = Date.now();
        const shouldLogFrame =
          isActiveState ||
          (nowTs - (liveState._lastIdleFrameLogMs || 0)) >= IDLE_LOG_INTERVAL_MS;

        if (shouldLogFrame) {
          if (!isActiveState) liveState._lastIdleFrameLogMs = nowTs;

          const writeApi2 = getWriteApi(process.env.INFLUX_BUCKET);
          const framePoint = new Point('detection_frame')
            .tag('location', data.location || 'msu-iit-crosswalk')
            .tag('source', data.source || 'video')
            .tag('node', THIS_NODE)
            .stringField('state', effectiveState)
            .intField('crosswalk', crosswalkNow)
            .intField('pedestrian', pedestrianNow)
            .intField('jaywalker', jaywalkerNow)
            .intField('totalPersons', personsNow)
            .floatField('latency', data.latency || 0)
            .floatField('fps', data.fps || 0)
            .intField('frame', data.frame || 0);
          writeApi2.writePoint(framePoint);
          writeApi2.flush();
        }
      }
      break;
    }

    case 'swips/system': {
      liveState.cpuTemp        = data.cpuTemp || 0;
      liveState.cpuUsage       = data.cpuUsage || 0;
      liveState.memoryUsage    = data.memoryUsage || 0;
      liveState.batteryVoltage = data.batteryVoltage || 12.6;
      liveState.batteryPercent = data.batteryPercent || 100;

      const writeApi = getWriteApi(process.env.INFLUX_BUCKET_SYSTEM);
      const point = new Point('system')
        .tag('node', data.node || 'pole-1')
        .floatField('cpuTemp', data.cpuTemp || 0)
        .floatField('cpuUsage', data.cpuUsage || 0)
        .floatField('memoryUsage', data.memoryUsage || 0)
        .floatField('batteryVoltage', data.batteryVoltage || 12.6)
        .floatField('batteryPercent', data.batteryPercent || 100);
      writeApi.writePoint(point);
      writeApi.flush();
      break;
    }

    case 'swips/alert': {
      const todayStr = new Date().toDateString();
      if (todayStr !== violationState.lastResetDate) {
        violationState.today = {
          jaywalking: 0, massJaywalking: 0, obstruction: 0,
          obstructionWarning: 0,
          totalAlerts: 0, criticalAlerts: 0,
        };
        violationState.alertHistory = [];
        violationState.lastResetDate = todayStr;
      }

      violationState.today.totalAlerts++;
      liveState.liveAlerts = (liveState.liveAlerts || 0) + 1;
      liveState.activeAlerts = liveState.liveAlerts;
      liveState.lastAlertTime = new Date().toISOString();

      if (data.severity === 'critical') {
        violationState.today.criticalAlerts++;
      }

      switch (data.type) {
        case 'JAYWALKING':
          violationState.today.jaywalking += (data.jaywalkerCount || 1);
          liveState.jaywalkersToday += (data.jaywalkerCount || 1);
          break;
        case 'MASS_JAYWALKING':
          violationState.today.massJaywalking++;
          violationState.today.jaywalking += (data.jaywalkerCount || 3);
          liveState.jaywalkersToday += (data.jaywalkerCount || 3);
          break;
        case 'OBSTRUCTION':
          violationState.today.obstruction++;
          liveState.obstructionsToday += 1;
          break;
        case 'OBSTRUCTION_WARNING':
          violationState.today.obstructionWarning++;
          break;
      }

      const alertEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        type: data.type,
        severity: data.severity,
        location: data.location || POLE_LOCATION,
        pole: data.pole || 'pole-1',
        message: data.message || '',
        snapshot: data.snapshot || null,
        pedestrianCount: data.pedestrianCount || 0,
        jaywalkerCount: data.jaywalkerCount || 0,
        duration: data.duration || 0,
        timestamp: data.timestamp || new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        status: 'active',
      };
      violationState.alertHistory.unshift(alertEntry);
      if (violationState.alertHistory.length > 100) {
        violationState.alertHistory = violationState.alertHistory.slice(0, 100);
      }

      const writeApi = getWriteApi(process.env.INFLUX_BUCKET_ALERTS);
      const point = new Point('alert')
        .tag('type', data.type || 'UNKNOWN')
        .tag('severity', data.severity || 'normal')
        .tag('location', data.location || 'msu-iit-crosswalk')
        .tag('pole', data.pole || 'pole-1')
        .stringField('message', data.message || '')
        .stringField('status', 'active')
        .intField('pedestrianCount', data.pedestrianCount || 0)
        .intField('jaywalkerCount', data.jaywalkerCount || 0)
        .floatField('duration', data.duration || 0)
        .stringField('snapshot', data.snapshot || '');
      writeApi.writePoint(point);
      writeApi.flush();

      console.log(`[ALERT] ${(data.severity || '').toUpperCase()}: ${data.type} — ${data.message}`);
      break;
    }
  }

  const payload = JSON.stringify({
    topic, data, liveState,
    violations: violationState.today,
    alertHistory: topic === 'swips/alert' ? violationState.alertHistory.slice(0, 5) : undefined,
    timestamp: new Date().toISOString(),
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
});

// ─── Flux Query Helper ──────────────────────────────────────
async function queryInflux(query) {
  const rows = [];
  return new Promise((resolve, reject) => {
    queryApi.queryRows(query, {
      next(row, tableMeta) { rows.push(tableMeta.toObject(row)); },
      error(err) { reject(err); },
      complete() { resolve(rows); },
    });
  });
}

// ─── REST Endpoints ─────────────────────────────────────────

app.get('/api/live', (req, res) => res.json(liveState));

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  mqtt: mqttClient.connected,
  uptime: process.uptime(),
  mode: 'edge-offline',
  hostname: require('os').hostname(),
}));

app.get('/api/analytics/hourly', async (req, res) => {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: today())
        |> filter(fn: (r) => r._measurement == "crossing_event" and r._field == "pedestrians")
        |> filter(fn: (r) => r.prev_state == "IDLE")
        |> aggregateWindow(every: 1h, fn: sum, createEmpty: true)
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/weekly', async (req, res) => {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: -7d)
        |> filter(fn: (r) => r._measurement == "crossing_event" and r._field == "pedestrians")
        |> filter(fn: (r) => r.prev_state == "IDLE")
        |> aggregateWindow(every: 1d, fn: sum, createEmpty: true)
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/modes', async (req, res) => {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: today())
        |> filter(fn: (r) => r._measurement == "detection_frame" and r._field == "state")
        |> group()
        |> reduce(
            identity: {IDLE: 0, CROSSING: 0, OBSTRUCTION: 0},
            fn: (r, accumulator) => ({
              IDLE:        if r._value == "IDLE"        then accumulator.IDLE + 1        else accumulator.IDLE,
              CROSSING:    if r._value == "CROSSING"    then accumulator.CROSSING + 1    else accumulator.CROSSING,
              OBSTRUCTION: if r._value == "OBSTRUCTION" then accumulator.OBSTRUCTION + 1 else accumulator.OBSTRUCTION
            })
          )
    `);
    const result = rows[0] || {};
    const total = (result.IDLE || 0) + (result.CROSSING || 0) + (result.OBSTRUCTION || 0);
    res.json({ IDLE: result.IDLE || 0, CROSSING: result.CROSSING || 0, OBSTRUCTION: result.OBSTRUCTION || 0, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/heatmap', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 14, 30);
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: -${days}d)
        |> filter(fn: (r) => r._measurement == "detection_frame" and r._field == "totalPersons")
        |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
        |> fill(value: 0.0)
    `);

    const grid = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }))
    );
    for (const r of rows) {
      if (r._time == null || r._value == null) continue;
      const d = new Date(r._time);
      const dow = (d.getDay() + 6) % 7;
      const hr  = d.getHours();
      grid[dow][hr].sum += Number(r._value) || 0;
      grid[dow][hr].count += 1;
    }
    const matrix = grid.map(day =>
      day.map(cell => (cell.count === 0 ? 0 : +(cell.sum / cell.count).toFixed(2)))
    );
    res.json({
      days,
      measurement: 'detection_frame.totalPersons',
      aggregation: 'hourly mean, averaged across matching day-of-week',
      dayOrder: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
      matrix,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/export.csv', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: -${days}d)
        |> filter(fn: (r) => r._measurement == "crossing_event")
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: false)
    `);

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['timestamp','node','location','source','state','pedestrians','jaywalkers','latency_ms'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r._time || '',
        r.node || '',
        r.location || '',
        r.source || '',
        r.state || '',
        r.pedestrians ?? '',
        r.jaywalkers ?? '',
        r.latency ?? '',
      ].map(esc).join(','));
    }

    const filename = `swips-crossing-events-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/alerts/today', async (req, res) => {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET_ALERTS}")
        |> range(start: today())
        |> filter(fn: (r) => r._measurement == "alert")
        |> sort(columns: ["_time"], desc: true)
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/alerts/weekly', async (req, res) => {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET_ALERTS}")
        |> range(start: -7d)
        |> filter(fn: (r) => r._measurement == "alert")
        |> aggregateWindow(every: 1d, fn: count, createEmpty: true)
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/alerts/export.csv', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET_ALERTS}")
        |> range(start: -${days}d)
        |> filter(fn: (r) => r._measurement == "alert")
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
    `);

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = [
      'timestamp', 'pole', 'location', 'type', 'severity', 'status',
      'message', 'pedestrian_count', 'jaywalker_count',
      'duration_sec', 'snapshot'
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r._time || '',
        r.pole || '',
        r.location || '',
        r.type || '',
        r.severity || '',
        r.status || '',
        r.message || '',
        r.pedestrianCount ?? '',
        r.jaywalkerCount ?? '',
        r.duration ?? '',
        r.snapshot || '',
      ].map(esc).join(','));
    }

    const filename = `swips-alerts-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/system/history', async (req, res) => {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET_SYSTEM}")
        |> range(start: -1h)
        |> filter(fn: (r) => r._measurement == "system")
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export/:bucket', async (req, res) => {
  const bucket = req.params.bucket;
  const days = parseInt(req.query.days) || 7;
  try {
    const rows = await queryInflux(`
      from(bucket: "${bucket}")
        |> range(start: -${days}d)
    `);
    res.setHeader('Content-Disposition',
      `attachment; filename=swips-${bucket}-${new Date().toISOString().slice(0,10)}.json`);
    res.json({
      exportDate: new Date().toISOString(),
      bucket, days,
      recordCount: rows.length,
      data: rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/violations', (req, res) => res.json({
  today: violationState.today,
  safetyLevel: liveState.safetyLevel,
}));

app.get('/api/alerts/live', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    alerts: violationState.alertHistory.slice(0, limit),
    total: violationState.alertHistory.length,
    violations: violationState.today,
  });
});

app.use('/snapshots', express.static('/home/pi/swips_project/snapshots'));

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'swips-dashboard', 'index.html'));
});

// ─── Video Stream Relay (RAW TCP — not HTTP) ───────────────
// FFmpeg writes raw mpegts bytes to a TCP socket on :9998.
// Previous HTTP-based version failed because FFmpeg's HTTP framing
// triggers Node's strict HTTP parser and the request immediately
// "ends" — causing an EPIPE loop. Raw TCP avoids HTTP entirely.
//
// On the FFmpeg side, the URL must be: tcp://127.0.0.1:9998
// (NOT http://127.0.0.1:9998 — that's the bug we're fixing).
const videoWss = new WebSocket.Server({ noServer: true });

const videoIn = net.createServer((socket) => {
  console.log(`[VIDEO] FFmpeg connected from ${socket.remoteAddress}:${socket.remotePort}`);

  socket.on('data', (chunk) => {
    videoWss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(chunk); } catch (e) { /* client gone, ignore */ }
      }
    });
  });

  socket.on('end', () => {
    console.log('[VIDEO] FFmpeg socket ended (FIN received)');
  });

  socket.on('close', (hadError) => {
    console.log(`[VIDEO] FFmpeg socket closed${hadError ? ' (with error)' : ''}`);
  });

  socket.on('error', (err) => {
    console.log(`[VIDEO] FFmpeg socket error: ${err.message}`);
  });
});

videoIn.on('error', (err) => {
  console.log(`[VIDEO] TCP listener error: ${err.message}`);
});

videoIn.listen(9998, '127.0.0.1', () => console.log('[VIDEO] FFmpeg TCP listener on :9998 (raw mpegts, no HTTP)'));

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/video') {
    videoWss.handleUpgrade(req, socket, head, ws => {
      videoWss.emit('connection', ws, req);
      console.log('[VIDEO] Browser connected');
    });
  } else if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.API_PORT || 3000;
// ═══════════════════════════════════════════════════════════════════
// Item 10 — Cross-Pole Monitor Sync Offset
// ═══════════════════════════════════════════════════════════════════
const SYNC_PING_INTERVAL_MS = 2000;
const SYNC_TIMEOUT_MS       = 5000;
const THIS_POLE  = liveState.node;
const PEER_POLE  = THIS_POLE === 'pole-1' ? 'pole-2' : 'pole-1';
const pendingPings = new Map();
let lastSyncOffsetMs = null;
let lastSyncStatus   = 'disconnected';
let lastSyncAt       = 0;
function classifySyncOffset(ms) {
  if (ms == null) return 'disconnected';
  if (ms <= 10)   return 'excellent';
  if (ms <= 50)   return 'acceptable';
  return 'out_of_sync';
}
function broadcastSync() {
  const payload = JSON.stringify({ type: 'sync', offset: lastSyncOffsetMs, status: lastSyncStatus, peer: PEER_POLE, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(payload); } catch(_) {} } });
}
mqttClient.on('message', (topic, msg) => {
  if (topic === `swips/sync/ping/${THIS_POLE}`) {
    let p; try { p = JSON.parse(msg.toString()); } catch(_) { return; }
    mqttClient.publish(`swips/sync/pong/${THIS_POLE}`, JSON.stringify({ id: p.id, ts: p.ts }));
    return;
  }
  if (topic === `swips/sync/pong/${PEER_POLE}`) {
    let p; try { p = JSON.parse(msg.toString()); } catch(_) { return; }
    const sentAt = pendingPings.get(p.id);
    if (sentAt == null) return;
    pendingPings.delete(p.id);
    lastSyncOffsetMs = Math.round((Date.now() - sentAt) / 2 * 10) / 10;
    lastSyncStatus   = classifySyncOffset(lastSyncOffsetMs);
    lastSyncAt       = Date.now();
    broadcastSync();
  }
});
setInterval(() => {
  const now = Date.now();
  for (const [pid, sentAt] of pendingPings)
    if (now - sentAt > SYNC_TIMEOUT_MS) pendingPings.delete(pid);
  if (now - lastSyncAt > SYNC_TIMEOUT_MS && lastSyncStatus !== 'disconnected') {
    lastSyncOffsetMs = null; lastSyncStatus = 'disconnected'; broadcastSync();
  }
  const id = THIS_POLE + '-' + now + '-' + Math.floor(Math.random()*1e6);
  pendingPings.set(id, now);
  mqttClient.publish('swips/sync/ping/' + THIS_POLE, JSON.stringify({ id, ts: now }));
}, SYNC_PING_INTERVAL_MS);
console.log('[SYNC] Monitor sync active: ' + THIS_POLE + ' <=> ' + PEER_POLE);

// ─── Seed violationState from InfluxDB on startup ───────────
async function seedViolationState() {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET_ALERTS || process.env.INFLUX_BUCKET}")
        |> range(start: today())
        |> filter(fn: (r) => r._measurement == "alert" and r._field == "duration")
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: 100)
    `);
    if (!rows || rows.length === 0) {
      console.log('[SEED] No alerts in InfluxDB for today');
      return;
    }
    violationState.alertHistory = [];
    violationState.today = { obstruction:0, obstructionWarning:0, totalAlerts:0, criticalAlerts:0 };
    rows.forEach(r => {
      const entry = {
        id: r._time + '-' + Math.random().toString(36).substr(2,4),
        type: r.type || 'OBSTRUCTION',
        severity: r.severity || 'critical',
        pole: r.pole || r.node || 'pole-1',
        location: r.location || 'msu-iit-crosswalk',
        timestamp: r._time,
        duration: r._value,
        status: 'resolved',
      };
      violationState.alertHistory.push(entry);
      violationState.today.totalAlerts++;
      if (r.severity === 'critical') violationState.today.criticalAlerts++;
      if (r.type === 'OBSTRUCTION') violationState.today.obstruction++;
      else if (r.type === 'OBSTRUCTION_WARNING') violationState.today.obstructionWarning++;
    });
    liveState.activeAlerts = 0;
    liveState.obstructionsToday = violationState.today.obstruction;
    console.log('[SEED] Loaded ' + violationState.alertHistory.length + ' alerts from InfluxDB');
  } catch (err) {
    console.warn('[SEED] Could not seed violation state:', err.message);
  }
}
seedViolationState();

// ─── Seed pedestriansToday from InfluxDB on startup ────────
async function seedPedestriansToday() {
  try {
    const rows = await queryInflux(`
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: today())
        |> filter(fn: (r) => r._measurement == "crossing_event" and r._field == "pedestrians")
        |> filter(fn: (r) => r.prev_state == "IDLE")
        |> sum()
    `);
    const total = rows.reduce((acc, r) => acc + (r._value || 0), 0);
    liveState.pedestriansToday = total;
    console.log('[SEED] pedestriansToday restored to ' + total + ' from InfluxDB');
  } catch (err) {
    console.warn('[SEED] Could not seed pedestriansToday:', err.message);
  }
}
seedPedestriansToday();

server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  SWiPS Edge Server — OFFLINE MODE');
  console.log(`  Dashboard: http://0.0.0.0:${PORT}`);
  console.log(`  API:       http://0.0.0.0:${PORT}/api`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log('  Connect to WiFi "SWiPS-Pole-01" to access');
  console.log('═══════════════════════════════════════════════');
});
