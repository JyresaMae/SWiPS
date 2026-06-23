import { DeploymentMap } from './js/sections/map.js';

let dashboardMapInstance = null;
let fullMapInstance = null;
let currentSection = 'dashboard';

// Helper: navigate to any section programmatically
function navigateToSection(sectionName) {
  const sidebarBtn = document.querySelector(`.sidebar-item[data-section="${sectionName}"]`);
  if (sidebarBtn) sidebarBtn.click();
}

// SWiPS Dashboard Logic - Single View Redesign

const elements = {
  // Login Elements
  loginScreen: document.getElementById('login-screen'),
  loginForm: document.getElementById('loginForm'),
  emailInput: document.getElementById('email'),
  passwordInput: document.getElementById('password'),
  togglePassword: document.getElementById('togglePassword'),
  loginBtn: document.getElementById('loginBtn'),
  loginError: document.getElementById('loginError'),
  logoutBtn: document.getElementById('logoutBtn'),
  appLayout: document.querySelector('.app-layout'),

  headerDatetime: document.getElementById('headerDatetime'),

  // Primary Metrics
  crosswalkState: document.getElementById('crosswalkState'),
  stateDot: document.getElementById('stateDot'),
  stateTimer: document.getElementById('stateTimer'),

  pedestriansNow: document.getElementById('pedestriansNow'),
  pedestrianDots: document.getElementById('pedestrianDots'),

  latencyValue: document.getElementById('latencyValue'),
  latencyBar: document.getElementById('latencyBar'),

  activeAlerts: document.getElementById('activeAlerts'),

  safetyCard: document.getElementById('safetyCard'),
  safetyLevel: document.getElementById('safetyLevel'),
  safetyDot: document.getElementById('safetyDot'),

  // Content Overlay
  overlayTimer: document.getElementById('overlayTimer'),
  cameraStatus: document.getElementById('cameraStatus'),

  // Secondary Metrics
  pedestriansToday: document.getElementById('pedestriansToday'),
  criticalAlertsToday: document.getElementById('criticalAlertsToday'),
  peakHour: document.getElementById('peakHour'),
  inferenceFps: document.getElementById('inferenceFps'),

  // Sidebar Elements
  // badgeAnalytics removed
  badgeAlerts: document.getElementById('badgeAlerts'),
  navAlerts: document.getElementById('navAlerts'),
  statusPerformance: document.getElementById('statusPerformance'),
  sidebarItems: document.querySelectorAll('.sidebar-item'),
};

const AUTH_CONFIG = {
  email: 'admin@swips.edu.ph',
  password: 'swips2025',
  sessionTimeout: 30 * 60 * 1000 // 30 minutes
};

const state = {
  isAuthenticated: false,
  lastActivity: Date.now(),
  crossingState: 'IDLE',
  crossingStart: null,
  pedestriansNow: 0,
  latencyMs: 0,
  activeAlerts: 0,
  safetyLevel: 'HIGH',

  // Daily stats
  pedestriansToday: 0,
  criticalAlertsToday: 0,
  fps: 0,

  // ═══ VIOLATION TRACKING (NEW) ═══
  vehicleInCrosswalk: false,
  violationsToday: {
    jaywalking: 0,
    massJaywalking: 0,
    obstruction: 0,
    vehicleInCrosswalk: 0,
    obstructionWarning: 0,
    totalAlerts: 0,
    criticalAlerts: 0,
  },
  // Per-pole violation storage to prevent badge flicker
  violationsByPole: {
    'pole-1': { totalAlerts: 0, criticalAlerts: 0 },
    'pole-2': { totalAlerts: 0, criticalAlerts: 0 },
  },
  alertHistory: [],

  // WebSocket status
  wsLocalConnected: false,
  wsRemoteConnected: false,

  // Pole filter: 'both', 'pole-1', or 'pole-2'
  poleFilter: 'pole-1',
};

// ═══════════════════════════════════════════════════════════════
// DUAL-POLE NETWORK CONFIG
// ═══════════════════════════════════════════════════════════════

const POLE_IPS = {
  pole1: '10.42.0.1',
  pole2: '10.42.0.2',
};

const POLE_MSCA = {
  pole1: '10.10.79.159',
  pole2: '10.10.79.136',
};

const poleLiveState = {
  local: null,
  remote: null,
};

const poleNodeMap = {
  local: null,
  remote: null,
};

// --- Helpers ---
function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
}

