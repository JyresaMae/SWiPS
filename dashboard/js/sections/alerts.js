/**
 * SWiPS – Alert & Risk Reports Section (CustomEvent-driven)
 *
 * No imports from core/state.js — gets all data via CustomEvents + fetch.
 * Matches the architecture of performance.js.
 *
 * Data sources:
 *   'swips:alert' event        → live alerts from WebSocket
 *   'swips:alerts-weekly' event → weekly alert trend
 *   /api/alerts/live            → initial alert history
 *   /api/violations             → violation counters
 */

let eventsBound = false;
let alertFreqChart = null;
let alertTypeChart = null;

// Local alert state
const alertState = {
    violations: {
        jaywalking: 0, massJaywalking: 0, obstruction: 0,
        vehicleInCrosswalk: 0, obstructionWarning: 0,
        totalAlerts: 0, criticalAlerts: 0,
    },
    alertHistory: [],
    weeklyData: [],
};

let currentPoleFilter = 'both';

function getFilteredAlerts() {
    if (currentPoleFilter === 'both') return alertState.alertHistory;
    return alertState.alertHistory.filter(a => {
        const pole = a.pole || a.location || '';
        return pole === currentPoleFilter;
    });
}

function getFilteredViolations() {
    if (currentPoleFilter === 'both') return alertState.violations;
    const filtered = getFilteredAlerts();
    const v = { obstruction: 0, jaywalking: 0, massJaywalking: 0, vehicleInCrosswalk: 0, obstructionWarning: 0, totalAlerts: 0, criticalAlerts: 0 };
    filtered.forEach(a => {
        v.totalAlerts++;
        if (a.severity === 'critical') v.criticalAlerts++;
        if (a.type === 'OBSTRUCTION') v.obstruction++;
        else if (a.type === 'JAYWALKING') v.jaywalking++;
        else if (a.type === 'MASS_JAYWALKING') v.massJaywalking++;
        else if (a.type === 'VEHICLE_IN_CROSSWALK') v.vehicleInCrosswalk++;
        else if (a.type === 'OBSTRUCTION_WARNING') v.obstructionWarning++;
    });
    return v;
}

const ALERT_CONFIG = {
    OBSTRUCTION:          { icon: '🚧', label: 'Obstruction',           color: '#f87171' },
    VEHICLE_IN_CROSSWALK: { icon: '🚗', label: 'Vehicle in Crosswalk',  color: '#ef4444' },
    MASS_JAYWALKING:      { icon: '🚶‍♂️', label: 'Mass Jaywalking',      color: '#ef4444' },
    JAYWALKING:           { icon: '🚶', label: 'Jaywalking',            color: '#fb923c' },
    OBSTRUCTION_WARNING:  { icon: '⏱️', label: 'Obstruction Warning',   color: '#fbbf24' },
    SYSTEM_HEALTH:        { icon: '💻', label: 'System Health',         color: '#6b7280' },
};

const SEVERITY_HTML = {
    critical: '<span class="badge-severity badge-critical">CRITICAL</span>',
    moderate: '<span class="badge-severity badge-moderate">MODERATE</span>',
    normal:   '<span class="badge-severity badge-normal">NORMAL</span>',
};

function bindAlertEvents() {
    if (eventsBound) return;
    eventsBound = true;

    window.addEventListener('swips:alert', (e) => {
        const { data, violations } = e.detail;
        if (violations) alertState.violations = violations;
        if (data) {
            const entry = {
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                ...data,
                receivedAt: new Date().toISOString(),
                status: data.status || 'active',
            };
            if (!alertState.alertHistory.find(a => a.timestamp === data.timestamp && a.type === data.type)) {
                alertState.alertHistory.unshift(entry);
                if (alertState.alertHistory.length > 100) alertState.alertHistory = alertState.alertHistory.slice(0, 100);
                prependAlertRow(entry);
                if (data.severity === 'critical') showAlertToast(data);
            }
        }
        updateAlertSummaryCards();
        updateAlertTypeChart();
    });

    window.addEventListener('swips:pole-filter-changed', (e) => {
        const filter = e.detail?.filter || 'both';
        currentPoleFilter = filter;
        renderFullAlertTable();
        renderTimeline();
        updateAlertSummaryCards();
        updateAlertTypeChart();
        renderAlertFreqChart();
    });

    window.addEventListener('swips:alerts-weekly', (e) => {
        const rows = e.detail?.rows;
        if (rows && Array.isArray(rows)) {
            alertState.weeklyData = rows;
            renderAlertFreqChart();
        }
    });
}

