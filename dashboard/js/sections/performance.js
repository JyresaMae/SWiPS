/**
 * SWiPS – System Performance Section (LIVE DATA VERSION)
 *
 * Works with script.js as the entry point (not main.js).
 * No imports from core/state.js — gets all data via CustomEvents.
 * 
 * Data sources:
 *   'swips:system' event    → CPU, memory, battery (per-pole)
 *   'swips:detection' event → latency, FPS
 *   'swips:system-history'  → backfill charts from /api/system/history
 */

let perfInitialized = false;
let eventsbound = false;
let cpuMemChart = null;
let latencyChart = null;
let batteryChart = null;
let syncGaugeChart = null;

const MINUTES = 60;
const TIME_LABELS = Array.from({ length: MINUTES }, (_, i) => {
    const m = MINUTES - 1 - i;
    return m === 0 ? 'Now' : `-${m}m`;
});

const cpuPole1 = Array(MINUTES).fill(0);
const cpuPole2 = Array(MINUTES).fill(0);
const memPole1 = Array(MINUTES).fill(0);
const memPole2 = Array(MINUTES).fill(0);
const latencyData = Array(MINUTES).fill(0);
const battPole1 = Array(MINUTES).fill(0);
const battPole2 = Array(MINUTES).fill(0);

let currentCpuTemp = 0;
let currentBatteryPct = 0;
let currentBatteryV = 12.6;
let currentFps = 0;
let currentSyncOffset = 0;
let isReceivingData = false;

// Per-pole latest data for node cards
let latestPole1 = { cpuUsage: 0, memoryUsage: 0, batteryVoltage: 12.6, network: false, cpuTemp: 0, batteryPercent: 0 };
let latestPole2 = { cpuUsage: 0, memoryUsage: 0, batteryVoltage: 12.6, network: false, cpuTemp: 0, batteryPercent: 0 };

// Per-pole FPS tracking
let fpsPole1 = 0;
let fpsPole2 = 0;

// Current pole filter state
let currentPoleFilter = 'both';

// ─── Event Listeners ─────────────────────────────────────────────────────────