function updateClock() {
  const now = new Date();
  if (elements.headerDatetime) {
    elements.headerDatetime.textContent = now.toLocaleString('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// DUAL WebSocket Connection
// ═══════════════════════════════════════════════════════════════

let wsLocal = null;
let wsRemote = null;
let wsLocalReconnect = null;
let wsRemoteReconnect = null;

function getRemoteUrls() {
  const host = window.location.hostname;
  const onHotspot = host.startsWith('10.42.0.');
  if (host === POLE_IPS.pole2 || host === POLE_MSCA.pole2) {
    return onHotspot
      ? [`ws://${POLE_IPS.pole1}:3000/ws`]
      : [`ws://${POLE_MSCA.pole1}:3000/ws`];
  } else if (host === POLE_IPS.pole1 || host === POLE_MSCA.pole1) {
    return onHotspot
      ? [`ws://${POLE_IPS.pole2}:3000/ws`]
      : [`ws://${POLE_MSCA.pole2}:3000/ws`];
  }
  return onHotspot
    ? [`ws://${POLE_IPS.pole1}:3000/ws`, `ws://${POLE_IPS.pole2}:3000/ws`]
    : [`ws://${POLE_MSCA.pole1}:3000/ws`, `ws://${POLE_MSCA.pole2}:3000/ws`];
}
function connectLocalWS() {
  if (wsLocal && wsLocal.readyState === WebSocket.OPEN) return;

  const wsUrl = `ws://${window.location.host}/ws`;
  console.log('[WS-Local] Connecting to', wsUrl);
  wsLocal = new WebSocket(wsUrl);

  wsLocal.onopen = () => {
    console.log('[WS-Local] Connected');
    state.wsLocalConnected = true;
    clearTimeout(wsLocalReconnect);
  };

  wsLocal.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWSMessage(msg, 'local');
    } catch (e) {
      console.error('[WS-Local] Parse error:', e);
    }
  };

  wsLocal.onclose = () => {
    console.log('[WS-Local] Disconnected, reconnecting in 3s...');
    state.wsLocalConnected = false;
    wsLocalReconnect = setTimeout(connectLocalWS, 3000);
  };

  wsLocal.onerror = () => wsLocal.close();
}

let remoteUrlIndex = 0;
let remoteUrls = [];

function connectRemoteWS() {
  if (wsRemote && wsRemote.readyState === WebSocket.OPEN) return;
  if (remoteUrls.length === 0) {
    remoteUrls = getRemoteUrls();
    remoteUrlIndex = 0;
  }
  if (remoteUrls.length === 0) {
    console.log('[WS-Remote] No remote URLs to try');
    return;
  }

  const wsUrl = remoteUrls[remoteUrlIndex];
  console.log('[WS-Remote] Trying', wsUrl);
  wsRemote = new WebSocket(wsUrl);

  const connectTimeout = setTimeout(() => {
    if (wsRemote && wsRemote.readyState !== WebSocket.OPEN) {
      console.log('[WS-Remote] Timeout on', wsUrl);
      wsRemote.close();
    }
  }, 5000);

  wsRemote.onopen = () => {
    console.log('[WS-Remote] Connected to', wsUrl);
    state.wsRemoteConnected = true;
    clearTimeout(connectTimeout);
    clearTimeout(wsRemoteReconnect);
  };

  wsRemote.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWSMessage(msg, 'remote');
    } catch (e) {
      console.error('[WS-Remote] Parse error:', e);
    }
  };

  wsRemote.onclose = () => {
    clearTimeout(connectTimeout);
    state.wsRemoteConnected = false;
    remoteUrlIndex++;
    if (remoteUrlIndex >= remoteUrls.length) {
      remoteUrlIndex = 0;
      console.log('[WS-Remote] All URLs exhausted, retrying in 10s...');
      wsRemoteReconnect = setTimeout(connectRemoteWS, 10000);
    } else {
      console.log('[WS-Remote] Trying next URL...');
      wsRemoteReconnect = setTimeout(connectRemoteWS, 2000);
    }
  };

  wsRemote.onerror = () => wsRemote.close();
}

// --- Handle incoming WS messages from either pole ---
function handleWSMessage(msg, source) {
  const { topic, data, liveState: ls } = msg;

  // Store per-pole liveState
  if (ls) poleLiveState[source] = ls;

  // Track which physical pole this source corresponds to
  const nodeId = (ls && ls.node) || (data && data.node) || null;
  if (nodeId) poleNodeMap[source] = nodeId;

  // Re-merge state based on current filter
  recomputeState();

  const pole = nodeId || poleNodeMap[source] || 'unknown';

  // ═══ VIOLATION DATA PROCESSING (NEW) ═══
  if (msg.violations) {
    const pole = nodeId || poleNodeMap[source] || null;
    if (pole && state.violationsByPole[pole]) {
      state.violationsByPole[pole] = { ...msg.violations };
    }
    // Recompute merged violationsToday based on current filter
    recomputeViolations();
  }
  if (msg.alertHistory && Array.isArray(msg.alertHistory)) {
    msg.alertHistory.forEach(a => {
      if (!state.alertHistory.find(h => h.id === a.id)) {
        state.alertHistory.unshift(a);
      }
    });
    if (state.alertHistory.length > 100) {
      state.alertHistory = state.alertHistory.slice(0, 100);
    }
  }

  // Fire CustomEvents for lazy-loaded sections
  if (topic === 'swips/detection') {
    // Read vehicle-in-crosswalk flag
    if (data && data.vehicleInCrosswalk !== undefined) {
      state.vehicleInCrosswalk = data.vehicleInCrosswalk;
    }
    window.dispatchEvent(new CustomEvent('swips:detection', { detail: { data, liveState: ls, source, pole } }));
  }
  if (topic === 'swips/system') {
    window.dispatchEvent(new CustomEvent('swips:system', { detail: { data, liveState: ls, source, pole } }));
  }
  if (topic === 'swips/alert') {
    // Build alert entry for history
    if (data) {
      const alertEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        ...data,
        receivedAt: new Date().toISOString(),
        status: data.status || 'active',
      };
      state.alertHistory.unshift(alertEntry);
      if (state.alertHistory.length > 100) {
        state.alertHistory = state.alertHistory.slice(0, 100);
      }
    }
    window.dispatchEvent(new CustomEvent('swips:alert', {
      detail: { data, liveState: ls, source, pole, violations: state.violationsToday }
    }));
  }
}

