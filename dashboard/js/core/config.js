// ═══════════════════════════════════════════════════════════════
// SWiPS Edge Config — Everything runs on the Pi
// File: js/core/config.js
// ═══════════════════════════════════════════════════════════════

const HOST = window.location.hostname;
const PORT = window.location.port;
const BASE = PORT ? `${HOST}:${PORT}` : HOST;

export const CONFIG = {
  API_BASE: `http://${BASE}/api`,
  WS_URL:   `ws://${BASE}/ws`,

  ENDPOINTS: {
    live:           '/live',
    health:         '/health',
    hourly:         '/analytics/hourly',
    weekly:         '/analytics/weekly',
    modes:          '/analytics/modes',
    alertsToday:    '/alerts/today',
    alertsWeekly:   '/alerts/weekly',
    systemHistory:  '/system/history',
    export:         '/export',
  },

  POLL_INTERVAL: 5000,
};
