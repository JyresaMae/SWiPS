// ═══════════════════════════════════════════════════════════════
// SWiPS API Helper — Connects dashboard to Pi's API + WebSocket
// File: js/core/api.js
// ═══════════════════════════════════════════════════════════════

import { CONFIG } from './config.js';
import { state } from './state.js';

// ─── REST Fetch ─────────────────────────────────────────────
export async function fetchFromPi(endpoint) {
  try {
    const res = await fetch(`${CONFIG.API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[API] ${endpoint}:`, err.message);
    return null;
  }
}

// ─── WebSocket (live updates) ───────────────────────────────
let ws = null;
let reconnectTimer = null;
const listeners = new Set();

export function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(CONFIG.WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected to Pi');
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      // Update global state with live data from Pi
      updateStateFromPi(data.liveState);
      // Notify any additional listeners
      listeners.forEach(cb => cb(data));
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected — reconnecting in 3s');
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

// ─── Map Pi API fields → your state.js properties ──────────
function updateStateFromPi(live) {
  if (!live) return;

  // Map API field names → your existing state property names
  state.crossingState      = live.crosswalkState || 'IDLE';
  state.pedestriansNow     = live.detectedNow || 0;
  state.latencyMs          = live.latency || 0;
  state.activeAlerts       = live.activeAlerts || 0;
  state.safetyLevel        = live.safetyLevel || 'HIGH';
  state.pedestriansToday   = live.pedestriansToday || 0;
  state.criticalAlertsToday = live.obstructionsToday || 0;
  state.fps                = live.inferenceSpeed || 0;

  // Extended state (new fields from edge system)
  state.crosswalkCount     = live.crosswalkCount || 0;
  state.pedestrianCount    = live.pedestrianCount || 0;
  state.jaywalkerCount     = live.jaywalkerCount || 0;
  state.vehicleCount       = live.vehicleCount || 0;
  state.cpuTemp            = live.cpuTemp || 0;
  state.cpuUsage           = live.cpuUsage || 0;
  state.memoryUsage        = live.memoryUsage || 0;
  state.batteryVoltage     = live.batteryVoltage || 12.6;
  state.batteryPercent     = live.batteryPercent || 100;
  state.source             = live.source || 'none';
  state.videoName          = live.videoName || '';
  state.videoProgress      = live.videoProgress || 0;
  state.lastAlertTime      = live.lastAlertTime || null;
}

// ─── Subscribe to live data ─────────────────────────────────
export function onLiveData(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

// ─── Health Check ───────────────────────────────────────────
export async function checkPiConnection() {
  const r = await fetchFromPi(CONFIG.ENDPOINTS.health);
  return r && r.status === 'ok';
}

// ─── Data loaders for specific sections ─────────────────────
export async function loadAnalyticsData() {
  const [hourly, weekly, modes] = await Promise.all([
    fetchFromPi(CONFIG.ENDPOINTS.hourly),
    fetchFromPi(CONFIG.ENDPOINTS.weekly),
    fetchFromPi(CONFIG.ENDPOINTS.modes),
  ]);
  return { hourly, weekly, modes };
}

export async function loadAlertsData() {
  const [today, weekly] = await Promise.all([
    fetchFromPi(CONFIG.ENDPOINTS.alertsToday),
    fetchFromPi(CONFIG.ENDPOINTS.alertsWeekly),
  ]);
  return { today, weekly };
}

export async function loadSystemData() {
  return await fetchFromPi(CONFIG.ENDPOINTS.systemHistory);
}