export function initAlerts() {
    bindAlertEvents();

    const dateEl = document.getElementById('alerts-date-label');
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric'
        });
    }

    fetchAlertData();
    setInterval(updateAlertSummaryCards, 5000);

    if (!window.Chart) {
        const script = document.createElement('script');
        script.src = '/assets/js/chart.umd.min.js';
        script.onload = () => {
            Chart.defaults.color = 'rgba(255,255,255,0.5)';
            Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
            Chart.defaults.font.size = 11;
            renderAlertFreqChart();
            renderAlertTypeChart();
        };
        document.head.appendChild(script);
    } else {
        renderAlertFreqChart();
        renderAlertTypeChart();
    }
}

async function fetchAlertData() {
    try {
        const [vRes, aRes] = await Promise.all([
            fetch('/api/violations').then(r => r.ok ? r.json() : null).catch(() => null),
            fetch('/api/alerts/live?limit=50').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (vRes?.today) alertState.violations = vRes.today;
        if (aRes?.alerts?.length > 0) {
            alertState.alertHistory = aRes.alerts;
            renderFullAlertTable();
            renderTimeline();
        }
        if (aRes?.violations) alertState.violations = aRes.violations;
        updateAlertSummaryCards();
        updateAlertTypeChart();
    } catch (err) {
        console.warn('[ALERTS] Fetch failed:', err);
    }
}

function updateAlertSummaryCards() {
    const v = getFilteredViolations();
    setText('alerts-total-today', v.totalAlerts || 0);
    setText('alerts-critical-week', v.criticalAlerts || 0);

    const types = {
        'Obstruction': (v.obstruction || 0),
        'Jaywalking': (v.jaywalking || 0),
        'Vehicle Violation': (v.vehicleInCrosswalk || 0),
    };
    const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
    setText('alerts-common-type', v.obstruction || 0);

    const filtered = getFilteredAlerts();
    if (filtered.length > 0) {
        const last = filtered[0];
        const t = new Date(last.timestamp || last.receivedAt);
        setText('alerts-last-time', t.toLocaleTimeString('en-PH', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }));
    }

    const activePill = document.querySelector('.alt-active-pill span:last-child');
    if (activePill) {
        activePill.textContent = `${filtered.filter(a => a.status === 'active').length} Active`;
    }

    const badge = document.getElementById('badgeAlerts');
    if (badge) {
        const total = alertState.alertHistory.filter(a => a.status === 'active').length;
        badge.style.display = total > 0 ? '' : 'none';
        badge.textContent = total > 99 ? '99+' : total;
    }
}

// ═══ ALERT LOG TABLE ═══
function renderTimeline() {
    const track = document.getElementById('risk-timeline-track');
    if (!track) return;
    track.innerHTML = '';
    const filtered = getFilteredAlerts().filter(a => a.type !== 'OBSTRUCTION_CLEARED');
    const START_H = 6, END_H = 14; // 6AM to 2PM window
    filtered.forEach(a => {
        const t = new Date(a.timestamp || a.receivedAt);
        const hour = t.getHours() + t.getMinutes() / 60;
        if (hour < START_H || hour > END_H) return;
        const pct = ((hour - START_H) / (END_H - START_H)) * 100;
        const dot = document.createElement('div');
        dot.className = 'tl-dot';
        const color = a.severity === 'critical' ? '#f87171' : a.severity === 'moderate' ? '#fb923c' : '#fbbf24';
        dot.style.cssText = `position:absolute;left:${pct}%;top:50%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:${color};cursor:pointer;`;
        dot.title = `${a.type} - ${new Date(a.timestamp).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'})}`;
        track.appendChild(dot);
    });
}

function renderFullAlertTable() {
    const tbody = document.getElementById('alert-log-tbody');
    if (!tbody) return;
    const alerts = getFilteredAlerts().filter(a => a.type !== 'OBSTRUCTION_CLEARED');
    tbody.innerHTML = '';
    alerts.forEach(a => tbody.appendChild(createAlertRow(a, false)));
}

function severityLabel(sev) {
    if (!sev || sev === 'info') return '<span class="badge-severity badge-normal">CLEARED</span>';
    return SEVERITY_HTML[sev] || `<span class="badge-severity">${sev.toUpperCase()}</span>`;
}

function prependAlertRow(alert) {
    const tbody = document.getElementById('alert-log-tbody');
    if (!tbody) return;
    tbody.prepend(createAlertRow(alert, true));
    while (tbody.children.length > 50) tbody.removeChild(tbody.lastChild);
}

function createAlertRow(alert, isNew) {
    const cfg = ALERT_CONFIG[alert.type] || { icon: '❓', label: alert.type, color: '#6b7280' };
    const tr = document.createElement('tr');
    tr.className = `alt-tr severity-${alert.severity || 'normal'}`;
    if (isNew) tr.classList.add('alert-row-new');

    const t = new Date(alert.timestamp || alert.receivedAt);
    const timeStr = t.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const snap = alert.snapshot
        ? `<a href="/snapshots/${alert.snapshot}" target="_blank" class="snapshot-link">📷 View</a>`
        : '<span style="opacity:0.3">—</span>';
    const sc = alert.status === 'active' ? '#f87171' : alert.status === 'acknowledged' ? '#fbbf24' : '#4ade80';

    tr.innerHTML = `
        <td class="alt-td">${timeStr}</td>
        <td class="alt-td">${alert.pole || alert.location || '—'}</td>
        <td class="alt-td"><span style="margin-right:4px">${cfg.icon}</span><span style="color:${cfg.color};font-weight:500">${cfg.label}</span></td>
        <td class="alt-td">${severityLabel(alert.severity)}</td>
        <td class="alt-td"><span style="color:${sc};font-weight:500;text-transform:capitalize">${alert.status || 'active'}</span></td>
        <td class="alt-td">${snap}</td>
    `;
    return tr;
}

// ═══ CHARTS ═══
function renderAlertFreqChart() {
    const ctx = document.getElementById('chart-alert-freq');
    if (!ctx || !window.Chart) return;
    if (alertFreqChart) alertFreqChart.destroy();

    const days = [], counts = [], colors = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
        let count = 0;
        if (alertState.weeklyData.length > 0) {
            const match = alertState.weeklyData.find(r => new Date(r._time).toDateString() === d.toDateString());
            if (match) count = match._value || 0;
        }
        if (i === 0) count = Math.max(count, alertState.violations.totalAlerts || 0);
        counts.push(count);
        colors.push(count >= 10 ? '#f87171' : count >= 5 ? '#fb923c' : '#60a5fa');
    }

    alertFreqChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: days, datasets: [{ label: 'Alerts', data: counts, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(10,10,10,0.92)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1 } },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true, ticks: { stepSize: 1, font: { size: 10 } } }
            }
        }
    });
}