// --- Recompute violationsToday based on pole filter ---
function recomputeViolations() {
  const filter = state.poleFilter;
  const poles = filter === 'both'
    ? ['pole-1', 'pole-2']
    : [filter];

  const merged = {
    jaywalking: 0, massJaywalking: 0, obstruction: 0,
    vehicleInCrosswalk: 0, obstructionWarning: 0,
    totalAlerts: 0, criticalAlerts: 0,
  };

  poles.forEach(p => {
    const v = state.violationsByPole[p];
    if (!v) return;
    Object.keys(merged).forEach(k => {
      merged[k] += (v[k] || 0);
    });
  });

  state.violationsToday = merged;
}

// --- Re-merge poleLiveState into state based on poleFilter ---
function recomputeState() {
  const filter = state.poleFilter;

  let sources = [];
  if (filter === 'both') {
    if (poleLiveState.local) sources.push(poleLiveState.local);
    if (poleLiveState.remote) sources.push(poleLiveState.remote);
  } else {
    ['local', 'remote'].forEach(src => {
      if (poleLiveState[src] && poleNodeMap[src] === filter) {
        sources.push(poleLiveState[src]);
      }
    });
  }

  if (sources.length === 0) {
    state.crossingState      = 'IDLE';
    state.latencyMs          = 0;
    state.fps                = 0;
    state.pedestriansNow     = 0;
    state.activeAlerts       = 0;
    state.pedestriansToday   = 0;
    state.criticalAlertsToday = 0;
    state.safetyLevel        = 'HIGH';
    state.crossingStart      = null;
    state.vehicleInCrosswalk = false;
    return;
  }

  const primary = sources[0];
  state.crossingState      = primary.crosswalkState || 'IDLE';
  state.latencyMs          = Math.round(primary.latency || 0);
  state.fps                = primary.inferenceSpeed || 0;

  // state.pedestriansNow removed from UI (Detected Now card removed)
  state.activeAlerts        = primary.activeAlerts || 0;
  state.pedestriansToday    = sources.reduce((s, p) => s + (p.pedestriansToday || 0), 0);
  state.criticalAlertsToday = state.violationsToday.criticalAlerts ||
    sources.reduce((s, p) => s + (p.obstructionsToday || 0), 0);

  // Vehicle in crosswalk from any source
  state.vehicleInCrosswalk = sources.some(p => p.vehicleInCrosswalk);

  const levels = ['HIGH', 'MODERATE', 'LOW'];
  state.safetyLevel = sources.reduce((worst, p) => {
    const lvl = p.safetyLevel || 'HIGH';
    return levels[Math.max(levels.indexOf(worst), levels.indexOf(lvl))];
  }, 'HIGH');

  // Crossing timer — handle all crossing states
  const isCrossing = primary.crosswalkState && primary.crosswalkState !== 'IDLE';
  if (isCrossing && !state.crossingStart) {
    state.crossingStart = new Date();
  } else if (!isCrossing) {
    state.crossingStart = null;
  }

  // Keep violations in sync with current pole filter
  recomputeViolations();
}

// ═══════════════════════════════════════════════════════════════
// Fetch historical data from API — BOTH poles
// ═══════════════════════════════════════════════════════════════

function getRemoteApiBase() {
  const host = window.location.hostname;
  const onHotspot = host.startsWith('10.42.0.');
  // Pick the right remote address based on current network — no cross-network attempts
  if (host === POLE_IPS.pole2 || host === POLE_MSCA.pole2) {
    return onHotspot
      ? [`http://${POLE_IPS.pole1}:3000`]
      : [`http://${POLE_MSCA.pole1}:3000`];
  } else if (host === POLE_IPS.pole1 || host === POLE_MSCA.pole1) {
    return onHotspot
      ? [`http://${POLE_IPS.pole2}:3000`]
      : [`http://${POLE_MSCA.pole2}:3000`];
  }
  return onHotspot
    ? [`http://${POLE_IPS.pole1}:3000`, `http://${POLE_IPS.pole2}:3000`]
    : [`http://${POLE_MSCA.pole1}:3000`, `http://${POLE_MSCA.pole2}:3000`];
}

