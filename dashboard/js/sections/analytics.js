/**
 * SWiPS – Pedestrian Analytics Section
 * Renders pedestrian data using Chart.js (loaded via CDN in HTML).
 * Supports global pole filtering via 'swips:pole-filter-changed' event.
 *
 * 2026-05-12 fix: initAnalytics() now fetches hourly data directly so the
 * stat cards / bar chart render correctly on first visit, instead of
 * depending on fetchDashboardStats() firing the swips:analytics-hourly
 * event ~100ms later (which raced with _render and Chart.js loading).
 * The event listener is kept intact for refreshes / pole-filter updates.
 */

let analyticsInitialized = false;
let hourlyChart = null;
let trendChart = null;
let modeChart = null;

// Heatmap data: 7×24 matrix from backend, Mon=0..Sun=6 × hour=0..23
let HEATMAP_MATRIX = null;

// Current pole filter: 'both', 'pole-1', or 'pole-2'
let currentPoleFilter = 'both';

// ─── Data Storage (per-pole + merged) ───────────────────────────────────────

// Stores hourly data per pole: { 'pole-1': [...24], 'pole-2': [...24] }
const hourlyDataByPole = {};

// Stores daily data per pole: { 'pole-1': [...7], 'pole-2': [...7] }
const dailyDataByPole = {};

/** Counts per hour (0–23) — computed from per-pole data */
let HOURLY_DATA = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
];

/** Labels for hourly chart */
const HOUR_LABELS = HOURLY_DATA.map((_, i) => {
    const h = i % 12 === 0 ? 12 : i % 12;
    const ampm = i < 12 ? 'AM' : 'PM';
    return `${h}${ampm}`;
});

/** Past 7 days trend (Mon–Sun relative to today) */
let DAILY_DATA = [0, 0, 0, 0, 0, 0, 0];
const getDayLabels = () => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(today.getDate() - (6 - i));
        return days[d.getDay()];
    });
};

/** System mode breakdown (seconds in each mode over today) */
const MODE_DATA = { IDLE: 0, CROSSING: 0, OBSTRUCTION: 0 };

// ─── Local Pole Detection ───────────────────────────────────────────────────
// Must match the key fetchDashboardStats uses when it later dispatches the
// 'swips:analytics-hourly' event, so seeding + the event update the same
// hourlyDataByPole slot (otherwise mergeHourlyData would double-count).

function detectLocalPole() {
    // Prefer whatever script.js / state has already determined
    try {
        if (window.state && typeof window.state.localPole === 'string' && window.state.localPole) {
            return window.state.localPole;
        }
        if (window.localPole && typeof window.localPole === 'string') {
            return window.localPole;
        }
    } catch (_) { /* ignore */ }
    // Sensible default — Pole 1 is the host for this dashboard
    return 'pole-1';
}

// ─── Merge Helpers ──────────────────────────────────────────────────────────

function mergeHourlyData() {
    HOURLY_DATA = new Array(24).fill(0);
    const poles = Object.keys(hourlyDataByPole);
    const filtered = currentPoleFilter === 'both' ? poles : poles.filter(p => p === currentPoleFilter);
    filtered.forEach(pole => {
        const data = hourlyDataByPole[pole];
        if (data) data.forEach((v, i) => { HOURLY_DATA[i] += v; });
    });
}

function mergeDailyData() {
    DAILY_DATA = new Array(7).fill(0);
    const poles = Object.keys(dailyDataByPole);
    const filtered = currentPoleFilter === 'both' ? poles : poles.filter(p => p === currentPoleFilter);
    filtered.forEach(pole => {
        const data = dailyDataByPole[pole];
        if (data) data.forEach((v, i) => { DAILY_DATA[i] += v; });
    });
}

// ─── Data Event Listeners ───────────────────────────────────────────────────