function renderAlertTypeChart() { updateAlertTypeChart(); }

function updateAlertTypeChart() {
    const ctx = document.getElementById('chart-alert-type');
    if (!ctx || !window.Chart) return;

    const v = getFilteredViolations();
    const data = [v.obstruction || 0, 0];
    const total = data.reduce((s, d) => s + d, 0);

    ['type-pct-0', 'type-pct-1'].forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.textContent = total > 0 ? `${Math.round(data[i] / total * 100)}%` : '—';
    });

    if (alertTypeChart) {
        alertTypeChart.data.datasets[0].data = data;
        alertTypeChart.update('none');
        return;
    }

    alertTypeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Obstruction', 'System Health'],
            datasets: [{ data, backgroundColor: ['rgba(248,113,113,0.85)', 'rgba(96,165,250,0.85)'], borderColor: '#0a0a0a', borderWidth: 2 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(10,10,10,0.92)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1 } }
        }
    });
}

// ═══ TOAST ═══
function showAlertToast(alert) {
    const cfg = ALERT_CONFIG[alert.type] || { icon: '⚠️', label: alert.type };
    const old = document.querySelector('.alert-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'alert-toast';
    toast.innerHTML = `<span class="toast-type">${cfg.icon} ${cfg.label.toUpperCase()}</span> ${alert.message} <span class="toast-pole">${alert.pole || ''}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 350); }, 5000);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}