async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? res.json() : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchRemoteApi(path) {
  const bases = getRemoteApiBase();
  for (const base of bases) {
    const result = await fetchWithTimeout(`${base}${path}`, 1500);
    if (result) return result;
  }
  return null;
}

async function fetchDashboardStats() {
  const base = window.location.origin;
  const filter = state.poleFilter;
  try {
    const liveRes = await fetchWithTimeout(`${base}/api/live`);
    if (liveRes) {
      poleLiveState.local = liveRes;
      if (liveRes.node) poleNodeMap.local = liveRes.node;
    }

    const remoteLive = await fetchRemoteApi('/api/live');
    if (remoteLive) {
      poleLiveState.remote = remoteLive;
      if (remoteLive.node) poleNodeMap.remote = remoteLive.node;
      window.dispatchEvent(new CustomEvent('swips:remote-online', { detail: { node: remoteLive.node || 'pole-2', reachable: true } }));
    } else {
      window.dispatchEvent(new CustomEvent('swips:remote-online', { detail: { node: 'pole-2', reachable: false } }));
    }

    recomputeState();

    // ═══ FETCH VIOLATION DATA — PER-POLE ═══
    const localPole = poleNodeMap.local || null;
    const remotePole = poleNodeMap.remote || null;

    const violationsRes = await fetchWithTimeout(`${base}/api/violations`);
    if (violationsRes && violationsRes.today) {
      if (localPole && state.violationsByPole[localPole]) {
        state.violationsByPole[localPole] = { ...violationsRes.today };
      }
    }

    const remoteViolations = await fetchRemoteApi('/api/violations');
    if (remoteViolations && remoteViolations.today) {
      if (remotePole && state.violationsByPole[remotePole]) {
        state.violationsByPole[remotePole] = { ...remoteViolations.today };
      }
    }

    recomputeViolations();

    // Fetch alert history
    const alertsLiveRes = await fetchWithTimeout(`${base}/api/alerts/live?limit=50`);
    if (alertsLiveRes && alertsLiveRes.alerts) {
      state.alertHistory = alertsLiveRes.alerts;
    }

    const includeLocal = filter === 'both' || filter === localPole;
    const includeRemote = filter === 'both' || filter === remotePole;

    if (includeLocal) {
      const hourlyRes = await fetchWithTimeout(`${base}/api/analytics/hourly`);
      if (hourlyRes && Array.isArray(hourlyRes) && hourlyRes.length > 0) {
        let peakHour = 0, peakCount = 0;
        hourlyRes.forEach(row => {
          const count = row._value || 0;
          const hour = new Date(row._time).getHours();
          if (count > peakCount) { peakCount = count; peakHour = hour; }
        });
        if (elements.peakHour && peakCount > 0) {
          const fmt = (h) => `${h > 12 ? h - 12 : h === 0 ? 12 : h}:00`;
          elements.peakHour.textContent = `${fmt(peakHour)}-${fmt((peakHour + 1) % 24)}`;
        }
      }
    }

    if (includeLocal) {
      const weeklyRes = await fetchWithTimeout(`${base}/api/analytics/weekly`);
      if (weeklyRes && Array.isArray(weeklyRes) && weeklyRes.length >= 2) {
        const days = weeklyRes.map(r => r._value || 0);
        const trendEl = document.querySelector('.trend-value');
        const arrowEl = document.querySelector('.trend-arrow');
        if (trendEl && days.length >= 7) {
          const recent = days.slice(-3).reduce((s, v) => s + v, 0);
          const earlier = days.slice(0, 3).reduce((s, v) => s + v, 0);
          const pct = earlier > 0 ? Math.round(((recent - earlier) / earlier) * 100) : 0;
          trendEl.textContent = `${pct > 0 ? '+' : ''}${pct}%`;
          if (arrowEl) arrowEl.textContent = pct > 0 ? '↗' : pct < 0 ? '↘' : '→';
        }
      }
    }

    if (includeLocal) {
      const alertsRes = await fetchWithTimeout(`${base}/api/alerts/today`);
      if (alertsRes) window.dispatchEvent(new CustomEvent('swips:alerts-data', { detail: { rows: alertsRes, pole: localPole || 'unknown' } }));

      const alertsWeeklyRes = await fetchWithTimeout(`${base}/api/alerts/weekly`);
      if (alertsWeeklyRes) window.dispatchEvent(new CustomEvent('swips:alerts-weekly', { detail: { rows: alertsWeeklyRes, pole: localPole || 'unknown' } }));
    }

    const sysRes = await fetchWithTimeout(`${base}/api/system/history`);
    if (sysRes) { window._cachedSysHistory = sysRes; window.dispatchEvent(new CustomEvent('swips:system-history', { detail: sysRes })); }

    const remoteSys = await fetchRemoteApi('/api/system/history');
    if (remoteSys) { window._cachedRemoteSysHistory = remoteSys; window.dispatchEvent(new CustomEvent('swips:system-history', { detail: remoteSys })); }

    // Pole 2 is a mirror display (no camera/detection) — skip remote alerts fetch
    // if (includeRemote) {
    //   const remoteAlerts = await fetchRemoteApi('/api/alerts/today');
    //   if (remoteAlerts) window.dispatchEvent(new CustomEvent('swips:alerts-data', { detail: { rows: remoteAlerts, pole: remotePole || 'unknown' } }));
    // }

    if (includeLocal) {
      const hourlyForAnalytics = await fetchWithTimeout(`${base}/api/analytics/hourly`);
      if (hourlyForAnalytics) window.dispatchEvent(new CustomEvent('swips:analytics-hourly', { detail: { rows: hourlyForAnalytics, pole: localPole || 'unknown' } }));

      const weeklyForAnalytics = await fetchWithTimeout(`${base}/api/analytics/weekly`);
      if (weeklyForAnalytics) window.dispatchEvent(new CustomEvent('swips:analytics-weekly', { detail: { rows: weeklyForAnalytics, pole: localPole || 'unknown' } }));

      // Heatmap is aggregate across all nodes (backend handles both poles),
      // so we only fetch it once from the local API — no remote counterpart needed.
      const heatmapForAnalytics = await fetchWithTimeout(`${base}/api/analytics/heatmap?days=14`);
      if (heatmapForAnalytics) window.dispatchEvent(new CustomEvent('swips:analytics-heatmap', { detail: heatmapForAnalytics }));
    }
    // Pole 2 is a mirror display (no camera/detection) — skip remote analytics fetches
    // if (includeRemote) {
    //   const remoteHourly = await fetchRemoteApi('/api/analytics/hourly');
    //   if (remoteHourly) window.dispatchEvent(new CustomEvent('swips:analytics-hourly', { detail: { rows: remoteHourly, pole: remotePole || 'unknown' } }));
    //
    //   const remoteWeekly = await fetchRemoteApi('/api/analytics/weekly');
    //   if (remoteWeekly) window.dispatchEvent(new CustomEvent('swips:analytics-weekly', { detail: { rows: remoteWeekly, pole: remotePole || 'unknown' } }));
    // }

  } catch (err) {
    console.error('[API] Fetch error:', err);
  }
}

