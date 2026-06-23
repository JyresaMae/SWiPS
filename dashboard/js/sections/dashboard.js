/**
 * SWiPS – Dashboard Section (LIVE DATA VERSION)
 *
 * CHANGES:
 *   ✂ Removed simulateLogic() — state updated by main.js WebSocket
 *   ✂ Removed simulateCrossingCycle() — crossing state from MQTT
 *   ✓ updateDashboardUI() identical — reads state.*
 *   ✓ Camera switcher identical
 *   ✓ Pedestrian dots identical
 */

import { state } from '../core/state.js';
import { animateValue } from '../utils/helpers.js';

const elements = {
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
    overlayTimer: document.getElementById('overlayTimer'),
    cameraStatus: document.getElementById('cameraStatus'),
    pedestriansToday: document.getElementById('pedestriansToday'),
    criticalAlertsToday: document.getElementById('criticalAlertsToday'),
    peakHour: document.getElementById('peakHour'),
    inferenceFps: document.getElementById('inferenceFps'),
};

export function initDashboard() {
    try { initCameraSwitcher(); } catch (e) { console.error('Init Camera Switcher failed:', e); }
    try { initPedestrianDots(); } catch (e) { console.error('Init Dots failed:', e); }

    setInterval(updateDashboardUI, 100);
    updateDashboardUI();
}

function updateDashboardUI() {
    if (!elements.crosswalkState) return;

    // ── Crosswalk State (with vehicle alert override) ──
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

    // ── Crossing Timer ──
    if (state.crossingState === 'IDLE') {
        elements.stateTimer.textContent = '00:00';
    } else if (state.crossingStart) {
        const diff = Math.floor((new Date() - state.crossingStart) / 1000);
        const mm = Math.floor(diff / 60).toString().padStart(2, '0');
        const ss = (diff % 60).toString().padStart(2, '0');
        elements.stateTimer.textContent = `${mm}:${ss}`;
        if (elements.overlayTimer) elements.overlayTimer.textContent = `${mm}:${ss}`;
    }

    elements.pedestriansNow.textContent = state.pedestriansNow;
    updatePedestrianDots(state.pedestriansNow);

    elements.latencyValue.textContent = state.latencyMs;
    const latencyPct = Math.min(100, Math.max(5, (state.latencyMs / 200) * 100));
    elements.latencyBar.style.width = `${latencyPct}%`;
    if (state.latencyMs < 100) elements.latencyBar.style.backgroundColor = 'var(--accent-green)';
    else elements.latencyBar.style.backgroundColor = 'var(--accent-amber)';

    // ── Active Alerts (from violation state) ──
    const totalAlerts = state.activeAlerts || 0;
    elements.activeAlerts.textContent = totalAlerts;

    // ── Safety Level (with critical pulse) ──
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

    elements.pedestriansToday.textContent = state.pedestriansToday;
    elements.criticalAlertsToday.textContent =
        state.violationsToday ? state.violationsToday.criticalAlerts : state.criticalAlertsToday;
    elements.inferenceFps.textContent = state.fps.toFixed(1);
}

function updatePedestrianDots(count) {
    const dots = elements.pedestrianDots.querySelectorAll('.pedestrian-dot');
    dots.forEach((dot, index) => {
        if (index < count) dot.classList.add('active');
        else dot.classList.remove('active');
    });
}

function initPedestrianDots() {
    elements.pedestrianDots.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const dot = document.createElement('div');
        dot.className = 'pedestrian-dot';
        elements.pedestrianDots.appendChild(dot);
    }
}

let currentPlayer = null;

function switchCamera(wsUrl) {
    const canvas = document.getElementById('videoCanvas');
    if (!canvas || typeof JSMpeg === 'undefined') return;
    if (currentPlayer) { try { currentPlayer.destroy(); } catch (_) {} currentPlayer = null; }
    try {
        currentPlayer = new JSMpeg.Player(wsUrl, { canvas, autoplay: true, audio: false, loop: true });
    } catch (e) { console.log('JSMpeg init failed', e); }
}

function initCameraSwitcher() {
    const btnPole1 = document.getElementById('camBtnPole1');
    const btnPole2 = document.getElementById('camBtnPole2');
    if (!btnPole1 || !btnPole2) return;
    function activate(btn) {
        [btnPole1, btnPole2].forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        switchCamera(btn.dataset.ws === 'DYNAMIC_POLE1' ? 'ws://' + window.location.host + '/video' : btn.dataset.ws);
    }
    btnPole1.addEventListener('click', () => activate(btnPole1));
    btnPole2.addEventListener('click', () => activate(btnPole2));
    activate(btnPole1);
}