function bindLiveEvents() {
    if (eventsbound) return;
    eventsbound = true;

    // Listen for pole filter changes from the global toggle sync
    window.addEventListener('swips:pole-filter-changed', (e) => {
        currentPoleFilter = e.detail.filter;
        renderStatCards();
        renderNodeCards();
    });

    // swips/system → CPU, mem, battery per pole
    // Only trust data.node to assign pole — Pole 2 has no detection script
    // so any system event with node=pole-1 is Pole 1 data, even if relayed via Pole 2
    window.addEventListener('swips:system', (e) => {
        const { data, source } = e.detail;
        if (!data) return;

        // Reject mirrored data: if data.node says pole-1 but came from pole-2 source, skip pole-2 update
        const reportedNode = data.node || 'pole-1';
        isReceivingData = true;
        const isPole1 = reportedNode === 'pole-1';

        if (isPole1) {
            cpuPole1.shift(); cpuPole1.push(data.cpuUsage || 0);
            memPole1.shift(); memPole1.push(data.memoryUsage || 0);
            battPole1.shift(); battPole1.push(data.batteryVoltage || 0);
            latestPole1 = {
                cpuUsage: data.cpuUsage || 0,
                memoryUsage: data.memoryUsage || 0,
                batteryVoltage: data.batteryVoltage || 12.6,
                network: true,
                cpuTemp: data.cpuTemp || latestPole1.cpuTemp || 0,
                batteryPercent: data.batteryPercent || latestPole1.batteryPercent || 0,
            };
        } else {
            cpuPole2.shift(); cpuPole2.push(data.cpuUsage || 0);
            memPole2.shift(); memPole2.push(data.memoryUsage || 0);
            battPole2.shift(); battPole2.push(data.batteryVoltage || 0);
            latestPole2 = {
                cpuUsage: data.cpuUsage || 0,
                memoryUsage: data.memoryUsage || 0,
                batteryVoltage: data.batteryVoltage || 12.6,
                network: true,
                cpuTemp: data.cpuTemp || latestPole2.cpuTemp || 0,
                batteryPercent: data.batteryPercent || latestPole2.batteryPercent || 0,
            };
        }

        // Keep global values updated (for backwards compat)
        currentCpuTemp = data.cpuTemp || currentCpuTemp;
        currentBatteryPct = data.batteryPercent || currentBatteryPct;
        currentBatteryV = data.batteryVoltage || currentBatteryV;
    });

    // swips:remote-online → Pole 2 reachability from API fetch
    window.addEventListener('swips:remote-online', (e) => {
        const { node, reachable } = e.detail;
        if (node === 'pole-2' || node === 'pole2') {
            latestPole2.network = reachable;
        } else if (node === 'pole-1' || node === 'pole1') {
            latestPole1.network = reachable;
        }
        renderNodeCards();
    });

    // swips/detection → latency + fps (per-pole)
    window.addEventListener('swips:detection', (e) => {
        const { data, pole } = e.detail;
        if (!data) return;
        isReceivingData = true;
        latencyData.shift();
        latencyData.push(data.latency || 0);
        currentFps = data.fps || 0;

        // Track per-pole FPS
        if (pole === 'pole-1') {
            fpsPole1 = data.fps || 0;
        } else if (pole === 'pole-2') {
            fpsPole2 = data.fps || 0;
        }
    });

    // /api/system/history → backfill charts on first load
    window.addEventListener('swips:system-history', (e) => {
        const rows = e.detail;
        if (!rows || !Array.isArray(rows)) return;

        rows.forEach(row => {
            const isPole1 = row.node === 'pole-1';
            const field = row._field;
            const val = row._value || 0;

            if (field === 'cpuUsage') {
                if (isPole1) { cpuPole1.shift(); cpuPole1.push(val); }
                else { cpuPole2.shift(); cpuPole2.push(val); }
            } else if (field === 'memoryUsage') {
                if (isPole1) { memPole1.shift(); memPole1.push(val); }
                else { memPole2.shift(); memPole2.push(val); }
            } else if (field === 'batteryVoltage') {
                if (isPole1) { battPole1.shift(); battPole1.push(val); }
                else { battPole2.shift(); battPole2.push(val); }
            } else if (field === 'cpuTemp') {
                currentCpuTemp = val;
                if (isPole1) latestPole1.cpuTemp = val;
                else latestPole2.cpuTemp = val;
            } else if (field === 'batteryPercent') {
                currentBatteryPct = val;
                if (isPole1) latestPole1.batteryPercent = val;
                else latestPole2.batteryPercent = val;
            }
        });
    });
}

// ─── Stat Cards ──────────────────────────────────────────────────────────────