// --- UI Updates ---

function updateUI() {
  // ═══ State — with vehicle alert and obstruction override (UPDATED) ═══
  if (state.vehicleInCrosswalk) {
    elements.crosswalkState.textContent = 'VEHICLE ALERT';
    elements.crosswalkState.style.color = '#f87171';
    elements.stateDot.className = 'state-dot active-red';
  } else if (state.crossingState === 'OBSTRUCTION') {
    elements.crosswalkState.textContent = 'OBSTRUCTION';
    elements.crosswalkState.style.color = '#f87171';
    elements.stateDot.className = 'state-dot active-red';
  } else {
    elements.crosswalkState.textContent = state.crossingState;
    elements.crosswalkState.style.color = '';
    elements.stateDot.className = 'state-dot';
    if (state.crossingState === 'IDLE') {
      elements.stateDot.classList.add('active-green');
    } else if (state.crossingState === 'CROSSING' ||
               state.crossingState === 'CROSSING_1_4' ||
               state.crossingState === 'CROSSING_5_PLUS') {
      elements.stateDot.classList.add('active-red');
    }
  }

  // Crossing timer
  if (state.crossingState === 'IDLE') {
    elements.stateTimer.textContent = '00:00';
  } else if (state.crossingStart) {
    const diff = Math.floor((new Date() - state.crossingStart) / 1000);
    const mm = Math.floor(diff / 60).toString().padStart(2, '0');
    const ss = (diff % 60).toString().padStart(2, '0');
    elements.stateTimer.textContent = `${mm}:${ss}`;
    if (elements.overlayTimer) elements.overlayTimer.textContent = `${mm}:${ss}`;
  }

  // Pedestrians
  if (elements.pedestriansNow) elements.pedestriansNow.textContent = state.pedestriansNow;
  if (elements.pedestrianDots) updatePedestrianDots(state.pedestriansNow);

  // Latency
  elements.latencyValue.textContent = state.latencyMs;
  const latencyPct = Math.min(100, Math.max(5, (state.latencyMs / 200) * 100));
  elements.latencyBar.style.width = `${latencyPct}%`;
  if (state.latencyMs < 100) elements.latencyBar.style.backgroundColor = 'var(--accent-green)';
  else elements.latencyBar.style.backgroundColor = 'var(--accent-amber)';

  // ═══ Alerts — use violation total (UPDATED) ═══
  const totalAlerts = state.activeAlerts;
  elements.activeAlerts.textContent = totalAlerts;

  // ═══ Safety Badge — with critical pulse (UPDATED) ═══
  elements.safetyLevel.textContent = state.safetyLevel;
  if (state.safetyLevel === 'HIGH') {
    elements.safetyCard.style.backgroundColor = 'rgba(34, 197, 94, 0.05)';
    elements.safetyCard.style.borderColor = 'rgba(34, 197, 94, 0.2)';
    elements.safetyDot.style.backgroundColor = 'var(--accent-green)';
    elements.safetyLevel.style.color = '#4ade80';
    elements.safetyCard.classList.remove('critical-pulse');
  } else if (state.safetyLevel === 'MODERATE') {
    elements.safetyCard.style.backgroundColor = 'rgba(245, 158, 11, 0.05)';
    elements.safetyCard.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    elements.safetyDot.style.backgroundColor = 'var(--accent-amber)';
    elements.safetyLevel.style.color = '#fcd34d';
    elements.safetyCard.classList.remove('critical-pulse');
  } else {
    elements.safetyCard.style.backgroundColor = 'rgba(239, 68, 68, 0.05)';
    elements.safetyCard.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    elements.safetyDot.style.backgroundColor = 'var(--accent-red)';
    elements.safetyLevel.style.color = '#f87171';
    elements.safetyCard.classList.add('critical-pulse');
  }

  // Secondary
  elements.pedestriansToday.textContent = state.pedestriansToday;
  elements.criticalAlertsToday.textContent =
    state.violationsToday.criticalAlerts || state.criticalAlertsToday;
  elements.inferenceFps.textContent = state.fps.toFixed(1);

  if (elements.badgeAlerts && elements.navAlerts) {
    elements.badgeAlerts.textContent = totalAlerts;
    if (totalAlerts > 0) {
      elements.badgeAlerts.style.display = 'inline-block';
      elements.navAlerts.classList.add('has-alerts');
    } else {
      elements.badgeAlerts.style.display = 'none';
      elements.navAlerts.classList.remove('has-alerts');
    }
  }

  if (elements.statusPerformance) {
    const isGood = (state.wsLocalConnected || state.wsRemoteConnected) && state.fps > 0 && state.latencyMs < 250;
    if (isGood) elements.statusPerformance.classList.add('good');
    else elements.statusPerformance.classList.remove('good');
  }
}

