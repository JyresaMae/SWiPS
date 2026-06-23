/**
 * SWiPS – Deployment Impact Section
 * Renders behavioral outcomes: driver yield rate, near-miss reduction,
 * and Week 1 vs Week 2 site comparison.
 * Uses Chart.js (loaded via CDN, same pattern as alerts.js).
 */

let complianceInitialized = false;
let complianceTrendChart = null;
let nearMissChart = null;

// ─── Simulated Data ──────────────────────────────────────────────────────────

// 14-day compliance trend: Week 1 and Week 2
const COMPLIANCE_DAYS = [
    'Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7',
    'Day 8', 'Day 9', 'Day 10', 'Day 11', 'Day 12', 'Day 13', 'Day 14'
];

// Driver yield rate (%) improving over 14 days — realistic gradual climb
const YIELD_WEEK1 = [0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, null, null];
const YIELD_WEEK2 = [null, null, null, null, null, null, null, 0, 0, 0, 0, 0, 0, 0];

// Near-miss incidents per day: Before SWiPS vs After SWiPS
const NEAR_MISS_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const NEAR_MISS_BEFORE = [0, 0, 0, 0, 0, 0, 0];
const NEAR_MISS_AFTER  = [0, 0, 0, 0, 0, 0, 0];

// Deployment Impact Summary
const DEPLOYMENT = {
    week1: {
        label: 'Week 1',
        dates: 'TBD',
        yieldRate: 0,
        nearMissPrevented: 0,
        notes: 'Scheduled for Phase 4 evaluation',
    },
    week2: {
        label: 'Week 2',
        dates: 'TBD',
        yieldRate: 0,
        nearMissPrevented: 0,
        notes: 'Scheduled for Phase 4 evaluation',
    }
};

// Stat card computed values
const NEAR_MISS_PREVENTED = 0;
const DRIVER_YIELD = 0;  // % this week

// ─── Stat Cards ──────────────────────────────────────────────────────────────

function renderStatCards() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('comp-yield-rate', DRIVER_YIELD + '%');
    set('comp-near-miss', NEAR_MISS_PREVENTED);
}

// ─── Empty-State Plugin ─────────────────────────────────────────────────────

const emptyStatePlugin = {
    id: 'emptyStateMessage',
    afterDraw(chart) {
        const hasData = chart.data.datasets.some(ds =>
            ds.data.some(v => v !== null && v !== 0)
        );
        if (hasData) return;

        const { ctx, chartArea: { left, right, top, bottom } } = chart;
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = "500 13px 'Inter', system-ui, sans-serif";
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillText('No data yet \u2014 awaiting field deployment', cx, cy);
        ctx.restore();
    }
};

// ─── Yield Trend Line Chart ─────────────────────────────────────────────────

function renderYieldTrendChart() {
    const ctx = document.getElementById('chart-compliance-trend');
    if (!ctx || !window.Chart) return;

    if (complianceTrendChart) complianceTrendChart.destroy();
    complianceTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: COMPLIANCE_DAYS,
            datasets: [
                {
                    label: 'Site 1 Yield Rate',
                    data: YIELD_WEEK1,
                    borderColor: '#4ade80',
                    backgroundColor: 'rgba(74, 222, 128, 0.08)',
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointBackgroundColor: '#4ade80',
                    pointBorderColor: '#0a0a0a',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    tension: 0.35,
                    fill: true,
                    spanGaps: false,
                },
                {
                    label: 'Site 2 Yield Rate',
                    data: YIELD_WEEK2,
                    borderColor: '#60a5fa',
                    backgroundColor: 'rgba(96, 165, 250, 0.08)',
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointBackgroundColor: '#60a5fa',
                    pointBorderColor: '#0a0a0a',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    tension: 0.35,
                    fill: true,
                    spanGaps: false,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,10,10,0.92)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: item => ` ${item.dataset.label}: ${item.raw}%`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                    ticks: { font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
                    border: { dash: [4, 4] },
                    beginAtZero: true,
                    min: 0,
                    max: 100,
                    ticks: { stepSize: 20, callback: v => v + '%' }
                }
            },
            animation: { duration: 1000, easing: 'easeOutQuart' }
        },
        plugins: [emptyStatePlugin]
    });
}

// ─── Near-Miss Reduction Bar Chart ───────────────────────────────────────────

function renderNearMissChart() {
    const ctx = document.getElementById('chart-near-miss');
    if (!ctx || !window.Chart) return;

    if (nearMissChart) nearMissChart.destroy();
    nearMissChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: NEAR_MISS_LABELS,
            datasets: [
                {
                    label: 'Before SWiPS',
                    data: NEAR_MISS_BEFORE,
                    backgroundColor: 'rgba(239, 68, 68, 0.65)',
                    borderRadius: 4,
                    borderSkipped: false,
                },
                {
                    label: 'After SWiPS',
                    data: NEAR_MISS_AFTER,
                    backgroundColor: 'rgba(74, 222, 128, 0.75)',
                    borderRadius: 4,
                    borderSkipped: false,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,10,10,0.92)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: item => ` ${item.dataset.label}: ${item.raw} incidents`
                    }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false }, ticks: { font: { size: 11 } } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
                    border: { dash: [4, 4] },
                    beginAtZero: true,
                    min: 0,
                    max: 10,
                    suggestedMax: 10,
                    ticks: { stepSize: 2 }
                }
            },
            animation: { duration: 900, easing: 'easeOutQuart' }
        },
        plugins: [emptyStatePlugin]
    });
}

// ─── Deployment Comparison ───────────────────────────────────────────────────

function renderDeployment() {
    ['week1', 'week2'].forEach(key => {
        const d = DEPLOYMENT[key];
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set(`deploy-${key}-dates`, d.dates);
        set(`deploy-${key}-yield`, d.yieldRate + '%');
        set(`deploy-${key}-nearmiss`, d.nearMissPrevented);
        set(`deploy-${key}-notes`, d.notes);
    });
}

// ─── Public Init ─────────────────────────────────────────────────────────────

export function initCompliance() {
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
    } else {
        _render();
    }
}

function _render() {
    if (window.lucide) window.lucide.createIcons();
    renderStatCards();
    renderYieldTrendChart();
    renderNearMissChart();
    renderDeployment();
    complianceInitialized = true;
}
