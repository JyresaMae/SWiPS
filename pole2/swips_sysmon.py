#!/usr/bin/env python3
"""
SWiPS System Monitor — Pole 2
Publishes real hardware stats to swips/system every 5s.
No detection, no camera — just Pi vitals.
"""
import json, time, psutil, subprocess
import paho.mqtt.client as mqtt

POLE_ID   = "pole-2"
POLE_LOC  = "msu-iit-crosswalk"
MQTT_HOST = "localhost"
MQTT_PORT = 1883
MQTT_TOPIC = "swips/system"
INTERVAL  = 5

def cpu_temp():
    try:
        out = subprocess.check_output(["vcgencmd", "measure_temp"]).decode()
        return float(out.strip().replace("temp=","").replace("'C",""))
    except:
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                return round(int(f.read()) / 1000, 1)
        except:
            return 0.0

def battery_voltage():
    # Nominal charger voltage — ADC not yet wired
    return 12.6

mc = mqtt.Client(client_id=f"swips-sysmon-{POLE_ID}")

def on_connect(client, userdata, flags, rc):
    print(f"[SYSMON] MQTT connected (rc={rc})")

mc.on_connect = on_connect

print(f"[SYSMON] Starting system monitor for {POLE_ID}")
mc.connect(MQTT_HOST, MQTT_PORT, 60)
mc.loop_start()

boot_t = time.time()

while True:
    try:
        temp    = cpu_temp()
        cpu_pct = psutil.cpu_percent(interval=1)
        mem_pct = round(psutil.virtual_memory().percent, 1)
        uptime  = round(time.time() - boot_t, 1)

        payload = {
            "node":          POLE_ID,
            "location":      POLE_LOC,
            "mode":          "DISPLAY",
            "fps":           0.0,
            "uptimeSeconds": uptime,
            "cpuTemp":       temp,
            "cpuUsage":      cpu_pct,
            "memoryUsage":   mem_pct,
            "batteryVoltage": battery_voltage(),
            "batteryPercent": 0,
            "timestamp":     __import__('datetime').datetime.now().isoformat(),
        }

        mc.publish(MQTT_TOPIC, json.dumps(payload))
        print(f"[SYSMON] Published: CPU={cpu_pct}% Temp={temp}°C Mem={mem_pct}%")
        time.sleep(INTERVAL)

    except Exception as e:
        print(f"[SYSMON] Error: {e}")
        time.sleep(5)