function updatePedestrianDots(count) {
  if (!elements.pedestrianDots) return;
  const dots = elements.pedestrianDots.querySelectorAll('.pedestrian-dot');
  dots.forEach((dot, index) => {
    if (index < count) {
      dot.classList.add('active');
    } else {
      dot.classList.remove('active');
    }
  });
}

function initPedestrianDots() {
  if (!elements.pedestrianDots) return;
  elements.pedestrianDots.innerHTML = '';
  const maxDots = 5;
  for (let i = 0; i < maxDots; i++) {
    const dot = document.createElement('div');
    dot.className = 'pedestrian-dot';
    elements.pedestrianDots.appendChild(dot);
  }
}
// Camera: JSMpeg player for live stream (single Pole 1 feed)
let currentPlayer = null;
function initCamera() {
  const canvas = document.getElementById('videoCanvas');
  if (!canvas || typeof JSMpeg === 'undefined') return;
  try {
    currentPlayer = new JSMpeg.Player('ws://' + window.location.host + '/video', {
      canvas: canvas,
      autoplay: true,
      audio: false,
      loop: false,
      decodeFirstFrame: true,
      maxAudioLag: 0,
      videoBufferSize: 512*1024,
    });
  } catch (e) {
    console.log('[Camera] init failed', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════

function init() {
  updateClock();
  setInterval(updateClock, 1000);

  connectLocalWS();
  connectRemoteWS();

  fetchDashboardStats();
  setInterval(fetchDashboardStats, 30000);

  setInterval(updateUI, 100);

  initCamera();
  initPedestrianDots();

  const expandCamBtn = document.getElementById('expandCamBtn');
  if (expandCamBtn) {
    expandCamBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToSection('livecam');
    });
  }

  updateUI();

  if (window.lucide) {
    window.lucide.createIcons();
  }

  // ── Pole Toggle ──
  const allPoleToggles = [
    document.getElementById('poleToggle'),
    document.getElementById('poleToggleAlerts'),
    document.getElementById('poleToggleAnalytics'),
    document.getElementById('poleTogglePerformance'),
  ].filter(Boolean);

  function syncPoleToggles(activePole) {
    allPoleToggles.forEach(toggle => {
      toggle.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', b.dataset.pole === activePole);
      });
    });
  }

  allPoleToggles.forEach(toggle => {
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const pole = btn.dataset.pole;
        state.poleFilter = pole;
        syncPoleToggles(pole);
        recomputeState();
        updateUI();


        window.dispatchEvent(new CustomEvent('swips:pole-filter-changed', {
          detail: { filter: state.poleFilter }
        }));
        fetchDashboardStats();
      });
    });
  });

  // Sidebar Navigation
  elements.sidebarItems.forEach(item => {
    item.addEventListener('click', () => {
      elements.sidebarItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const sectionName = item.dataset.section;
      const targetViewId = `view-${sectionName}`;
      const targetView = document.getElementById(targetViewId);

      if (targetView) {
        if (currentSection === 'livecam' && sectionName !== 'livecam') {
          import('./js/sections/livecam.js')
            .then(module => module.destroyLiveCam())
            .catch(() => {});
        }
        currentSection = sectionName;

        document.querySelectorAll('.view-section').forEach(view => {
          view.classList.remove('active');
        });
        targetView.classList.add('active');

        if (sectionName === 'dashboard') {
          setTimeout(() => {
            if (dashboardMapInstance) dashboardMapInstance.centerImage();
          }, 80);
        } else if (sectionName === 'analytics') {
          setTimeout(() => {
            import('./js/sections/analytics.js')
              .then(module => { module.initAnalytics(); })
              .catch(err => console.error('Failed to load Analytics section:', err));
          }, 50);
        } else if (sectionName === 'alerts') {
          setTimeout(() => {
            import('./js/sections/alerts.js')
              .then(module => { fetchDashboardStats().then(() => module.initAlerts()); })
              .catch(err => console.error('Failed to load Alerts section:', err));
          }, 50);
        } else if (sectionName === 'about') {
          setTimeout(() => {
            import('./js/sections/about.js')
              .then(module => module.initAbout())
              .catch(err => console.error('Failed to load About section:', err));
          }, 50);
        } else if (sectionName === 'map') {
          setTimeout(() => {
            if (!fullMapInstance) {
              fullMapInstance = new DeploymentMap('deployMapWrapper'); window.mapSection = fullMapInstance;
            } else {
              fullMapInstance.centerImage();
            }
          }, 100);
        } else if (sectionName === 'performance') {
          setTimeout(() => {
            import('./js/sections/performance.js')
              .then(module => {
                module.initPerformance();
                if (window._cachedSysHistory) window.dispatchEvent(new CustomEvent('swips:system-history', { detail: window._cachedSysHistory }));
                if (window._cachedRemoteSysHistory) window.dispatchEvent(new CustomEvent('swips:system-history', { detail: window._cachedRemoteSysHistory }));
              })
              .catch(err => console.error('Failed to load Performance section:', err));
          }, 100);
        } else if (sectionName === 'compliance') {
          setTimeout(() => {
            import('./js/sections/compliance.js')
              .then(module => module.initCompliance())
              .catch(err => console.error('Failed to load Compliance section:', err));
          }, 50);
        } else if (sectionName === 'settings') {
          setTimeout(() => {
            import('./js/sections/settings.js')
              .then(module => module.initSettings())
              .catch(err => console.error('Failed to load Settings section:', err));
          }, 50);
        } else if (sectionName === 'livecam') {
          setTimeout(() => {
            import('./js/sections/livecam.js')
              .then(module => module.initLiveCam())
              .catch(err => console.error('Failed to load LiveCam section:', err));
          }, 100);
        }
      }
    });
  });
}