let eventsbound = false;
function bindAnalyticsEvents() {
    if (eventsbound) return;
    eventsbound = true;

    // Hourly data from API (dispatched by script.js)
    window.addEventListener('swips:analytics-hourly', (e) => {
        const { rows, pole } = e.detail;
        if (!rows || !Array.isArray(rows) || rows.length === 0) return;

        const hourly = new Array(24).fill(0);
        rows.forEach(r => {
            const hour = new Date(r._time).getHours();
            hourly[hour] += (r._value || 0);
        });
        hourlyDataByPole[pole] = hourly;

        mergeHourlyData();
        renderStatCards();
        renderHourlyChart();
        renderHeatmap();
    });

    // Weekly data from API (dispatched by script.js)
    window.addEventListener('swips:analytics-weekly', (e) => {
        const { rows, pole } = e.detail;
        if (!rows || !Array.isArray(rows) || rows.length === 0) return;

        const daily = new Array(7).fill(0);
        const now = new Date();
        rows.forEach(r => {
            const d = new Date(r._time);
            const daysAgo = Math.floor((now - d) / (1000 * 60 * 60 * 24));
            const idx = 6 - daysAgo;
            if (idx >= 0 && idx < 7) daily[idx] += (r._value || 0);
        });
        dailyDataByPole[pole] = daily;

        mergeDailyData();
        renderStatCards();
        renderTrendChart();
    });

    // Mode data from real-time detection events
    window.addEventListener('swips:detection', (e) => {
        const { data, pole } = e.detail;
        if (!data) return;
        // Only count modes if filter matches
        if (currentPoleFilter !== 'both' && pole !== currentPoleFilter) return;
        const rawMode = (data.mode || 'IDLE').toUpperCase();
        // Normalise CROSSING_1_4 / CROSSING_5_PLUS → CROSSING
        const mode = rawMode.startsWith('CROSSING') ? 'CROSSING' : rawMode;
        if (MODE_DATA.hasOwnProperty(mode)) {
            MODE_DATA[mode]++;
            if (analyticsInitialized) renderModeChart();
        }
    });

    // Global pole filter changed
    window.addEventListener('swips:pole-filter-changed', (e) => {
        currentPoleFilter = e.detail.filter;
        mergeHourlyData();
        mergeDailyData();
        if (analyticsInitialized) _render();
    });

    // Heatmap data from API (aggregate across all nodes, ignores pole filter)
    window.addEventListener('swips:analytics-heatmap', (e) => {
        const payload = e.detail;
        if (!payload || !Array.isArray(payload.matrix)) return;
        HEATMAP_MATRIX = payload.matrix;
        if (analyticsInitialized) renderHeatmap();
    });
}

// ─── Computed Stats ─────────────────────────────────────────────────────────

function computeStats() {
    const todayTotal = HOURLY_DATA.reduce((a, b) => a + b, 0);
    const weeklyAvg = Math.round(DAILY_DATA.reduce((a, b) => a + b, 0) / 7);
    const peakHourIdx = HOURLY_DATA.indexOf(Math.max(...HOURLY_DATA));
    const peakHourLabel = `${peakHourIdx % 12 === 0 ? 12 : peakHourIdx % 12}:00 ${peakHourIdx < 12 ? 'AM' : 'PM'}`;
    const peakCount = HOURLY_DATA[peakHourIdx];
    const currentHour = new Date().getHours();
    const currentHourCount = HOURLY_DATA[currentHour];
    return { todayTotal, weeklyAvg, peakHourIdx, peakHourLabel, peakCount, currentHour, currentHourCount };
}

// ─── Chart.js Defaults ──────────────────────────────────────────────────────

function applyChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = 'rgba(255,255,255,0.5)';
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
}

// ─── Stat Cards ─────────────────────────────────────────────────────────────

function renderStatCards() {
    const stats = computeStats();
    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setEl('stat-peak-hour', stats.peakHourLabel);
    setEl('stat-peak-count', `${stats.peakCount} pedestrians`);
    setEl('stat-total-today', stats.todayTotal.toLocaleString());
    setEl('stat-total-today-sub', 'since midnight');
    setEl('stat-weekly-avg', stats.weeklyAvg.toLocaleString());
    setEl('stat-weekly-sub', 'pedestrians/day');
    setEl('stat-current-hour', stats.currentHourCount.toString());
    setEl('stat-current-hour-sub', `this hour (${HOUR_LABELS[stats.currentHour]})`);
}

// ─── Hourly Bar Chart ────────────────────────────────────────────────────────

