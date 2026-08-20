#!/usr/bin/env python3
"""SWiPS vehicle-facing LED controller — Pole 1.

Drives a 3-color relay/tower light off live FSM state from MQTT.
GREEN = IDLE, RED = CROSSING, YELLOW = OBSTRUCTION / fail-safe.

TODO before trusting this: PIN_GREEN/PIN_RED/PIN_YELLOW and
RELAY_ACTIVE_LOW below are placeholders — confirm against Pole 1's
actual wiring. Also confirm the MQTT payload really has a "state"
key shaped like this; it was assumed, not verified.
"""

import os
import json
import signal
import sys
from gpiozero import OutputDevice
import paho.mqtt.client as mqtt

PIN_GREEN = int(os.environ.get("SWIPS_LED_PIN_GREEN", 17))
PIN_RED = int(os.environ.get("SWIPS_LED_PIN_RED", 27))
PIN_YELLOW = int(os.environ.get("SWIPS_LED_PIN_YELLOW", 22))
RELAY_ACTIVE_LOW = os.environ.get("SWIPS_RELAY_ACTIVE_LOW", "true").lower() != "false"

MQTT_HOST = os.environ.get("SWIPS_MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("SWIPS_MQTT_PORT", 1883))
MQTT_TOPIC = os.environ.get("SWIPS_MQTT_TOPIC", "swips/detection")

STATE_COLOR = {"IDLE": "GREEN", "CROSSING": "RED", "OBSTRUCTION": "YELLOW"}
FAILSAFE = "YELLOW"

active_high = not RELAY_ACTIVE_LOW
relays = {
    "GREEN": OutputDevice(PIN_GREEN, active_high=active_high, initial_value=False),
    "RED": OutputDevice(PIN_RED, active_high=active_high, initial_value=False),
    "YELLOW": OutputDevice(PIN_YELLOW, active_high=active_high, initial_value=False),
}

current = None


def set_color(color):
    global current
    if color == current:
        return
    # GREEN/RED energize their own relay to show their color.
    # YELLOW is on NC, so its relay must be ENERGIZED to HIDE yellow —
    # energized in every state except when we actually want yellow.
    relays["GREEN"].on() if color == "GREEN" else relays["GREEN"].off()
    relays["RED"].on() if color == "RED" else relays["RED"].off()
    relays["YELLOW"].off() if color == "YELLOW" else relays["YELLOW"].on()
    current = color
    print(f"[vehicle_led] -> {color}", flush=True)


def on_connect(client, userdata, flags, rc):
    print(f"[vehicle_led] connected to {MQTT_HOST}:{MQTT_PORT} rc={rc}", flush=True)
    client.subscribe(MQTT_TOPIC)


def on_disconnect(client, userdata, rc):
    print("[vehicle_led] MQTT disconnected — holding fail-safe", flush=True)
    set_color(FAILSAFE)


def on_message(client, userdata, msg):
    try:
        state = json.loads(msg.payload.decode()).get("mode", "").upper()
    except (ValueError, AttributeError):
        state = ""
    set_color(STATE_COLOR.get(state, FAILSAFE))


def cleanup(*_):
    for relay in relays.values():
        relay.off()
    sys.exit(0)


signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

set_color(FAILSAFE)

try:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
except AttributeError:
    client = mqtt.Client()

client.on_connect = on_connect
client.on_disconnect = on_disconnect
client.on_message = on_message
client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
client.loop_forever()