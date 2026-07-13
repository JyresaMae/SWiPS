# SWiPS Setup Guide

Full setup guide for both poles from a fresh Raspberry Pi OS installation.

---

## Table of Contents

1. [Hardware Requirements](#1-hardware-requirements)
2. [Physical Assembly](#2-physical-assembly)
3. [OS Setup (Both Poles)](#3-os-setup-both-poles)
4. [Python Environment (Both Poles)](#4-python-environment-both-poles)
5. [Camera Setup (Both Poles)](#5-camera-setup-both-poles)
6. [Display Setup (Both Poles)](#6-display-setup-both-poles)
7. [Firewall and Port Configuration](#7-firewall-and-port-configuration)
8. [Pole 1 Setup (Master)](#8-pole-1-setup-master)
9. [Pole 2 Setup (Client)](#9-pole-2-setup-client)
10. [ROI Calibration (Both Poles)](#10-roi-calibration-both-poles)
11. [Network Configuration](#11-network-configuration)
12. [Running the System](#12-running-the-system)
13. [Auto-Start on Boot](#13-auto-start-on-boot)
14. [Accessing the Dashboard](#14-accessing-the-dashboard)
15. [Pre-Deployment Checklist](#15-pre-deployment-checklist)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Hardware Requirements

| Component | Specification |
|---|---|
| SBC | Raspberry Pi 5 (8GB RAM) × 2 |
| Camera | VIGI C240 Dome Camera × 2 (RTSP stream) |
| Display | ARZOPA portable monitor × 2 (HDMI) |
| Power | Portable battery pack × 2 (min. 65W USB-C PD) |
| Networking | Built-in Wi-Fi (Pole 1 as AP, Pole 2 as client) |
| Storage | MicroSD card (64GB+, Class 10 or better) × 2 |
| Cables | USB-C power cable, micro-HDMI to HDMI × 2 |
| Housing | Weatherproof pole enclosure × 2 |

---

## 2. Physical Assembly

> See `media/demo/3d_pole_assembly.mp4` for a full visual walkthrough.

- Mount the VIGI C240 camera at the top of the pole, angled 30–45° downward toward the crosswalk.
- Mount the ARZOPA monitor at approximately 1.5m height, facing oncoming pedestrians.
- House the Raspberry Pi 5 and battery pack inside the weatherproof enclosure at the base or mid-section.
- Run HDMI and power cables internally through the pole where possible.
- Ensure the camera has a clear, unobstructed view of the full crosswalk area.
- Position Pole 1 and Pole 2 on **opposite sides** of the crosswalk, facing each other.

---

## 3. OS Setup (Both Poles)

Flash **Raspberry Pi OS with Desktop (64-bit, Bookworm)** using Raspberry Pi Imager. Desktop is required for the Pygame display.

```bash
sudo apt update && sudo apt upgrade -y
```

Set hostname:

```bash
# On Pole 1:
sudo hostnamectl set-hostname swips-pi

# On Pole 2:
sudo hostnamectl set-hostname swips-pole2
```

Enable SSH:

```bash
sudo systemctl enable ssh
sudo systemctl start ssh
```

Install system dependencies:

```bash
sudo apt install -y git python3-pip python3-venv python3-pygame \
  libopencv-dev python3-opencv libatlas-base-dev \
  mosquitto mosquitto-clients curl ufw ffmpeg
```

---

## 4. Python Environment (Both Poles)

Clone the repo:

```bash
cd ~
git clone https://github.com/JyresaMae/SWiPS.git swips_project
```

Create the virtual environment at `/home/pi/swips_env` (NOT inside swips_project):

```bash
cd ~
python3 -m venv swips_env
source ~/swips_env/bin/activate
pip install --upgrade pip
pip install -r ~/swips_project/requirements.txt
```

> Always activate before running any scripts:
> ```bash
> source ~/swips_env/bin/activate
> ```

---

## 5. Camera Setup (Both Poles)

### 5.1 VIGI C240 Initial Configuration

1. Connect the VIGI C240 to your local network via Ethernet.
2. Open **VIGI Security Manager** on your laptop.
3. Add the camera, set credentials (e.g., `admin` / `swips2026`).
4. Note the camera's IP address.

### 5.2 RTSP URL Format

```
rtsp://<username>:<password>@<camera-ip>:554/stream2
```

Default used in SWiPS:
```
rtsp://admin:swips2026@192.168.1.242:554/stream2
```

> Use `stream2` (sub-stream) — lower resolution, better performance on RPi5.

### 5.3 Test the Stream

```bash
source ~/swips_env/bin/activate
python3 -c "
import cv2
cap = cv2.VideoCapture('rtsp://admin:swips2026@192.168.1.242:554/stream2')
print('Stream opened:', cap.isOpened())
ret, frame = cap.read()
print('Frame shape:', frame.shape if ret else 'No frame')
cap.release()
"
```

---

## 6. Display Setup (Both Poles)

### 6.1 Connect ARZOPA Monitor

Connect via micro-HDMI → HDMI. Power via USB-C.

### 6.2 Set Resolution

```bash
sudo nano /boot/firmware/config.txt
```

Add:
```ini
hdmi_group=2
hdmi_mode=82
hdmi_drive=2
```

Reboot:
```bash
sudo reboot
```

### 6.3 Display Environment for Pygame

```bash
export DISPLAY=:0
export SDL_VIDEODRIVER=x11
```

Add these to your `.bashrc` or include in systemd service (see Section 13).

### 6.4 Disable Screen Blanking

```bash
xset s off
xset -dpms
xset s noblank
```

---

## 7. Firewall and Port Configuration

```bash
sudo ufw allow ssh
sudo ufw allow 1883    # MQTT
sudo ufw allow 3000    # Dashboard (Pole 1 only)
sudo ufw allow 8086    # InfluxDB (Pole 1 only)
sudo ufw allow 9998    # MJPEG TCP video sink (Pole 1 only)
sudo ufw enable
sudo ufw status
```

---

## 8. Pole 1 Setup (Master)

### 8.1 MQTT Broker

Allow external connections (so Pole 2 can publish):

```bash
sudo nano /etc/mosquitto/mosquitto.conf
```

Add:
```
listener 1883 0.0.0.0
allow_anonymous true
```

```bash
sudo systemctl enable mosquitto
sudo systemctl restart mosquitto
```

### 8.2 InfluxDB 2.7

Install:

```bash
curl https://repos.influxdata.com/influxdata-archive.key | sudo gpg --dearmor -o /usr/share/keyrings/influxdb-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/influxdb-archive-keyring.gpg] https://repos.influxdata.com/debian stable main" | sudo tee /etc/apt/sources.list.d/influxdb.list
sudo apt update && sudo apt install -y influxdb2
sudo systemctl enable influxdb
sudo systemctl start influxdb
```

Initial setup (run once):

```bash
influx setup
# Username:     swips
# Password:     <your password>
# Organization: swips
# Bucket:       swips-data
# Retention:    0 (infinite)
```

Create additional buckets:

```bash
influx bucket create -n swips-alerts -o swips
influx bucket create -n swips-system -o swips
```

Get your API token:

```bash
influx auth list
```

Copy the token — needed for `.env`.

### 8.3 Node.js 18

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # v18.x.x
```

Install server dependencies:

```bash
cd ~/swips_project/server
npm install
```

### 8.4 Configure Server Environment

```bash
cp ~/swips_project/server/.env.example ~/swips_project/server/.env
nano ~/swips_project/server/.env
```

Fill in your real InfluxDB token:

```env
INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=<paste-your-token-here>
INFLUX_ORG=swips
INFLUX_BUCKET=swips-data
INFLUX_BUCKET_ALERTS=swips-alerts
INFLUX_BUCKET_SYSTEM=swips-system
MQTT_URL=mqtt://localhost:1883
API_PORT=3000
```

### 8.5 Configure Detection Script (Environment Variables)

The detection script reads config from environment variables. Set them before running:

```bash
export SWIPS_RTSP="rtsp://admin:swips2026@<camera-ip>:554/stream2"
export SWIPS_POLE="pole-1"
export SWIPS_LOCATION="msu-iit-crosswalk"
```

Or add them to your `.bashrc` for persistence:

```bash
echo 'export SWIPS_RTSP="rtsp://admin:swips2026@<camera-ip>:554/stream2"' >> ~/.bashrc
echo 'export SWIPS_POLE="pole-1"' >> ~/.bashrc
echo 'export SWIPS_LOCATION="msu-iit-crosswalk"' >> ~/.bashrc
source ~/.bashrc
```

---

## 9. Pole 2 Setup (Client)

Install Python environment same as Section 4.

Set environment variables pointing to **Pole 1's IP**:

```bash
export SWIPS_RTSP="rtsp://admin:swips2026@<pole2-camera-ip>:554/stream2"
export SWIPS_POLE="pole-2"
export SWIPS_LOCATION="msu-iit-crosswalk"
```

> No InfluxDB, Node.js, or Mosquitto needed on Pole 2.

The detection script on Pole 2 publishes MQTT to Pole 1. Make sure `MQTT_URL` in the script points to Pole 1:
- Field mode: `10.42.0.1`
- Lab mode: `10.10.79.159`

---

## 10. ROI Calibration (Both Poles)

**Required before first use.** The ROI defines the crosswalk detection zone in the camera frame.

```bash
source ~/swips_env/bin/activate
cd ~/swips_project/pole1    # or pole2 on Pole 2
python roi_calibrator.py
```

### How to calibrate

1. A live camera feed window opens.
2. Click to draw 4 polygon points around the crosswalk in the frame.
3. Press **Enter** to confirm.
4. Saved to `config/roi_config_camera_dual.json`.

### Config format

```json
{
  "video": "LIVE_CAMERA",
  "crosswalk_roi": [[266,119],[41,334],[729,365],[573,128]],
  "sidewalk_left_roi": [[0,0],[0,1],[1,1],[1,0]],
  "sidewalk_right_roi": [[0,0],[0,1],[1,1],[1,0]]
}
```

| Field | Description |
|---|---|
| `crosswalk_roi` | 4 polygon points (x,y) defining the crosswalk detection zone |
| `sidewalk_left_roi` | Left sidewalk ROI (set to dummy values if unused) |
| `sidewalk_right_roi` | Right sidewalk ROI (set to dummy values if unused) |

> Re-calibrate if the camera is physically moved or the site changes.

---

## 11. Network Configuration

### 11.1 Create Hotspot on Pole 1 (one-time)

```bash
sudo nmcli connection add type wifi ifname wlan0 con-name "SWiPS-Hotspot" autoconnect no \
  wifi.mode ap wifi.ssid "SWiPS-Pole-01" wifi-sec.key-mgmt wpa-psk \
  wifi-sec.psk "swips2026" ipv4.method shared ipv4.address 10.42.0.1/24
```

### 11.2 Create Pole 2 → Hotspot Connection (one-time)

```bash
sudo nmcli connection add type wifi ifname wlan0 con-name "SWiPS-Pole1-Link" \
  wifi.ssid "SWiPS-Pole-01" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "swips2026" \
  ipv4.method auto
```

### 11.3 Activate Field Mode (in this order)

```bash
# Step 1 — On Pole 1:
sudo nmcli connection up "SWiPS-Hotspot"
# SSH drops. Reconnect via hotspot: ssh pi@10.42.0.1

# Step 2 — On Pole 2:
sudo nmcli device wifi rescan
sleep 5
sudo nmcli connection up "SWiPS-Pole1-Link"
# SSH drops. Reconnect: ssh pi@10.42.0.2

# Step 3 — Connect laptop WiFi to SWiPS-Pole-01 (password: swips2026)
```

### 11.4 Switch Back to Lab Network

```bash
# On Pole 2 first:
sudo nmcli connection up "MSCA"

# Then on Pole 1:
sudo nmcli connection up "MSCA"
```

### 11.5 IP Reference

| Device | Field (Hotspot) | Lab |
|---|---|---|
| Pole 1 | 10.42.0.1 | 10.10.79.159 |
| Pole 2 | 10.42.0.2 | 10.10.79.136 |

---

## 12. Running the System

Start in this exact order:

**On Pole 1:**

```bash
# Terminal 1 — Detection loop
source ~/swips_env/bin/activate
cd ~/swips_project/pole1
python swips_simple_detect.py

# Terminal 2 — Dashboard + API server
cd ~/swips_project/server
node server.js
```

**On Pole 2:**

```bash
source ~/swips_env/bin/activate
cd ~/swips_project/pole2
python swips_simple_detect.py
```

Expected output on Pole 1:
```
[MQTT] Connected to local broker
[SWiPS] Model loaded
[SWiPS] Stream opened
[SWiPS] FSM → IDLE
```

---

## 13. Auto-Start on Boot

### 13.1 Detection Service — Pole 1

Create `/etc/systemd/system/swips-detect.service`:

```ini
[Unit]
Description=SWiPS Detection Loop - Pole 1
After=network.target mosquitto.service influxdb.service graphical.target

[Service]
User=pi
Environment=DISPLAY=:0
Environment=SDL_VIDEODRIVER=x11
Environment=SWIPS_RTSP=rtsp://admin:swips2026@192.168.1.242:554/stream2
Environment=SWIPS_POLE=pole-1
Environment=SWIPS_LOCATION=msu-iit-crosswalk
WorkingDirectory=/home/pi/swips_project/pole1
ExecStart=/home/pi/swips_env/bin/python swips_simple_detect.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 13.2 Dashboard Server Service — Pole 1

Create `/etc/systemd/system/swips-server.service`:

```ini
[Unit]
Description=SWiPS Dashboard Server
After=network.target influxdb.service mosquitto.service

[Service]
User=pi
WorkingDirectory=/home/pi/swips_project/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 13.3 Detection Service — Pole 2

Create `/etc/systemd/system/swips-detect.service` on Pole 2:

```ini
[Unit]
Description=SWiPS Detection Loop - Pole 2
After=network.target graphical.target

[Service]
User=pi
Environment=DISPLAY=:0
Environment=SDL_VIDEODRIVER=x11
Environment=SWIPS_RTSP=rtsp://admin:swips2026@<pole2-camera-ip>:554/stream2
Environment=SWIPS_POLE=pole-2
Environment=SWIPS_LOCATION=msu-iit-crosswalk
WorkingDirectory=/home/pi/swips_project/pole2
ExecStart=/home/pi/swips_env/bin/python swips_simple_detect.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 13.4 Enable All Services

**On Pole 1:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable swips-detect swips-server swips-mjpeg
sudo systemctl start swips-detect swips-server swips-mjpeg
```

**On Pole 2:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable swips-detect
sudo systemctl start swips-detect
```

---

## 14. Accessing the Dashboard

| Mode | WiFi | Password | URL |
|---|---|---|---|
| Field | SWiPS-Pole-01 | swips2026 | http://10.42.0.1:3000 |
| Lab | MSCA | — | http://10.10.79.159:3000 |

**Dashboard tabs:**

| Tab | Description |
|---|---|
| Dashboard | Live FSM state (IDLE / CROSSING / OBSTRUCTION) for both poles |
| Live Cam | MJPEG video feeds (TCP stream via port 9998) |
| Analytics | State transition history, detection counts |
| Performance | Latency (ms), FPS, CPU/memory usage |
| Compliance | Detection rate and uptime |
| Alerts | OBSTRUCTION and CROSSING events with timestamps |
| Map | MSU-IIT crosswalk deployment map |

---

## 15. Pre-Deployment Checklist

```
Hardware
[ ] Both RPi5 units powered and booted
[ ] Both ARZOPA monitors connected and displaying
[ ] Both VIGI C240 cameras mounted and RTSP stream confirmed
[ ] Battery packs fully charged

Software - Pole 1
[ ] swips_env activated, dependencies installed
[ ] InfluxDB running, 3 buckets created (swips-data, swips-alerts, swips-system)
[ ] Mosquitto running with external connections allowed
[ ] server/.env filled in with real InfluxDB token
[ ] SWIPS_RTSP, SWIPS_POLE, SWIPS_LOCATION environment variables set
[ ] ROI calibration done, roi_config_camera_dual.json updated

Software - Pole 2
[ ] swips_env activated, dependencies installed
[ ] SWIPS_RTSP, SWIPS_POLE, SWIPS_LOCATION environment variables set
[ ] ROI calibration done

Network
[ ] SWiPS-Hotspot profile exists on Pole 1
[ ] SWiPS-Pole1-Link profile exists on Pole 2
[ ] Tested full sequence: hotspot up → Pole 2 joins → laptop connects → dashboard loads

Final Verification
[ ] Both detection scripts running, FSM states showing in dashboard
[ ] MQTT messages flowing: mosquitto_sub -t "swips/#" -v
[ ] InfluxDB logging: check Analytics tab
[ ] MJPEG streams showing in Live Cam tab
[ ] OBSTRUCTION timer tested (hold >30s → red flash triggered)
```

---

## 16. Troubleshooting

**Pole 2 not joining hotspot:**
```bash
sudo nmcli device wifi rescan && sleep 5 && sudo nmcli connection up "SWiPS-Pole1-Link"
```

**RTSP stream not opening:**
```bash
python3 -c "import cv2; cap=cv2.VideoCapture('rtsp://admin:swips2026@<ip>:554/stream2'); print(cap.isOpened())"
ping <camera-ip>
```

**MQTT not receiving from Pole 2:**
```bash
# On Pole 1:
mosquitto_sub -h localhost -t "swips/#" -v
# Verify Pole 2 can reach Pole 1:
ping 10.42.0.1
```

**InfluxDB connection refused:**
```bash
sudo systemctl restart influxdb
sudo systemctl status influxdb
```

**Dashboard not loading:**
```bash
sudo systemctl status swips-server
cd ~/swips_project/server && node server.js    # run manually to see errors
```

**Pygame display not showing:**
```bash
export DISPLAY=:0
export SDL_VIDEODRIVER=x11
python display_controller.py
```

**Check all service logs:**
```bash
sudo journalctl -u swips-detect -f
sudo journalctl -u swips-server -f
sudo journalctl -u swips-mjpeg -f
```

**ROI not detecting correctly:**
```bash
python roi_calibrator.py
cat ~/swips_project/config/roi_config_camera_dual.json
```
