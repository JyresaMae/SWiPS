#!/usr/bin/env python3
"""
SWiPS Display Controller — Canonical 3-State Pedestrian Advisory
================================================================
Renders the locked 3-state pedestrian-advisory display on the
Arzopa portable monitor via pygame + KMSDRM (headless framebuffer).

Locked spec (April 26, pedestrian-advisory pivot):

  | State        | Color               | Text              | Behavior  |
  |--------------|---------------------|-------------------|-----------|
  | IDLE         | black + SWiPS logo  | SYSTEM MONITORING | steady    |
  | CROSSING     | green 100%          | SAFE TO CROSS     | steady    |
  | OBSTRUCTION  | red 60%, 2 Hz       | DON'T CROSS   | flashing  |

Audience: pedestrians (RA 4136 already covers drivers).

Subscribes to MQTT topic `swips/detection`. Reads the `mode` field.
The detection script's three-state output (IDLE / CROSSING / OBSTRUCTION)
maps directly to these display states. Any unrecognized mode falls
back to IDLE.

Stale-data safety: if no MQTT message arrives for STALE_TIMEOUT_S
seconds, we revert to IDLE so the display never shows green when
the detector has crashed.

Run as root:
    sudo python3 display_controller.py

Requires: pygame, paho-mqtt
"""

import os
import sys
import json
import time
import signal
import threading

import pygame

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("[ERROR] paho-mqtt not installed.")
    print("        Run: sudo pip3 install paho-mqtt --break-system-packages")
    sys.exit(1)


# ── Configuration ─────────────────────────────────────────────────
# MQTT
MQTT_HOST       = "127.0.0.1"           # local broker on this pole
MQTT_PORT       = 1883
MQTT_TOPIC      = "swips/detection"
MQTT_CLIENT_ID  = f"swips-display-{os.uname().nodename}"

# Files
LOGO_PATH       = "/home/pi/swips_project/SWiPS_logo.png"

# Behavior
FLASH_HZ        = 2          # OBSTRUCTION flash rate
FPS_CAP         = 10         # render loop cap
STALE_TIMEOUT_S = 3.0        # if no MQTT in this long, force IDLE
FONT_NAME       = None       # None = pygame default

# Brightness scaling (multiplicative on RGB)
RED_BRIGHTNESS    = 0.60     # OBSTRUCTION: red @ 60%
GREEN_BRIGHTNESS  = 1.00     # CROSSING:    green @ 100%

# ── Force KMSDRM (headless Pi 5, no X server) ─────────────────────
# Pole 1 uses HDMI-A-2 (index 1). Pole 2 may use a different index;
# override via env var if needed:
#   sudo SDL_VIDEO_KMSDRM_DEVICE_INDEX=0 python3 display_controller.py
os.environ.setdefault("SDL_VIDEODRIVER", "kmsdrm")
os.environ.setdefault("SDL_VIDEO_KMSDRM_DEVICE_INDEX", "1")

# ── Colors (pre-scaled by brightness) ─────────────────────────────
def scale(rgb, factor):
    return tuple(int(c * factor) for c in rgb)

BLACK         = (0, 0, 0)
WHITE         = (255, 255, 255)
GRAY          = (110, 110, 110)
GREEN_FULL    = scale((0, 200, 0),   GREEN_BRIGHTNESS)   # CROSSING bg
RED_DIM       = scale((220, 30, 30), RED_BRIGHTNESS)     # OBSTRUCTION bg
RED_OFF       = (40, 8, 8)                                # OBSTRUCTION flash-off frame


# ── Shared state (MQTT thread writes, render loop reads) ──────────
class DisplayState:
    def __init__(self):
        self.lock = threading.Lock()
        self.mode = "IDLE"
        self.last_update = 0.0   # 0 means "no message ever"

    def update(self, mode):
        with self.lock:
            self.mode = mode
            self.last_update = time.time()

    def get(self):
        with self.lock:
            age = time.time() - self.last_update if self.last_update > 0 else float("inf")
            return self.mode, age


state = DisplayState()
running = True

