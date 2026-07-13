# SWiPS Setup Guide

This guide covers full setup of both poles from a fresh Raspberry Pi OS installation. Follow each section in order.

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

> Reference: see `media/demo/3d_pole_assembly.mp4` for full visual walkthrough.

**General guidelines per pole:**
- Mount the VIGI C240 camera at the top of the pole, angled downward at approximately 30–45° toward the crosswalk.
- Mount the ARZOPA monitor at eye level (approximately 1.5m from ground) facing oncoming pedestrians.
- House the Raspberry Pi 5 and battery pack inside the weatherproof enclosure at the base or mid-section.
- Run HDMI and power cables internally through the pole where possible to avoid exposure.
- Ensure the camera has a clear, unobstructed view of the full crosswalk ROI.
- Position Pole 1 and Pole 2 on opposite sides of the crosswalk, facing each other.

---

## 3. OS Setup (Both Poles)

Flash **Raspberry Pi OS with Desktop (64-bit, Bookworm)** using Raspberry Pi Imager. Desktop is required for the Pygame display.

After first boot:

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
  mosquitto mosquitto-clients curl ufw
```

---

## 4. Python Environment (Both Poles)

Clone the repo and create the virtual environment:

```bash
cd ~
git clone https://github.com/JyresaMae/SWiPS.git swips_project
cd swips_project

python3 -m venv swips_env
source swips_env/bin/activate

pip install --upgrade pip
pip install ultralytics opencv-python paho-mqtt influxdb-client pygame numpy
```

> Always activate the virtual environment before running scripts:
> ```bash
> source ~/swips_project/swips_env/bin/activate
> ```

---

## 5. Camera Setup (Both Poles)

### 5.1 VIGI C240 Initial Configuration

1. Connect the VIGI C240 to your local network via Ethernet.
2. Download and open **VIGI Security Manager** on your laptop.
3. Add the camera, set a username and password (e.g., `admin` / `swips2026`).
4. Note the camera's assigned IP address (e.g., `192.168.1.100`).

### 5.2 Find the RTSP URL

The VIGI C240 RTSP stream URL format:

```
rtsp://<username>:<password>@<camera-ip>/stream1     # Main stream (high res)
rtsp://<username>:<password>@<camera-ip>/stream2     # Sub stream (lower res)
```

Example:
```
rtsp://admin:swips2026@192.168.1.100/stream1
```

### 5.3 Test the RTSP Stream

```bash
# Install VLC or test with OpenCV:
python3 -c "
import cv2
cap = cv2.VideoCapture('rtsp://admin:swips2026@192.168.1.100/stream1')
print('Stream opened:', cap.isOpened())
cap.release()
"
```

### 5.4 Set Static IP for Camera (Recommended)

Assign a static IP to each camera so it doesn't change between sessions. Do this in your router's DHCP reservation settings using the camera's MAC address:

| Camera | Recommended Static IP |
|---|---|
| Pole 1 camera | 192.168.1.101 |
| Pole 2 camera | 192.168.1.102 |

> In field (hotspot) mode, cameras connect to Pole 1's hotspot. Assign them static IPs via the hotspot DHCP config or directly on the camera.

---

## 6. Display Setup (Both Poles)

### 6.1 Connect ARZOPA Monitor

Connect the ARZOPA monitor to the Raspberry Pi 5 via micro-HDMI → HDMI cable. Power the monitor via USB-C.

### 6.2 Set Display Resolution

```bash
# Check connected displays:
tvservice -l

# Force resolution (add to /boot/firmware/config.txt):
sudo nano /boot/firmware/config.txt
```

Add or modify:
```ini
hdmi_group=2
hdmi_mode=82    # 1920x1080 @ 60Hz
hdmi_drive=2
```

Save and reboot:
```bash
sudo reboot
```

### 6.3 Configure Display Environment for Pygame

When running as a service (no desktop session), Pygame needs to know which display to use:

```bash
export DISPLAY=:0
export SDL_VIDEODRIVER=x11
```

Add these to your `.bashrc` or include them in the systemd service file (see Section 13).

### 6.4 Disable Screen Blanking

Prevent the display from turning off during deployment:

```bash
sudo nano /etc/lightdm/lightdm.conf
```

Under `[Seat:*]`, add:
```ini
xserver-command=X -s 0 -dpms
```

Or via `xset` (run after desktop starts):
```bash
xset s off
xset -dpms
xset s noblank
```

---

## 7. Firewall and Port Configuration

Open the required ports on **both poles**:

```bash
sudo ufw allow ssh
sudo ufw allow 1883    # MQTT
sudo ufw allow 8086    # InfluxDB (Pole 1 only)
sudo ufw allow 3000    # Dashboard server (Pole 1 only)
sudo ufw allow 8554    # MJPEG stream
sudo ufw enable
sudo ufw status
```

> On Pole 2, you only need SSH and MQTT (1883). The rest are Pole 1 only.

---

## 8. Pole 1 Setup (Master)

### 8.1 MQTT Broker (Mosquitto)

```bash
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
sudo systemctl status mosquitto
```

Allow external connections (so Pole 2 can connect):

```bash
sudo nano /etc/mosquitto/mosquitto.conf
```

Add:
```
listener 1883 0.0.0.0
allow_anonymous true
```

Restart:
```bash
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
# Organization: swips-org
# Bucket:       swips
# Retention:    0 (infinite)
```

Get your API token:

```bash
influx auth list
```

Copy the token — you will need it in the detection script.

### 8.3 Node.js and Dashboard Server

Install Node.js 18:

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # should be v18.x.x
```

