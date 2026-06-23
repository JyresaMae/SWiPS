/**
 * SWiPS – Settings Section
 * Admin panel with 5 settings groups, localStorage persistence, and toast notifications.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
    // System Configuration
    detectionSensitivity: 55,
    obstructionTimer: 30,
    smallGroupMax: 4,
    largeGroupMin: 5,
    cameraFps: '10',

    // Alert Settings
    gpsDisplacementAlert: true,
    displacementThreshold: 5,
    alertSound: true,
    criticalAutoEscalation: 60,

    // LED Panel Settings
    idleBrightness: 60,
    crossingBrightness: 85,
    obstructionBrightness: 100,
    obstructionFlashRate: '2',
    panelSyncTolerance: 10,

    // Dashboard Preferences
    darkMode: true,
    autoRefreshInterval: '3',
    timezone: 'Asia/Manila',
    language: 'en',

    // Account & Security
    sessionTimeout: '30',
};

const STORAGE_KEY = 'swips_settings';

// ─── Simulated Login Activity ────────────────────────────────────────────────

const LOGIN_ACTIVITY = [
    { timestamp: '2026-03-01 14:02:11', ip: '192.168.1.105', status: 'Success' },
    { timestamp: '2026-03-01 12:45:33', ip: '192.168.1.105', status: 'Success' },
    { timestamp: '2026-02-28 22:18:07', ip: '10.0.0.42', status: 'Failed' },
    { timestamp: '2026-02-28 09:30:55', ip: '192.168.1.105', status: 'Success' },
    { timestamp: '2026-02-27 16:12:40', ip: '192.168.1.210', status: 'Success' },
];

// ─── State ───────────────────────────────────────────────────────────────────

let settings = {};
let settingsInitialized = false;

function loadSettings() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        settings = stored ? { ...DEFAULTS, ...JSON.parse(stored) } : { ...DEFAULTS };
    } catch {
        settings = { ...DEFAULTS };
    }
}

function saveGroupToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ─── Toast Notification ──────────────────────────────────────────────────────

function showToast(message, type = 'success') {
    // Remove existing toast
    const existing = document.querySelector('.settings-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `settings-toast settings-toast-${type}`;
    toast.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            ${type === 'success'
            ? '<polyline points="20 6 9 17 4 12"></polyline>'
            : '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>'}
        </svg>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function bindSlider(id, settingsKey, suffix = '%') {
    const slider = el(id);
    const display = el(id + '-val');
    if (!slider || !display) return;

    slider.value = settings[settingsKey];
    display.textContent = settings[settingsKey] + suffix;

    slider.addEventListener('input', () => {
        settings[settingsKey] = parseInt(slider.value);
        display.textContent = slider.value + suffix;
    });
}

function bindToggle(id, settingsKey) {
    const toggle = el(id);
    if (!toggle) return;

    toggle.checked = settings[settingsKey];

    toggle.addEventListener('change', () => {
        settings[settingsKey] = toggle.checked;
    });
}

function bindSelect(id, settingsKey) {
    const select = el(id);
    if (!select) return;

    select.value = settings[settingsKey];

    select.addEventListener('change', () => {
        settings[settingsKey] = select.value;
    });
}

function bindNumber(id, settingsKey) {
    const input = el(id);
    if (!input) return;

    input.value = settings[settingsKey];

    input.addEventListener('change', () => {
        settings[settingsKey] = parseInt(input.value) || settings[settingsKey];
    });
}

function bindSaveButton(btnId) {
    const btn = el(btnId);
    if (!btn) return;

    btn.addEventListener('click', () => {
        saveGroupToStorage();
        showToast('Settings Saved');
    });
}

// ─── Render Login Activity Table ─────────────────────────────────────────────

function renderLoginTable() {
    const tbody = el('login-activity-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    LOGIN_ACTIVITY.forEach(row => {
        const statusClass = row.status === 'Success' ? 'stg-status-success' : 'stg-status-failed';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="stg-td">${row.timestamp}</td>
            <td class="stg-td stg-ip">${row.ip}</td>
            <td class="stg-td"><span class="stg-status-badge ${statusClass}">${row.status}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

// ─── Password Change Handler ─────────────────────────────────────────────────

function bindPasswordForm() {
    const btn = el('save-password-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const current = el('current-password');
        const newPw = el('new-password');
        const confirm = el('confirm-password');

        if (!current.value || !newPw.value || !confirm.value) {
            showToast('Please fill in all password fields', 'error');
            return;
        }

        if (newPw.value !== confirm.value) {
            showToast('New passwords do not match', 'error');
            return;
        }

        if (newPw.value.length < 6) {
            showToast('Password must be at least 6 characters', 'error');
            return;
        }

        // Simulate save
        current.value = '';
        newPw.value = '';
        confirm.value = '';
        showToast('Password Updated Successfully');
    });
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initSettings() {
    if (settingsInitialized) return;

    loadSettings();

    // System Configuration
    bindSlider('stg-detection-sensitivity', 'detectionSensitivity');
    bindNumber('stg-obstruction-timer', 'obstructionTimer');
    bindNumber('stg-small-group', 'smallGroupMax');
    bindNumber('stg-large-group', 'largeGroupMin');
    bindSelect('stg-camera-fps', 'cameraFps');
    bindSaveButton('save-system-config');

    // Alert Settings
    bindToggle('stg-gps-alert', 'gpsDisplacementAlert');
    bindSlider('stg-displacement-threshold', 'displacementThreshold', 'm');
    bindToggle('stg-alert-sound', 'alertSound');
    bindNumber('stg-escalation-timer', 'criticalAutoEscalation');
    bindSaveButton('save-alert-settings');

    // LED Panel Settings
    bindSlider('stg-idle-brightness', 'idleBrightness');
    bindSlider('stg-crossing-brightness', 'crossingBrightness');
    bindSlider('stg-obstruction-brightness', 'obstructionBrightness');
    bindSelect('stg-flash-rate', 'obstructionFlashRate');
    bindNumber('stg-sync-tolerance', 'panelSyncTolerance');
    bindSaveButton('save-led-settings');

    // Dashboard Preferences
    bindToggle('stg-dark-mode', 'darkMode');
    bindSelect('stg-auto-refresh', 'autoRefreshInterval');
    bindSelect('stg-timezone', 'timezone');
    bindSelect('stg-language', 'language');
    bindSaveButton('save-dashboard-prefs');

    // Account & Security
    bindSelect('stg-session-timeout', 'sessionTimeout');
    bindPasswordForm();
    renderLoginTable();
    bindSaveButton('save-account-security');

    // Re-render Lucide icons for the settings section
    if (window.lucide) window.lucide.createIcons();

    settingsInitialized = true;
}
