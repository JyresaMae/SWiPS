import { initAuth } from './core/auth.js';
import { initRouter } from './core/router.js';
import { state } from './core/state.js';
import { connectWebSocket } from './core/api.js';  // ← EDGE ADDITION

// Global Elements
const globalElements = {
    headerDatetime: document.getElementById('headerDatetime'),
    badgeAnalytics: document.getElementById('badgeAnalytics'),
    badgeAlerts: document.getElementById('badgeAlerts'),
    navAlerts: document.getElementById('navAlerts'),
    statusPerformance: document.getElementById('statusPerformance'),
};

function init() {
    initAuth();
    initRouter();

    // ── Connect to Pi's WebSocket for live data ── EDGE ADDITION
    connectWebSocket();

    // Load Dashboard Dynamically (Fault Tolerance)
    import('./sections/dashboard.js')
        .then(module => module.initDashboard())
        .catch(err => console.error("Failed to load Dashboard section:", err));

    // Global Clock
    updateClock();
    setInterval(updateClock, 1000);

    // Global UI Loop (Sidebar, etc)
    setInterval(updateGlobalUI, 500); // Less frequent than dashboard

    // Initialize Lucide Icons
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

function updateClock() {
    const now = new Date();
    if (globalElements.headerDatetime) {
        globalElements.headerDatetime.textContent = now.toLocaleString('en-US', {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
        });
    }
}

function updateGlobalUI() {
    // 1. Analytics Badge
    if (globalElements.badgeAnalytics) {
        globalElements.badgeAnalytics.textContent = state.pedestriansToday;
    }

    // 2. Alerts Badge & Pulse
    if (globalElements.badgeAlerts && globalElements.navAlerts) {
        globalElements.badgeAlerts.textContent = state.activeAlerts;
        if (state.activeAlerts > 0) {
            globalElements.badgeAlerts.style.display = 'inline-block';
            globalElements.navAlerts.classList.add('has-alerts');
        } else {
            globalElements.badgeAlerts.style.display = 'none';
            globalElements.navAlerts.classList.remove('has-alerts');
        }
    }

    // 3. System Status Dot
    if (globalElements.statusPerformance) {
        // Simulate status based on FPS or Latency
        const isGood = state.fps > 8 && state.latencyMs < 100;
        if (isGood) globalElements.statusPerformance.classList.add('good');
        else globalElements.statusPerformance.classList.remove('good');
    }
}

// Start App
document.addEventListener('DOMContentLoaded', init);
