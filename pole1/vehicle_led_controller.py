#!/usr/bin/env python3
"""SWiPS vehicle-facing LED controller — Pole 1.

Drives a 3-color relay/tower light off live FSM state from MQTT.
GREEN = IDLE, RED = CROSSING (after a brief YELLOW ready window),
YELLOW = ready/caution transition + connection-loss fail-safe.
OBSTRUCTION does not change the light — snapshot-only, light stays RED.

Max-red fail-safe: if RED holds continuously past MAX_RED_SECONDS
(e.g. nonstop pedestrian flow with no gap), the light warns with
YELLOW, then forces a short GREEN gap (FORCE_GREEN_SECONDS) for
waiting vehicles, then warns YELLOW again before returning to RED if
pedestrians are still crossing. Repeats as long as CROSSING persists.

Forced-gap cycle: RED --(MAX_RED_SECONDS)--> YELLOW --(READY_WINDOW_SECONDS)-->
GREEN --(FORCE_GREEN_SECONDS)--> YELLOW --(READY_WINDOW_SECONDS)--> RED --> repeat

Display sync: while the forced-gap cycle is active (vehicles get a
green light even though pedestrians are still in the CROSSING state),
this controller publishes a retained {"forced_gap": true/false} message
on LED_OVERRIDE_TOPIC so display_controller.py can stop telling
pedestrians "CROSS NOW" during that window — otherwise the two signs
contradict each other.
"""

import os
import json
import signal
import sys
import threading
from gpiozero import OutputDevice
import paho.mqtt.client as mqtt

PIN_GREEN = int(os.environ.get("SWIPS_LED_PIN_GREEN", 17))
PIN_RED = int(os.environ.get("SWIPS_LED_PIN_RED", 27))
PIN_YELLOW = int(os.environ.get("SWIPS_LED_PIN_YELLOW", 22))
RELAY_ACTIVE_LOW = os.environ.get("SWIPS_RELAY_ACTIVE_LOW", "true").lower() != "false"
READY_WINDOW_SECONDS = float(os.environ.get("SWIPS_READY_WINDOW_SECONDS", 1.2))
MAX_RED_SECONDS = float(os.environ.get("SWIPS_MAX_RED_SECONDS", 60))
FORCE_GREEN_SECONDS = float(os.environ.get("SWIPS_FORCE_GREEN_SECONDS", 5))