// --- Authentication ---

function initAuth() {
  const session = sessionStorage.getItem('swips_session');
  if (session) {
    const { timestamp } = JSON.parse(session);
    if (Date.now() - timestamp < AUTH_CONFIG.sessionTimeout) {
      loginSuccess(true);
    } else {
      logout();
    }
  }

  if (elements.loginForm) {
    elements.loginForm.addEventListener('submit', handleLogin);
  }

  if (elements.togglePassword) {
    elements.togglePassword.addEventListener('click', () => {
      const type = elements.passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
      elements.passwordInput.setAttribute('type', type);
    });
  }

  if (elements.logoutBtn) {
    elements.logoutBtn.addEventListener('click', logout);
  }

  document.addEventListener('mousemove', resetActivityTimer);
  document.addEventListener('keydown', resetActivityTimer);
  setInterval(checkSessionTimeout, 60000);
}

function handleLogin(e) {
  e.preventDefault();

  const email = elements.emailInput.value;
  const password = elements.passwordInput.value;

  elements.loginBtn.classList.add('loading');
  elements.loginBtn.disabled = true;
  elements.loginError.style.display = 'none';

  setTimeout(() => {
    if (email === AUTH_CONFIG.email && password === AUTH_CONFIG.password) {
      loginSuccess(false);
    } else {
      showLoginError();
    }
    elements.loginBtn.classList.remove('loading');
    elements.loginBtn.disabled = false;
  }, 800);
}

function showLoginError() {
  elements.loginError.style.display = 'flex';
  elements.passwordInput.value = '';
  elements.passwordInput.focus();
}

function loginSuccess(skipAnimation) {
  state.isAuthenticated = true;
  state.lastActivity = Date.now();
  sessionStorage.setItem('swips_session', JSON.stringify({ timestamp: Date.now() }));

  if (skipAnimation) {
    elements.loginScreen.style.display = 'none';
    elements.appLayout.style.display = 'flex';
    elements.appLayout.style.opacity = '1';
    elements.appLayout.classList.add('animate-entry');

    setTimeout(() => {
      if (!dashboardMapInstance) {
        dashboardMapInstance = new DeploymentMap('dashboardMapWrapper'); window.mapSection = dashboardMapInstance;
      } else {
        dashboardMapInstance.centerImage();
      }
    }, 150);

  } else {
    elements.loginScreen.classList.add('hidden');

    setTimeout(() => {
      elements.loginScreen.style.display = 'none';
      elements.appLayout.style.display = 'flex';
      elements.appLayout.style.opacity = '1';

      requestAnimationFrame(() => {
        elements.appLayout.classList.add('animate-entry');

        setTimeout(() => {
          triggerFinalPolish();
        }, 500);
      });

      setTimeout(() => {
        if (!dashboardMapInstance) {
          dashboardMapInstance = new DeploymentMap('dashboardMapWrapper'); window.mapSection = dashboardMapInstance;
        } else {
          dashboardMapInstance.centerImage();
        }
      }, 350);

    }, 200);
  }
}

