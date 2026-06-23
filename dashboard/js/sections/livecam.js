/**
 * livecam.js — Single-View Live Camera Feed with Pole Toggle
 *
 * Shows one JSMpeg player at a time. A toggle in the header lets the
 * user switch between Pole 1 and Pole 2. Only the active pole's
 * player is created; the other is destroyed to free WebSocket resources.
 */

let activePlayer = null;
let activePole = 'pole1';
let initialized = false;

// Detect network based on dashboard host, then pick correct Pole 2 address
const _dashHost = window.location.hostname;
const _isHotspot  = _dashHost.startsWith('10.42.0.');
const _isMSCA     = _dashHost.startsWith('10.10.79.');
const _pole2Addr = _isHotspot ? '10.42.0.2'
                  : _isMSCA    ? '10.10.79.136'
                  :              '10.42.0.2';  // fallback: assume hotspot

const STREAM_URLS = {
  pole1: 'ws://' + window.location.host + '/video',
  pole2: `ws://${_pole2Addr}:3000/video`,
};
const IP_LABELS = {
  pole1: window.location.hostname,
  pole2: _pole2Addr,
};

function createPlayer(canvasId, wsUrl) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof JSMpeg === 'undefined') {
    console.warn(`[LiveCam] Cannot create player: canvas=${canvasId}, JSMpeg=${typeof JSMpeg}`);
    return null;
  }

  try {
    return new JSMpeg.Player(wsUrl, {
      canvas: canvas,
      autoplay: true,
      audio: false,
      loop: true,
    });
  } catch (e) {
    console.error(`[LiveCam] JSMpeg init failed for ${canvasId}:`, e);
    return null;
  }
}

function destroyPlayer(player) {
  if (player) {
    try { player.destroy(); } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * Switch to the given pole ('pole1' or 'pole2').
 */
function switchToPole(pole) {
  if (pole === activePole && activePlayer) return;

  // Destroy current player
  activePlayer = destroyPlayer(activePlayer);

  // Toggle canvas visibility
  const canvas1 = document.getElementById('livecamCanvasPole1');
  const canvas2 = document.getElementById('livecamCanvasPole2');

  if (pole === 'pole1') {
    if (canvas1) canvas1.style.display = '';
    if (canvas2) canvas2.style.display = 'none';
    activePlayer = createPlayer('livecamCanvasPole1', STREAM_URLS.pole1);
  } else {
    if (canvas1) canvas1.style.display = 'none';
    if (canvas2) canvas2.style.display = '';
    activePlayer = createPlayer('livecamCanvasPole2', STREAM_URLS.pole2);
  }

  activePole = pole;

  // Update IP label
  const ipEl = document.getElementById('livecam-active-ip');
  if (ipEl) ipEl.textContent = IP_LABELS[pole];

  // Update status badge
  updateStatusBadge('livecam-status-active', activePlayer);

  // Update toggle button active states
  const toggleBtns = document.querySelectorAll('#livecamPoleToggle .livecam-toggle-btn');
  toggleBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pole === pole);
  });
}

export function initLiveCam() {
  if (initialized) return;

  console.log('[LiveCam] Initializing single-view camera feed...');

  // Bind toggle buttons
  const toggleWrap = document.getElementById('livecamPoleToggle');
  if (toggleWrap) {
    toggleWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.livecam-toggle-btn');
      if (!btn) return;
      switchToPole(btn.dataset.pole);
    });
  }

  // Start with Pole 1
  switchToPole('pole1');

  initialized = true;
}

export function destroyLiveCam() {
  if (!initialized) return;

  console.log('[LiveCam] Destroying camera feed...');
  activePlayer = destroyPlayer(activePlayer);
  initialized = false;
}

function updateStatusBadge(badgeId, player) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;

  if (player) {
    badge.textContent = 'Live';
    badge.classList.add('live');
    badge.classList.remove('offline');
  } else {
    badge.textContent = 'Offline';
    badge.classList.remove('live');
    badge.classList.add('offline');
  }
}