function renderStatCards() {
    // ── Overall Status ──
    const statusEl = document.getElementById('perf-status-value');
    const statusDot = document.getElementById('perf-status-dot');

    if (statusEl) {
        if (!isReceivingData) {
            statusEl.textContent = 'Waiting for Data...';
        } else if (currentPoleFilter === 'both') {
            const p1Ok = latestPole1.network;
            const p2Ok = latestPole2.network;
            if (p1Ok && p2Ok) statusEl.textContent = 'All Systems Normal';
            else if (p1Ok || p2Ok) statusEl.textContent = 'Partial Connectivity';
            else statusEl.textContent = 'No Connection';
        } else if (currentPoleFilter === 'pole-1') {
            statusEl.textContent = latestPole1.network ? 'Pole 1 Normal' : 'Pole 1 Offline';
        } else {
            statusEl.textContent = latestPole2.network ? 'Pole 2 Normal' : 'Pole 2 Offline';
        }
    }
    if (statusDot) {
        let isGood;
        if (currentPoleFilter === 'both') {
            isGood = isReceivingData && (latestPole1.network || latestPole2.network);
        } else if (currentPoleFilter === 'pole-1') {
            isGood = isReceivingData && latestPole1.network;
        } else {
            isGood = isReceivingData && latestPole2.network;
        }
        statusDot.className = `perf-status-indicator ${isGood ? 'good' : 'warning'}`;
    }

    // ── CPU Temp (filtered) ──
    let displayTemp;
    if (currentPoleFilter === 'both') {
        // Worst case = highest temperature
        displayTemp = Math.max(latestPole1.cpuTemp || 0, latestPole2.cpuTemp || 0);
    } else if (currentPoleFilter === 'pole-1') {
        displayTemp = latestPole1.cpuTemp || 0;
    } else {
        displayTemp = latestPole2.cpuTemp || 0;
    }

    const tempEl = document.getElementById('perf-cpu-temp');
    const tempBar = document.getElementById('perf-temp-bar');
    if (tempEl) tempEl.textContent = displayTemp.toFixed(1);
    if (tempBar) {
        const pct = ((displayTemp - 40) / 45) * 100;
        tempBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        tempBar.style.background = displayTemp > 65 ? '#f59e0b' : displayTemp > 55 ? '#4ade80' : '#60a5fa';
    }

    // ── Battery Level (filtered) ──
    let displayBattery;
    if (currentPoleFilter === 'both') {
        // Worst case = lowest battery
        const p1 = latestPole1.batteryPercent || 0;
        const p2 = latestPole2.batteryPercent || 0;
        // If only one pole has data, use that; otherwise use minimum
        if (p1 > 0 && p2 > 0) displayBattery = Math.min(p1, p2);
        else displayBattery = Math.max(p1, p2); // use whichever has data
    } else if (currentPoleFilter === 'pole-1') {
        displayBattery = latestPole1.batteryPercent || 0;
    } else {
        displayBattery = latestPole2.batteryPercent || 0;
    }

    const battEl = document.getElementById('perf-battery-pct');
    const battHrs = document.getElementById('perf-battery-hours');
    if (battEl) battEl.textContent = `${displayBattery}%`;
    if (battHrs) {
        battHrs.textContent = displayBattery > 0 ? `~${(displayBattery / 100 * 8).toFixed(1)}h remaining` : 'Not monitored';
    }

    // ── Inference FPS (filtered) ──
    let displayFps;
    if (currentPoleFilter === 'both') {
        // Worst case = lowest FPS
        const f1 = fpsPole1 || 0;
        const f2 = fpsPole2 || 0;
        if (f1 > 0 && f2 > 0) displayFps = Math.min(f1, f2);
        else displayFps = Math.max(f1, f2); // use whichever has data
    } else if (currentPoleFilter === 'pole-1') {
        displayFps = fpsPole1 || 0;
    } else {
        displayFps = fpsPole2 || 0;
    }

    const fpsEl = document.getElementById('perf-fps-value');
    const fpsStatus = document.getElementById('perf-fps-status');
    if (fpsEl) fpsEl.textContent = displayFps.toFixed(1);
    if (fpsStatus) {
        if (displayFps === 0) { fpsStatus.textContent = 'No Data'; fpsStatus.className = 'perf-fps-tag warning'; }
        else if (displayFps >= 8 && displayFps <= 12) { fpsStatus.textContent = 'On Target'; fpsStatus.className = 'perf-fps-tag good'; }
        else if (displayFps < 8) { fpsStatus.textContent = 'Below Target'; fpsStatus.className = 'perf-fps-tag warning'; }
        else { fpsStatus.textContent = 'Above Target'; fpsStatus.className = 'perf-fps-tag good'; }
    }
}

// ─── Node Status Cards ──────────────────────────────────────────────────────