# Pre-rendered frame cache. Populated on first render of each state and
# reused every loop iteration so we're not re-rasterizing 280pt fonts
# at 30 FPS, which Pi 5 software-SDL can't keep up with.
_frame_cache = {}


# ── MQTT callbacks ────────────────────────────────────────────────
def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[MQTT] Connected to {MQTT_HOST}:{MQTT_PORT}")
        client.subscribe(MQTT_TOPIC)
        print(f"[MQTT] Subscribed to {MQTT_TOPIC}")
    else:
        print(f"[MQTT] Connection failed (rc={rc})")


def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        raw = str(data.get("mode", "IDLE")).upper()
        # Normalize legacy variants — current detection only emits the
        # canonical three, but old scripts emitted CROSSING_1_4 etc.
        if raw.startswith("CROSSING"):
            mode = "CROSSING"
        elif raw == "OBSTRUCTION":
            mode = "OBSTRUCTION"
        else:
            mode = "IDLE"
        state.update(mode)
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError) as e:
        print(f"[MQTT] Bad message: {e}")


# ── Render functions ──────────────────────────────────────────────
def render_idle(screen, W, H, logo, fonts):
    """IDLE: black background, centered SWiPS logo, 'SYSTEM MONITORING' below."""
    cached = _frame_cache.get("idle")
    if cached is None:
        frame = pygame.Surface((W, H))
        frame.fill(BLACK)
        if logo is not None:
            lw, lh = logo.get_size()
            logo_y = (H - lh) // 2 - 50
            frame.blit(logo, ((W - lw) // 2, logo_y))
            tagline_y = logo_y + lh + 40
        else:
            wm = fonts["mega"].render("SWiPS", True, WHITE)
            frame.blit(wm, wm.get_rect(center=(W // 2, H // 2 - 40)))
            tagline_y = H // 2 + 80
        tagline = fonts["large"].render("SYSTEM MONITORING", True, GRAY)
        frame.blit(tagline, tagline.get_rect(center=(W // 2, tagline_y)))
        _frame_cache["idle"] = frame
        cached = frame
        print("[DISPLAY] Cached IDLE frame")
    screen.blit(cached, (0, 0))

def render_crossing(screen, W, H, fonts):
    """CROSSING: solid green, 'CROSS NOW' centered. Cached."""
    cached = _frame_cache.get("crossing")
    if cached is None:
        frame = pygame.Surface((W, H))
        frame.fill(GREEN_FULL)
        _draw_two_word_label(frame, W, H, fonts, "CROSS", "NOW", WHITE)
        _frame_cache["crossing"] = frame
        cached = frame
        print("[DISPLAY] Cached CROSSING frame")

    screen.blit(cached, (0, 0))


def render_obstruction(screen, W, H, fonts, on_phase):
    """OBSTRUCTION: display unchanged — monitor stays on CROSS NOW.
    Dashboard alert and snapshot logic in server.js handles this state.
    """
    pass  # intentionally blank — monitor stays on previous state


def _draw_two_word_label(surface, W, H, fonts, line1_text, line2_text, color):
    """Render two stacked lines onto `surface`, auto-shrinking each to fit width.

    Called only when building a cached frame — not per render loop iteration.
    """
    margin = 20  # px from each side
    max_w = W - 2 * margin

    line1 = fonts["mega"].render(line1_text, True, color)
    line2 = fonts["mega"].render(line2_text, True, color)

    if line1.get_width() > max_w:
        s = max_w / line1.get_width()
        line1 = pygame.transform.smoothscale(
            line1, (int(line1.get_width() * s), int(line1.get_height() * s))
        )
    if line2.get_width() > max_w:
        s = max_w / line2.get_width()
        line2 = pygame.transform.smoothscale(
            line2, (int(line2.get_width() * s), int(line2.get_height() * s))
        )

    gap = 30
    total_h = line1.get_height() + gap + line2.get_height()
    y_start = (H - total_h) // 2

    surface.blit(line1, line1.get_rect(
        center=(W // 2, y_start + line1.get_height() // 2)))
    surface.blit(line2, line2.get_rect(
        center=(W // 2, y_start + line1.get_height() + gap + line2.get_height() // 2)))


# ── Main loop ─────────────────────────────────────────────────────
def main():
    global running

    def handle_signal(sig, frame):
        global running
        running = False
    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    print("[DISPLAY] Initializing pygame (KMSDRM)...")
    pygame.init()
    screen = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
    W, H = screen.get_size()
    print(f"[DISPLAY] Screen: {W}x{H}")
    pygame.mouse.set_visible(False)
    clock = pygame.time.Clock()

    # Fonts. mega is for the two-word state labels; auto-scales down
    # if too wide for the screen.
    fonts = {
        "mega":   pygame.font.Font(FONT_NAME, 360),
        "large":  pygame.font.Font(FONT_NAME, 96),
        "medium": pygame.font.Font(FONT_NAME, 56),
        "small":  pygame.font.Font(FONT_NAME, 36),
    }

    # Load logo with text fallback
    logo = None
    if os.path.exists(LOGO_PATH):
        try:
            raw = pygame.image.load(LOGO_PATH).convert_alpha()
            max_h = 900
            scale_factor = min(max_h / raw.get_height(), 1.0)
            new_size = (int(raw.get_width() * scale_factor),
                        int(raw.get_height() * scale_factor))
            logo = pygame.transform.smoothscale(raw, new_size)
            print(f"[DISPLAY] Logo loaded: {LOGO_PATH} "
                  f"({new_size[0]}x{new_size[1]})")
        except Exception as e:
            print(f"[DISPLAY] Logo load failed: {e} — text fallback")
    else:
        print(f"[DISPLAY] Logo not found at {LOGO_PATH} — text fallback")

    # MQTT
    print("[MQTT] Connecting...")
    mc = mqtt.Client(client_id=MQTT_CLIENT_ID)
    mc.on_connect = on_connect
    mc.on_message = on_message
    try:
        mc.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    except Exception as e:
        print(f"[MQTT] Initial connect failed: {e} — will keep retrying")
    mc.loop_start()

    print("[DISPLAY] Render loop started")
    prev_logged_mode = None
    frame_count = 0
    last_debug_log = 0.0

    try:
        while running:
            # Pump pygame events so the OS doesn't think we've hung
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                    running = False

            mode, age = state.get()

            # Stale-data safety: revert to IDLE if no MQTT for too long
            if age > STALE_TIMEOUT_S and mode != "IDLE":
                if prev_logged_mode != "IDLE_STALE":
                    print(f"[DISPLAY] No MQTT for {age:.1f}s — forcing IDLE")
                    prev_logged_mode = "IDLE_STALE"
                effective_mode = "IDLE"
            else:
                effective_mode = mode

            if effective_mode != prev_logged_mode and prev_logged_mode != "IDLE_STALE":
                print(f"[DISPLAY] State -> {effective_mode}")
                prev_logged_mode = effective_mode

            # Render based on effective state
            if effective_mode == "CROSSING":
                render_crossing(screen, W, H, fonts)
            elif effective_mode == "OBSTRUCTION":
                # 2 Hz flash → on-phase for first half of each cycle
                cycle = 1.0 / FLASH_HZ
                on_phase = (time.time() % cycle) < (cycle / 2)
                render_obstruction(screen, W, H, fonts, on_phase)
            else:
                render_idle(screen, W, H, logo, fonts)

            pygame.display.flip()
            clock.tick(FPS_CAP)
            frame_count += 1

            # Heartbeat every ~2s so we can see the loop is alive and what it's drawing
            now = time.time()
            if now - last_debug_log >= 2.0:
                print(f"[DEBUG] frame={frame_count} mode={effective_mode} "
                      f"raw_mode={mode} age={age:.1f}s fps≈{FPS_CAP}")
                last_debug_log = now

    finally:
        print("[DISPLAY] Shutting down...")
        try:
            mc.loop_stop()
            mc.disconnect()
        except Exception:
            pass
        pygame.quit()
        print("[DISPLAY] Bye.")


if __name__ == "__main__":
    main()
