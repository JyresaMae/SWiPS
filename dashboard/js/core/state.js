export const state = {
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

    // ── Edge system fields (populated by api.js WebSocket) ──
    crosswalkCount: 0,
    pedestrianCount: 0,
    jaywalkerCount: 0,
    vehicleCount: 0,
    cpuTemp: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    batteryVoltage: 12.6,
    batteryPercent: 100,
    source: 'none',         // 'video' or 'camera'
    videoName: '',
    videoProgress: 0,
    lastAlertTime: null,
};