function renderNodeCards() {
    const nodes = [
        { id: 'pole1', data: latestPole1, pole: 'pole-1', isSensing: true },
        { id: 'pole2', data: latestPole2, pole: 'pole-2', isSensing: false },
    ];

    nodes.forEach(({ id, data, pole, isSensing }) => {
        const isOnline = data.network || false;

        // Dot indicator
        const dotEl = document.getElementById(`node-${id}-dot`);
        if (dotEl) {
            dotEl.className = `perf-node-dot ${isOnline ? 'online' : 'offline'}`;
        }

        // Pi Status — online if we are receiving system events
        const piEl = document.getElementById(`node-${id}-pi`);
        if (piEl) {
            piEl.textContent = isOnline ? 'Online' : 'Offline';
            piEl.className = `node-status-value ${isOnline ? 'good' : 'warning'}`;
        }

        // Camera — Pole 1 only (infer from FPS), Pole 2 is display-only
        const cameraEl = document.getElementById(`node-${id}-camera`);
        if (cameraEl) {
            if (!isSensing) {
                cameraEl.textContent = 'N/A';
                cameraEl.className = 'node-status-value muted';
            } else {
                const camActive = fpsPole1 > 0;
                cameraEl.textContent = camActive ? 'Online' : 'Offline';
                cameraEl.className = `node-status-value ${camActive ? 'good' : 'warning'}`;
            }
        }

        // Battery — show voltage from latest data
        const battEl = document.getElementById(`node-${id}-battery`);
        if (battEl) {
            const v = data.batteryVoltage || 0;
            battEl.textContent = v > 0 ? `${v.toFixed(1)}V` : '—';
            const isGood = v >= 11.5;
            const isWarn = v >= 11 && v < 11.5;
            battEl.className = `node-status-value ${isGood ? 'good' : isWarn ? 'warning' : v > 0 ? 'critical' : ''}`;
        }

        // MQTT — connected if system events are arriving (works in both hotspot + MSCA)
        const netEl = document.getElementById(`node-${id}-network`);
        if (netEl) {
            netEl.textContent = isOnline ? 'Connected' : 'No Signal';
            netEl.className = `node-status-value ${isOnline ? 'good' : 'warning'}`;
        }
    });
}

// ─── Charts (UNCHANGED structures) ──────────────────────────────────────────

const CHART_DEFAULTS = {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 600, easing: 'easeOutQuart' },
    plugins: {
        legend: { display: true, position: 'top', align: 'end',
            labels: { boxWidth: 10, boxHeight: 3, padding: 12, font: { size: 10 }, usePointStyle: true, pointStyleWidth: 14 } },
        tooltip: { backgroundColor: 'rgba(10,10,10,0.92)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10 }
    },
    scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }, ticks: { font: { size: 9 }, maxTicksLimit: 10 } },
        y: { grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false }, border: { dash: [4, 4] } }
    }
};

function renderCpuMemChart() {
    const ctx = document.getElementById('chart-cpu-mem');
    if (!ctx || !window.Chart) return;
    if (cpuMemChart) cpuMemChart.destroy();
    cpuMemChart = new Chart(ctx, {
        type: 'line',
        data: { labels: TIME_LABELS, datasets: [
            { label: 'CPU % (Pole 1)', data: cpuPole1, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1.5, tension: 0.4, fill: true, pointRadius: 0 },
            { label: 'CPU % (Pole 2)', data: cpuPole2, borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.06)', borderWidth: 1.5, tension: 0.4, fill: true, pointRadius: 0 },
            { label: 'Mem % (Pole 1)', data: memPole1, borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.06)', borderWidth: 1.5, tension: 0.4, fill: true, pointRadius: 0, borderDash: [4, 3] },
            { label: 'Mem % (Pole 2)', data: memPole2, borderColor: '#f472b6', backgroundColor: 'rgba(244,114,182,0.05)', borderWidth: 1.5, tension: 0.4, fill: true, pointRadius: 0, borderDash: [4, 3] },
        ]},
        options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100, ticks: { callback: v => `${v}%`, stepSize: 20 } } } }
    });
}

function renderLatencyChart() {
    const ctx = document.getElementById('chart-inference-latency');
    if (!ctx || !window.Chart) return;
    if (latencyChart) latencyChart.destroy();
    const thresholdPlugin = {
        id: 'thresholdLine',
        afterDraw(chart) {
            const y = chart.scales.y, c = chart.ctx, p = y.getPixelForValue(250);
            c.save(); c.setLineDash([6,4]); c.strokeStyle='#ef4444'; c.lineWidth=1.5;
            c.beginPath(); c.moveTo(chart.chartArea.left,p); c.lineTo(chart.chartArea.right,p); c.stroke();
            c.fillStyle='#ef4444'; c.font='10px Inter, sans-serif'; c.fillText('250ms Threshold',chart.chartArea.right-100,p-6); c.restore();
        }
    };
    latencyChart = new Chart(ctx, {
        type: 'line',
        data: { labels: TIME_LABELS, datasets: [{ label: 'Inference Latency (ms)', data: latencyData, borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', borderWidth: 1.8, tension: 0.35, fill: true, pointRadius: 0 }] },
        options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 350, ticks: { callback: v => `${v}ms`, stepSize: 50 } } } },
        plugins: [thresholdPlugin]
    });
}