Install server dependencies:

```bash
cd ~/swips_project/server
npm install
```

### 8.4 Configure Pole 1 Detection Script

Edit the config block at the top of `pole1/swips_simple_detect.py`:

```python
POLE_ID          = "pole1"
MQTT_BROKER      = "localhost"
MQTT_PORT        = 1883
INFLUX_URL       = "http://localhost:8086"
INFLUX_TOKEN     = "<your-influxdb-token>"
INFLUX_ORG       = "swips-org"
INFLUX_BUCKET    = "swips"
RTSP_URL         = "rtsp://admin:swips2026@<camera-ip>/stream1"
MODEL_PATH       = "/home/pi/swips_project/models/best_ncnn_model"
ROI_CONFIG       = "/home/pi/swips_project/config/roi_config_camera_dual.json"
```

### 8.5 MJPEG Bridge Service

```bash
sudo cp ~/swips_project/services/swips-mjpeg.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable swips-mjpeg
sudo systemctl start swips-mjpeg
sudo systemctl status swips-mjpeg
```

---

## 9. Pole 2 Setup (Client)

Edit the config block at the top of `pole2/swips_simple_detect.py`:

```python
POLE_ID          = "pole2"
MQTT_BROKER      = "10.42.0.1"    # Pole 1 IP in hotspot mode
MQTT_PORT        = 1883
RTSP_URL         = "rtsp://admin:swips2026@<camera-ip>/stream1"
MODEL_PATH       = "/home/pi/swips_project/models/best_ncnn_model"
ROI_CONFIG       = "/home/pi/swips_project/config/roi_config_camera_dual.json"
```

> No InfluxDB, Node.js, or Mosquitto needed on Pole 2.

---

## 10. ROI Calibration (Both Poles)

**This step is required before first use.** The ROI (Region of Interest) defines the crosswalk detection zone in the camera frame. Without calibration, the system will not detect correctly.

Run the calibrator on each pole separately:

```bash
source ~/swips_project/swips_env/bin/activate
cd ~/swips_project/pole1    # or pole2 on Pole 2
python roi_calibrator.py
```

### How to calibrate:

1. A live camera feed window will open.
2. Click to draw the ROI polygon around the crosswalk area in the frame.
3. Press **Enter** to confirm the ROI.
4. The calibrator saves the coordinates to `config/roi_config_camera_dual.json`.

### Understanding `roi_config_camera_dual.json`

```json
{
  "pole1": {
    "roi_points": [[x1,y1], [x2,y2], [x3,y3], [x4,y4]],
    "frame_width": 1920,
    "frame_height": 1080
  },
  "pole2": {
    "roi_points": [[x1,y1], [x2,y2], [x3,y3], [x4,y4]],
    "frame_width": 1920,
    "frame_height": 1080
  }
}
```

| Field | Description |
|---|---|
| `roi_points` | Polygon vertices defining the crosswalk detection zone |
| `frame_width` | Camera stream resolution (width) |
| `frame_height` | Camera stream resolution (height) |

> Re-run calibration if the camera is physically moved or the deployment site changes.

---

## 11. Network Configuration

### 11.1 Create Hotspot on Pole 1 (one-time)

```bash
sudo nmcli connection add type wifi ifname wlan0 con-name "SWiPS-Hotspot" autoconnect no \
  wifi.mode ap wifi.ssid "SWiPS-Pole-01" wifi-sec.key-mgmt wpa-psk \
  wifi-sec.psk "swips2026" ipv4.method shared ipv4.address 10.42.0.1/24
```

### 11.2 Create Pole 2 Connection to Hotspot (one-time)

```bash
sudo nmcli connection add type wifi ifname wlan0 con-name "SWiPS-Pole1-Link" \
  wifi.ssid "SWiPS-Pole-01" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "swips2026" \
  ipv4.method auto
```

### 11.3 Activate Field Mode

Run in this exact order:

```bash
# Step 1 — On Pole 1:
sudo nmcli connection up "SWiPS-Hotspot"
# SSH drops. Reconnect via hotspot at 10.42.0.1

# Step 2 — On Pole 2:
sudo nmcli device wifi rescan
sleep 5
sudo nmcli connection up "SWiPS-Pole1-Link"
# SSH drops. Reconnect via hotspot at 10.42.0.2

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

| Device | Field (Hotspot) | Lab (MSCA) |
|---|---|---|
| Pole 1 | 10.42.0.1 | 10.10.79.159 |
| Pole 2 | 10.42.0.2 | 10.10.79.136 |

---

## 12. Running the System

Start in this exact order:

**On Pole 1:**

```bash
# Terminal 1 — Detection loop
source ~/swips_project/swips_env/bin/activate
cd ~/swips_project/pole1
python swips_simple_detect.py

# Terminal 2 — Dashboard server
cd ~/swips_project/server
node server.js
```

**On Pole 2:**

```bash
source ~/swips_project/swips_env/bin/activate
cd ~/swips_project/pole2
python swips_simple_detect.py
```

Expected output on Pole 1:
```
[SWiPS] Model loaded: best_ncnn_model
[SWiPS] MQTT connected to localhost:1883
[SWiPS] InfluxDB connected
[SWiPS] Stream opened: rtsp://...
[SWiPS] FSM state: IDLE
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
WorkingDirectory=/home/pi/swips_project/pole1
ExecStart=/home/pi/swips_project/swips_env/bin/python swips_simple_detect.py
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
After=network.target influxdb.service

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
WorkingDirectory=/home/pi/swips_project/pole2
ExecStart=/home/pi/swips_project/swips_env/bin/python swips_simple_detect.py
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

| Mode | WiFi Network | Password | Dashboard URL |
|---|---|---|---|
| Field | SWiPS-Pole-01 | swips2026 | http://10.42.0.1:3000 |
| Lab | MSCA | — | http://10.10.79.159:3000 |

**Dashboard tabs:**

| Tab | Description |
|---|---|
| Dashboard | Live FSM state (IDLE / CROSSING / OBSTRUCTION) for both poles |
| Live Cam | MJPEG video feeds from Pole 1 and Pole 2 |
| Analytics | State transition history and detection counts over time |
| Performance | Latency (ms), FPS, inference time per frame |
| Compliance | Detection rate and system uptime |
| Alerts | Logged OBSTRUCTION and CROSSING events with timestamps |
| Map | Deployment site map (MSU-IIT crosswalk locations) |

---

## 15. Pre-Deployment Checklist

Run through this before going to the field:

```
Hardware
[ ] Both RPi5 units powered and booted
[ ] Both ARZOPA monitors connected and displaying
[ ] Both VIGI C240 cameras mounted and streaming (test RTSP)
[ ] Battery packs fully charged
[ ] All cables secured inside pole housing

Software
[ ] swips_env activated and dependencies installed on both poles
[ ] InfluxDB running and token configured (Pole 1)
[ ] Mosquitto running (Pole 1)
[ ] ROI calibration done for both poles (roi_config_camera_dual.json updated)
[ ] RTSP URLs correct and streams opening without error
[ ] MQTT_BROKER in Pole 2 set to 10.42.0.1

Network
[ ] SWiPS-Hotspot connection profile exists on Pole 1
[ ] SWiPS-Pole1-Link connection profile exists on Pole 2
[ ] Tested: Pole 1 hotspot up → Pole 2 joins → laptop connects → dashboard loads
[ ] Tested: Both poles SSH accessible at 10.42.0.1 and 10.42.0.2

Final Check
[ ] Detection running on both poles (FSM state showing in dashboard)
[ ] MQTT messages flowing (mosquitto_sub -t "swips/#" shows state transitions)
[ ] InfluxDB logging (check Analytics tab for incoming data)
[ ] MJPEG streams showing in Live Cam tab
```

---

## 16. Troubleshooting

**Pole 2 not joining hotspot:**
```bash
sudo nmcli device wifi rescan && sleep 5 && sudo nmcli connection up "SWiPS-Pole1-Link"
```

**MQTT not receiving messages from Pole 2:**
```bash
# On Pole 1, monitor all topics:
mosquitto_sub -h localhost -t "swips/#" -v

# Verify Pole 2 can reach Pole 1:
ping 10.42.0.1
```

**InfluxDB connection refused:**
```bash
sudo systemctl restart influxdb
sudo systemctl status influxdb
# Check token is correct in swips_simple_detect.py
```

**RTSP stream not opening:**
```bash
# Test stream directly:
python3 -c "import cv2; cap=cv2.VideoCapture('rtsp://...'); print(cap.isOpened())"
# Check camera IP is reachable:
ping <camera-ip>
```

**Pygame display not showing:**
```bash
export DISPLAY=:0
export SDL_VIDEODRIVER=x11
python display_controller.py
```

**Check service logs:**
```bash
sudo journalctl -u swips-detect -f
sudo journalctl -u swips-server -f
sudo journalctl -u swips-mjpeg -f
```

**ROI not detecting correctly:**
```bash
# Re-run calibration:
python roi_calibrator.py
# Verify saved config:
cat ~/swips_project/config/roi_config_camera_dual.json
```