function renderHourlyChart() {
    const ctx = document.getElementById('chart-hourly');
    if (!ctx || !window.Chart) return;

    const stats = computeStats();

    const barColors = HOURLY_DATA.map((_, i) => {
        if (i === stats.peakHourIdx) return 'rgba(74, 222, 128, 0.9)';
        if (i === stats.currentHour) return 'rgba(96, 165, 250, 0.8)';
        if (i >= 7 && i <= 9) return 'rgba(74, 222, 128, 0.55)';
        if (i >= 12 && i <= 13) return 'rgba(74, 222, 128, 0.55)';
        if (i >= 17 && i <= 18) return 'rgba(74, 222, 128, 0.55)';
        return 'rgba(255, 255, 255, 0.12)';
    });

    if (hourlyChart) hourlyChart.destroy();
    hourlyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: HOUR_LABELS,
            datasets: [{
                label: 'Pedestrians',
                data: HOURLY_DATA,
                backgroundColor: barColors,
                borderRadius: 4,
                borderSkipped: false,
                hoverBackgroundColor: 'rgba(74, 222, 128, 0.85)',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 10, 10, 0.92)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        title: (items) => `Hour: ${items[0].label}`,
                        label: (item) => ` ${item.raw} pedestrians`,
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                    ticks: { maxRotation: 0, font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
                    border: { dash: [4, 4] },
                    ticks: { stepSize: 20 },
                    beginAtZero: true
                }
            },
            animation: {
                duration: 900,
                easing: 'easeOutQuart',
            }
        }
    });
}

// ─── Daily Trend Line Chart ──────────────────────────────────────────────────

function renderTrendChart() {
    const ctx = document.getElementById('chart-trend');
    if (!ctx || !window.Chart) return;

    const dayLabels = getDayLabels();

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dayLabels,
            datasets: [{
                label: 'Pedestrians',
                data: DAILY_DATA,
                borderColor: '#4ade80',
                backgroundColor: (ctx) => {
                    const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
                    gradient.addColorStop(0, 'rgba(74,222,128,0.28)');
                    gradient.addColorStop(1, 'rgba(74,222,128,0.0)');
                    return gradient;
                },
                borderWidth: 2.5,
                pointBackgroundColor: '#4ade80',
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBorderColor: '#0a0a0a',
                pointBorderWidth: 2,
                fill: true,
                tension: 0.4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 10, 10, 0.92)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: (item) => ` ${item.raw} pedestrians`,
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
                    border: { dash: [4, 4] },
                    beginAtZero: false,
                    ticks: { stepSize: 100 }
                }
            },
            animation: { duration: 950, easing: 'easeOutQuart' }
        }
    });
}

// ─── Mode Donut Chart ────────────────────────────────────────────────────────

function renderModeChart() {
    const ctx = document.getElementById('chart-mode');
    if (!ctx || !window.Chart) return;

    const total = Object.values(MODE_DATA).reduce((a, b) => a + b, 0);

    // Update legend values
    Object.entries(MODE_DATA).forEach(([mode, secs]) => {
        const pct = total > 0 ? Math.round((secs / total) * 100) : 0;
        const el = document.getElementById(`mode-legend-${mode.toLowerCase()}`);
        if (el) el.textContent = `${pct}%`;
    });

    if (modeChart) modeChart.destroy();
    modeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['IDLE', 'CROSSING', 'OBSTRUCTION'],
            datasets: [{
                data: [MODE_DATA.IDLE, MODE_DATA.CROSSING, MODE_DATA.OBSTRUCTION],
                backgroundColor: [
                    'rgba(100, 116, 139, 0.85)',   // slate – IDLE
                    'rgba(74, 222, 128, 0.85)',    // green – CROSSING
                    'rgba(239, 68, 68, 0.85)',     // red   – OBSTRUCTION
                ],
                borderColor: '#0a0a0a',
                borderWidth: 3,
                hoverOffset: 8,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,10,10,0.92)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: (item) => {
                            const pct = total > 0 ? Math.round((item.raw / total) * 100) : 0;
                            const h = Math.floor(item.raw / 3600);
                            const m = Math.floor((item.raw % 3600) / 60);
                            return ` ${pct}% · ${h}h ${m}m`;
                        }
                    }
                }
            },
            animation: { duration: 900, easing: 'easeOutQuart' }
        }
    });
}

// ─── Crosswalk Activity Heatmap ──────────────────────────────────────────────