function renderBatteryChart() {
    const ctx = document.getElementById('chart-battery-discharge');
    if (!ctx || !window.Chart) return;
    if (batteryChart) batteryChart.destroy();
    const battPlugin = {
        id: 'battThreshold',
        afterDraw(chart) {
            const y = chart.scales.y, c = chart.ctx, p = y.getPixelForValue(11);
            c.save(); c.setLineDash([6,4]); c.strokeStyle='#ef4444'; c.lineWidth=1.5;
            c.beginPath(); c.moveTo(chart.chartArea.left,p); c.lineTo(chart.chartArea.right,p); c.stroke();
            c.fillStyle='#ef4444'; c.font='10px Inter, sans-serif'; c.fillText('11V Min',chart.chartArea.left+8,p-6); c.restore();
        }
    };
    batteryChart = new Chart(ctx, {
        type: 'line',
        data: { labels: TIME_LABELS, datasets: [
            { label: 'Pole 1 (V)', data: battPole1, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.06)', borderWidth: 1.8, tension: 0.35, fill: true, pointRadius: 0 },
            { label: 'Pole 2 (V)', data: battPole2, borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.06)', borderWidth: 1.8, tension: 0.35, fill: true, pointRadius: 0 },
        ]},
        options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 10.5, max: 13.0, ticks: { callback: v => `${v}V`, stepSize: 0.5 } } } },
        plugins: [battPlugin]
    });
}

function renderSyncGauge() {
    const ctx = document.getElementById('chart-panel-sync');
    if (!ctx || !window.Chart) return;
    if (syncGaugeChart) syncGaugeChart.destroy();
    const offset = currentSyncOffset, maxMs = 20;
    const pct = Math.min((offset/maxMs)*100,100), rem = 100-pct;
    const color = offset<=5?'#4ade80':offset<=10?'#fbbf24':'#ef4444';
    const text = offset<=5?'Excellent':offset<=10?'Acceptable':'Out of Sync';
    const valEl = document.getElementById('sync-offset-value');
    const stEl = document.getElementById('sync-status-label');
    if (valEl) valEl.textContent = `${offset.toFixed(1)}ms`;
    if (stEl) { stEl.textContent = text; stEl.style.color = color; }
    syncGaugeChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: ['Offset','Remaining'], datasets: [{ data: [pct,rem], backgroundColor: [color,'rgba(255,255,255,0.04)'], borderColor: '#0a0a0a', borderWidth: 3, circumference: 240, rotation: 240 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '78%', plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 800, easing: 'easeOutQuart' } }
    });
}

// ─── Live Update Loop ────────────────────────────────────────────────────────

let perfInterval = null;
function startLiveUpdates() {
    if (perfInterval) return;
    perfInterval = setInterval(() => {
        renderStatCards();
        renderNodeCards();
        if (cpuMemChart) {
            cpuMemChart.data.datasets[0].data = cpuPole1;
            cpuMemChart.data.datasets[1].data = cpuPole2;
            cpuMemChart.data.datasets[2].data = memPole1;
            cpuMemChart.data.datasets[3].data = memPole2;
            cpuMemChart.update('none');
        }
        if (latencyChart) {
            latencyChart.data.datasets[0].data = latencyData;
            latencyChart.update('none');
        }
        if (batteryChart) {
            batteryChart.data.datasets[0].data = battPole1;
            batteryChart.data.datasets[1].data = battPole2;
            batteryChart.update('none');
        }
        renderSyncGauge();
    }, 3000);
}

// ─── Public Init ─────────────────────────────────────────────────────────────

export function initPerformance() {
    bindLiveEvents();

    if (!window.Chart) {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
        script.onload = () => {
            Chart.defaults.color = 'rgba(255,255,255,0.5)';
            Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
            Chart.defaults.font.size = 11;
            _render();
        };
        document.head.appendChild(script);
    } else { _render(); }
}

function _render() {
    if (window.lucide) window.lucide.createIcons();
    renderStatCards();
    renderNodeCards();
    renderCpuMemChart();
    renderLatencyChart();
    renderBatteryChart();
    renderSyncGauge();
    startLiveUpdates();
    perfInitialized = true;
}