function triggerFinalPolish() {
  const liveIndicator = document.getElementById('liveIndicator');
  if (liveIndicator) liveIndicator.classList.add('pulse-active');

  animateValue(elements.pedestriansNow, 0, state.pedestriansNow, 2000);
  animateValue(elements.latencyValue, 0, state.latencyMs, 2000);
  animateValue(elements.activeAlerts, 0, state.activeAlerts, 2000);
}

function animateValue(obj, start, end, duration) {
  if (!obj) return;
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    obj.innerHTML = Math.floor(progress * (end - start) + start);
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      obj.innerHTML = end;
    }
  };
  window.requestAnimationFrame(step);
}

function logout() {
  state.isAuthenticated = false;
  sessionStorage.removeItem('swips_session');

  elements.appLayout.classList.remove('animate-entry');
  const liveIndicator = document.getElementById('liveIndicator');
  if (liveIndicator) liveIndicator.classList.remove('pulse-active');

  elements.appLayout.style.opacity = '0';

  setTimeout(() => {
    elements.appLayout.style.display = 'none';

    elements.loginScreen.style.display = 'flex';
    requestAnimationFrame(() => {
      elements.loginScreen.classList.remove('hidden');
    });

    elements.emailInput.value = '';
    elements.passwordInput.value = '';
    elements.loginError.style.display = 'none';
  }, 500);
}

function resetActivityTimer() {
  state.lastActivity = Date.now();
  if (state.isAuthenticated) {
    sessionStorage.setItem('swips_session', JSON.stringify({ timestamp: Date.now() }));
  }
}

function checkSessionTimeout() {
  if (state.isAuthenticated) {
    if (Date.now() - state.lastActivity > AUTH_CONFIG.sessionTimeout) {
      logout();
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('DOMContentLoaded', initAuth);
} else {
  init();
  initAuth();
}

// ─── CSV Export Button (analytics section) ──────────────────
function wireCsvExportButton() {
  const btn = document.getElementById('btn-export-csv');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>Preparing…</span>';
    try {
      const url = `${window.location.origin}/api/analytics/export.csv?days=30`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error('[CSV export]', err);
      alert('Export failed — check console');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = originalHTML;
        if (window.lucide) window.lucide.createIcons();
      }, 800);
    }
  });
}

// ─── CSV Export Button (alerts section) ─────────────────────
function wireAlertsCsvExportButton() {
  const btn = document.getElementById('btn-export-alerts-csv');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>Preparing…</span>';
    try {
      const url = `${window.location.origin}/api/alerts/export.csv?days=30`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error('[Alerts CSV export]', err);
      alert('Export failed — check console');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = originalHTML;
        if (window.lucide) window.lucide.createIcons();
      }, 800);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCsvExportButton);
  document.addEventListener('DOMContentLoaded', wireAlertsCsvExportButton);
} else {
  wireCsvExportButton();
  wireAlertsCsvExportButton();
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE CAMERA — MJPEG via port 9997 (smart camera-host)
// Camera physically lives on Pole 1. This logic ensures any dashboard
// (Pole 1 OR Pole 2) always pulls the stream from Pole 1's IP, in either
// hotspot mode (10.42.0.1) or MSCA mode (10.10.79.159).
// Updated 2026-05-05.
// ───────────────────────────────────────────────────────────────────────────
(function initLiveCameraMJPEG() {
  // Resolve the IP of Pole 1 (the camera owner) given current network
  function resolveCameraHost() {
    var host = window.location.hostname;
    // Hotspot mode — Pi network 10.42.0.x
    if (host.indexOf('10.42.0.') === 0) return '10.42.0.1';
    // MSCA mode — Pi addresses 10.10.79.159 / 136
    if (host === '10.10.79.136' || host === '10.10.79.159') return '10.10.79.159';
    // Fallback — assume current host has the camera (e.g. localhost dev)
    return host;
  }

  function setStream() {
    var img = document.getElementById('livecamImgPole1');
    var ipEl = document.getElementById('livecam-active-ip');
    if (!img) return;
    var camHost = resolveCameraHost();
    img.src = 'http://' + camHost + ':9997/video';
    img.onerror = function () {
      setTimeout(function () {
        img.src = 'http://' + camHost + ':9997/video?t=' + Date.now();
      }, 2000);
    };
    if (ipEl) ipEl.textContent = camHost;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setStream);
  } else {
    setStream();
  }

  // Re-run when user clicks the Live Camera sidebar item
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.sidebar-item[data-section="livecam"]');
    if (btn) setTimeout(setStream, 50);
  });
})();