function renderHeatmap() {
    const container = document.getElementById('heatmap-cells');
    if (!container) return;
    container.innerHTML = '';

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // If backend data hasn't arrived yet, show empty grid (not fake data)
    if (!HEATMAP_MATRIX) {
        for (let i = 0; i < 7 * 24; i++) {
            const cell = document.createElement('div');
            cell.className = 'heatmap-cell';
            cell.style.background = 'rgba(255,255,255,0.04)';
            cell.title = 'No data yet';
            container.appendChild(cell);
        }
        return;
    }

    // Find max value across the whole matrix for normalization
    let max = 0;
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const v = (HEATMAP_MATRIX[d] && HEATMAP_MATRIX[d][h]) || 0;
            if (v > max) max = v;
        }
    }
    if (max === 0) max = 1; // prevent division by zero

    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const cell = document.createElement('div');
            cell.className = 'heatmap-cell';

            const val = (HEATMAP_MATRIX[d] && HEATMAP_MATRIX[d][h]) || 0;
            const intensity = val / max;

            if (intensity < 0.05) {
                cell.style.background = 'rgba(255,255,255,0.04)';
            } else if (intensity < 0.25) {
                cell.style.background = `rgba(74,222,128,${0.15 + intensity * 0.4})`;
            } else if (intensity < 0.6) {
                cell.style.background = `rgba(74,222,128,${0.4 + intensity * 0.3})`;
            } else {
                cell.style.background = `rgba(74,222,128,${0.75 + intensity * 0.25})`;
            }

            const hourLabel = h === 0 ? '12AM' : h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h - 12}PM`;
            cell.title = `${dayNames[d]} ${hourLabel} · avg ${val.toFixed(1)} persons detected`;
            container.appendChild(cell);
        }
    }
}

// ─── Public Init ─────────────────────────────────────────────────────────────

export function initAnalytics() {
    bindAnalyticsEvents();

    // Resolve which pole-key to seed under so we match the key fetchDashboardStats
    // will later use in its event dispatch (prevents mergeHourlyData double-counting).
    const seedPole = detectLocalPole();

    // Kick off all three primary fetches in parallel. We render once both
    // Chart.js is loaded AND the fetches have settled, whichever is slower.
    const modesPromise = fetch('/api/analytics/modes')
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    const hourlyPromise = fetch('/api/analytics/hourly')
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    const weeklyPromise = fetch('/api/analytics/weekly')
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    const chartReady = window.Chart
        ? Promise.resolve()
        : new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = '/assets/js/chart.umd.min.js';
            s.onload = resolve;
            s.onerror = resolve; // resolve anyway; _render guards on window.Chart
            document.head.appendChild(s);
        });

    Promise.all([modesPromise, hourlyPromise, weeklyPromise, chartReady])
        .then(([modesData, hourlyData, weeklyData]) => {

            // Seed MODE_DATA
            if (modesData && typeof modesData.IDLE === 'number') {
                MODE_DATA.IDLE        = modesData.IDLE;
                MODE_DATA.CROSSING    = modesData.CROSSING;
                MODE_DATA.OBSTRUCTION = modesData.OBSTRUCTION;
            }

            // Seed HOURLY_DATA directly under the resolved pole key.
            // Browser converts the UTC _time to local (PHT) automatically.
            if (Array.isArray(hourlyData)) {
                const hourly = new Array(24).fill(0);
                hourlyData.forEach(r => {
                    const hour = new Date(r._time).getHours();
                    hourly[hour] += (r._value || 0);
                });
                hourlyDataByPole[seedPole] = hourly;
                mergeHourlyData();
            }

            // Seed DAILY_DATA the same way
            if (Array.isArray(weeklyData)) {
                const daily = new Array(7).fill(0);
                const now = new Date();
                weeklyData.forEach(r => {
                    const d = new Date(r._time);
                    const daysAgo = Math.floor((now - d) / (1000 * 60 * 60 * 24));
                    const idx = 6 - daysAgo;
                    if (idx >= 0 && idx < 7) daily[idx] += (r._value || 0);
                });
                dailyDataByPole[seedPole] = daily;
                mergeDailyData();
            }

            applyChartDefaults();
            _render();
        })
        .catch((err) => {
            // Don't leave the page blank if something throws; render with whatever we have
            console.error('[analytics] init fetch error:', err);
            applyChartDefaults();
            _render();
        });
}

function _render() {
    // Set date label
    const dateEl = document.getElementById('analytics-date-label');
    if (dateEl) {
        const now = new Date();
        dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    // Re-create Lucide icons for the analytics section icons
    if (window.lucide) window.lucide.createIcons();

    renderStatCards();
    renderHourlyChart();
    renderTrendChart();
    renderModeChart();
    renderHeatmap();
    analyticsInitialized = true;
}

export function refreshAnalytics() {
    if (!analyticsInitialized || !window.Chart) return;
    renderHourlyChart();
    renderTrendChart();
    renderModeChart();
}