MQTT_HOST = os.environ.get("SWIPS_MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("SWIPS_MQTT_PORT", 1883))
MQTT_TOPIC = os.environ.get("SWIPS_MQTT_TOPIC", "swips/detection")
LED_OVERRIDE_TOPIC = os.environ.get("SWIPS_LED_OVERRIDE_TOPIC", "swips/led_override")

STATE_COLOR = {"IDLE": "GREEN", "CROSSING": "RED"}
FAILSAFE = "YELLOW"

active_high = not RELAY_ACTIVE_LOW
relays = {
    "GREEN": OutputDevice(PIN_GREEN, active_high=active_high, initial_value=False),
    "RED": OutputDevice(PIN_RED, active_high=active_high, initial_value=False),
    "YELLOW": OutputDevice(PIN_YELLOW, active_high=active_high, initial_value=False),
}

current = None
current_mode = None
ready_timer = None
max_red_timer = None
forced_gap = False
timer_lock = threading.Lock()
mqtt_client = None


def publish_forced_gap(value):
    """Tell the display whether vehicles currently have a forced green
    gap, so it can stop showing CROSS NOW during that window."""
    global forced_gap
    if value == forced_gap:
        return
    forced_gap = value
    if mqtt_client is not None:
        try:
            mqtt_client.publish(
                LED_OVERRIDE_TOPIC,
                json.dumps({"forced_gap": value}),
                retain=True,
            )
        except Exception as e:
            print(f"[vehicle_led] failed to publish forced_gap: {e}", flush=True)


def set_color(color):
    global current
    if color == current:
        return
    relays["GREEN"].on() if color == "GREEN" else relays["GREEN"].off()
    relays["RED"].on() if color == "RED" else relays["RED"].off()
    relays["YELLOW"].off() if color == "YELLOW" else relays["YELLOW"].on()
    current = color
    print(f"[vehicle_led] -> {color}", flush=True)


def _enter_red():
    """Normal entry into RED (from the IDLE->CROSSING ready window,
    or looping back after a forced green gap). Starts the max-red
    watchdog fresh each time RED begins, and clears the forced-gap
    flag since vehicles are back to a real stop."""
    global ready_timer, max_red_timer
    with timer_lock:
        ready_timer = None
    publish_forced_gap(False)
    set_color("RED")
    with timer_lock:
        max_red_timer = threading.Timer(MAX_RED_SECONDS, _warn_before_green)
        max_red_timer.daemon = True
        max_red_timer.start()


def _warn_before_green():
    """Max-red hit. Warn drivers with YELLOW before actually opening
    the gap, same as a real signal's red->green isn't instant either.
    Pedestrian display is told about the upcoming gap now so it can
    switch away from CROSS NOW before the vehicle light turns green."""
    global max_red_timer
    print(f"[vehicle_led] max-red ({MAX_RED_SECONDS}s) hit — warning before forced GREEN gap", flush=True)
    publish_forced_gap(True)
    set_color("YELLOW")
    with timer_lock:
        max_red_timer = threading.Timer(READY_WINDOW_SECONDS, _force_green_gap)
        max_red_timer.daemon = True
        max_red_timer.start()


def _force_green_gap():
    global max_red_timer
    set_color("GREEN")
    with timer_lock:
        if current_mode in ("CROSSING", "OBSTRUCTION"):
            max_red_timer = threading.Timer(FORCE_GREEN_SECONDS, _warn_before_red)
            max_red_timer.daemon = True
            max_red_timer.start()
        else:
            max_red_timer = None
            publish_forced_gap(False)


def _warn_before_red():
    """Forced GREEN gap is ending. Warn drivers YELLOW before RED
    comes back on, then loop into _enter_red which restarts the
    max-red watchdog and clears the forced-gap flag."""
    global max_red_timer
    set_color("YELLOW")
    with timer_lock:
        max_red_timer = threading.Timer(READY_WINDOW_SECONDS, _enter_red)
        max_red_timer.daemon = True
        max_red_timer.start()


def on_connect(client, userdata, flags, rc):
    print(f"[vehicle_led] connected to {MQTT_HOST}:{MQTT_PORT} rc={rc}", flush=True)
    client.subscribe(MQTT_TOPIC)
    # Publish a fresh, non-retained-stale baseline on every (re)connect
    # so the display never gets stuck on a forced_gap=true from a prior
    # crashed session.
    publish_forced_gap(False)


def on_disconnect(client, userdata, rc):
    global current_mode, ready_timer, max_red_timer
    print("[vehicle_led] MQTT disconnected — holding fail-safe", flush=True)
    with timer_lock:
        if ready_timer is not None:
            ready_timer.cancel()
            ready_timer = None
        if max_red_timer is not None:
            max_red_timer.cancel()
            max_red_timer = None
    current_mode = None
    set_color(FAILSAFE)


def on_message(client, userdata, msg):
    global current_mode, ready_timer, max_red_timer
    try:
        mode = json.loads(msg.payload.decode()).get("mode", "").upper()
    except (ValueError, AttributeError):
        mode = ""

    if not mode or mode == current_mode:
        return

    with timer_lock:
        if ready_timer is not None:
            ready_timer.cancel()
            ready_timer = None
        if mode == "IDLE" and max_red_timer is not None:
            max_red_timer.cancel()
            max_red_timer = None
            publish_forced_gap(False)

        if mode == "CROSSING" and current_mode == "IDLE":
            set_color("YELLOW")
            ready_timer = threading.Timer(READY_WINDOW_SECONDS, _enter_red)
            ready_timer.daemon = True
            ready_timer.start()
        elif mode == "OBSTRUCTION":
            pass
        else:
            set_color(STATE_COLOR.get(mode, FAILSAFE))

    current_mode = mode


def cleanup(*_):
    with timer_lock:
        if ready_timer is not None:
            ready_timer.cancel()
        if max_red_timer is not None:
            max_red_timer.cancel()
    publish_forced_gap(False)
    for relay in relays.values():
        relay.off()
    sys.exit(0)


signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

set_color(FAILSAFE)

try:
    mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
except AttributeError:
    mqtt_client = mqtt.Client()

mqtt_client.on_connect = on_connect
mqtt_client.on_disconnect = on_disconnect
mqtt_client.on_message = on_message
mqtt_client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
mqtt_client.loop_forever()
