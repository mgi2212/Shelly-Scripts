# FlexRadio Power Cycle — Installation Guide

Complete setup guide for the FlexRadio hard power cycle system with SmartSDR watchdog.

## What You Need

### Hardware

- **Shelly Plus 2PM** (or any Gen2+ Shelly with two outputs)
- **30A normally closed (NC) relay/contactor** — driven by Shelly Output 1
- **FlexRadio transceiver** (Flex-6000 series or any model with a REM ON jack)
- **Cable from Shelly Output 0 to FlexRadio REM ON jack** (open drain)
- A **Windows PC or Mac** on the same LAN (for the watchdog proxy)
- Standard wiring supplies, enclosure, fusing

### Software

- Python 3.10+ on the PC ([python.org](https://www.python.org/downloads/))
- A web browser for the Shelly and watchdog dashboard

---

## Step 1: Hardware Wiring

```
                    Shelly Plus 2PM
                   +----------------+
                   |                |
  Mains Power ──>──| Output 1 (SW) |──>── 30A NC Relay Coil
                   |                |        |
                   | Output 0 (OD) |──>──   | NC Contact ──>── FlexRadio AC Input
                   |                |   |
                   +----------------+   |
                                        └── FlexRadio REM ON Jack
```

**Output 1** drives a normally closed 30A relay that controls mains power to the transceiver:
- Output 1 OFF = relay closed = power flows to radio (normal state)
- Output 1 ON = relay opens = power cut

**Output 0** is an open drain output wired to the FlexRadio's rear-panel **REM ON** jack:
- Output 0 ON = REM ON asserted = radio powers up
- Output 0 OFF = REM ON de-asserted = radio shuts down

### Safety Notes

- Fuse the mains side appropriately for your transceiver's draw
- Use a relay/contactor rated for your mains voltage and current
- Enclose all mains wiring in an appropriate enclosure
- Keep the Shelly device away from RF sources if possible

---

## Step 2: Configure the Shelly Device

1. Power up the Shelly and connect to its Wi-Fi AP, or find it on your network
2. Open its web UI: `http://<shelly-ip>`
3. Assign a **static IP** (or use DHCP reservation on your router)
4. Set **Output 0 power-on default to ON** — this ensures REM ON is asserted after a power outage so the radio boots automatically
5. Set both outputs to "Detached" input mode if using wall switches

---

## Step 3: Install the Shelly Script

1. In the Shelly web UI, navigate to **Scripts**
2. Click **Create Script**
3. Paste the contents of `flexradio-power-cycle.js`
4. **Edit the config section** at the top of the script:

```javascript
// Watchdog config
let PROXY_IP = "192.168.0.20";         // IP of your PC
let PROXY_PORT = 8080;                  // watchdog proxy port
```

5. Click **Save**, then **Start**
6. Enable the script to **run on boot**

### Optional Settings

| Setting | Default | Description |
|---|---|---|
| `WATCHDOG_ENABLED` | `true` | Master enable for the watchdog |
| `WATCHDOG_INTERVAL` | `30000` | How often to check (ms) |
| `WATCHDOG_FAIL_COUNT` | `3` | Consecutive failures before cycling |
| `WATCHDOG_HOLD_OFF` | `60000` | Wait after failure confirmed (ms) |
| `WATCHDOG_BOOT_GRACE` | `300000` | Grace period after Shelly boot (ms) |
| `WATCHDOG_MAX_CYCLES` | `3` | Max retries before giving up (0 = unlimited) |
| `WATCHDOG_INPUT` | `-1` | Physical input for enable/disable (-1 = not used) |

### Battery Monitoring (Solar / Off-Grid)

If your station runs on battery power, enable voltage monitoring:

```javascript
let BATTERY_ENABLED = true;
let BATTERY_SWITCH_ID = 0;          // output channel to read voltage from
let BATTERY_MIN_CYCLE_V = 12.0;     // block power cycle below this
let BATTERY_CRITICAL_V = 11.5;      // shut down radio to protect battery
let BATTERY_RESUME_V = 12.5;        // restore radio when recovered
```

Example thresholds for common battery banks:

| Bank | Critical | Min Cycle | Resume |
|---|---|---|---|
| 12V | 11.5V | 12.0V | 12.5V |
| 24V | 23.0V | 24.0V | 25.0V |
| 48V | 46.0V | 48.0V | 50.0V |

---

## Step 4: Install the Watchdog Proxy (PC or Raspberry Pi)

The Python watchdog proxy runs on a PC, Mac, or Raspberry Pi on the same LAN. It pings the FlexRadio's SmartSDR API to verify the process is alive.

### Quick Start (Headless)

If you just need the basic proxy without the web UI:

```bash
pip install flask requests
cd flexradio-watchdog
python __main__.py --radio-ip 192.168.0.25
```

### Full Install (Web UI + Discovery + UPnP)

```bash
pip install flask requests miniupnpc zeroconf
cd flexradio-watchdog
python __main__.py --radio-ip 192.168.0.25
```

Then open `http://localhost:8080/dashboard` in your browser.

### First-Time Setup Wizard

If you omit `--radio-ip`, the proxy starts in setup mode:

```bash
python __main__.py
```

Open `http://localhost:8080/wizard` and follow the 5-step wizard:

1. **FlexRadio IP** — enter manually or auto-discover via VITA-49 UDP broadcast
2. **Shelly IP** — enter manually or auto-discover via mDNS
3. **Parameters** — check interval, HTTP port
4. **Remote Access** — set up UPnP port forwarding and basic auth credentials
5. **Save** — writes `flexradio-watchdog.json` and starts the watchdog

### Command-Line Options

| Flag | Default | Description |
|---|---|---|
| `--radio-ip` | (from config) | FlexRadio IP address |
| `--api-port` | `4992` | SmartSDR API port |
| `--port` | `8080` | HTTP server port |
| `--interval` | `30` | Check interval in seconds |
| `--config` | `flexradio-watchdog.json` | Config file path |

### Running as a Windows Service

To start the watchdog automatically on boot, use [NSSM](https://nssm.cc/):

```bash
nssm install FlexRadioWatchdog "C:\path\to\python.exe" "C:\path\to\flexradio-watchdog\__main__.py"
nssm set FlexRadioWatchdog AppDirectory "C:\path\to\flexradio-watchdog"
nssm start FlexRadioWatchdog
```

Or add a shortcut to `shell:startup` that runs the command.

### Running on a Raspberry Pi

The watchdog runs on any Raspberry Pi (Zero 2 W and up). The Pi also provides GPIO pins for additional station control (amplifier power, antenna switching, sensors, etc.).

**Install on Raspberry Pi OS:**

```bash
# Flask + core dependencies
sudo apt update
sudo apt install -y python3-flask python3-requests

# Optional: UPnP and Shelly discovery
pip3 install miniupnpc zeroconf

# gpiozero is pre-installed on Raspberry Pi OS
# If missing: sudo apt install -y python3-gpiozero

# Clone the repo
git clone https://github.com/mgi2212/Shelly-Scripts.git
cd Shelly-Scripts/flexradio-watchdog

# Run
python3 __main__.py --radio-ip 192.168.0.25
```

**GPIO pin configuration** — add a `gpio_pins` array to `flexradio-watchdog.json`:

```json
{
  "radio_ip": "192.168.0.25",
  "shelly_ip": "192.168.0.100",
  "gpio_pins": [
    {"pin": 17, "mode": "output", "label": "Amp Power", "initial": false},
    {"pin": 27, "mode": "output", "label": "Aux Relay", "initial": false},
    {"pin": 22, "mode": "input",  "label": "Door Sensor", "pull_up": true},
    {"pin": 23, "mode": "input",  "label": "Temp Alert", "pull_up": true}
  ]
}
```

Configured GPIO pins appear on the dashboard with toggle buttons (outputs) and live state indicators (inputs). The GPIO API is also available for automation:

```
GET  /api/gpio          — all pin states (JSON)
POST /api/gpio/17       — set output: {"state": true}
```

**Auto-start on boot (systemd):**

```bash
sudo tee /etc/systemd/system/flexradio-watchdog.service << 'EOF'
[Unit]
Description=FlexRadio Watchdog
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Shelly-Scripts/flexradio-watchdog
ExecStart=/usr/bin/python3 __main__.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable flexradio-watchdog
sudo systemctl start flexradio-watchdog
```

Check status: `sudo systemctl status flexradio-watchdog`

---

## Step 5: Verify

1. **Shelly script log** — in the Shelly web UI under Scripts, check the console for:
   ```
   [FlexCycle] Script loaded
   [FlexCycle] Boot grace period: 300s
   ```

2. **Watchdog proxy** — check the terminal output:
   ```
   [12:34:56] ALIVE: ping OK (V3.4.16)
   ```

3. **Dashboard** — open `http://<pc-ip>:8080/dashboard` and verify the green status dot

4. **Shelly polling** — after the boot grace period, the Shelly will poll `/alive` every 30 seconds. You should see requests in the Flask console.

5. **Test a manual power cycle** — from the dashboard, click "Power Cycle Radio" (confirm the dialog). Watch the Shelly toggle outputs through the sequence.

---

## How It Works

### Normal Operation

```
Every 30s:
  Shelly ──HTTP GET──> PC:8080/alive
  PC ──TCP 4992──> FlexRadio (ping)
  FlexRadio ──response──> PC
  PC ──"1"──> Shelly
  Shelly: failCount = 0, all good
```

### Radio Becomes Unresponsive

```
  Shelly polls /alive → gets "0" (3 times over 90s)
  Shelly waits 60s hold-off
  Shelly checks battery voltage (if enabled)
  Shelly runs power cycle:
    1. OUT0 OFF (de-assert REM ON)
    2. Wait 60s → OUT1 OFF (restore mains)
    3. Wait 60s → OUT0 ON (boot radio)
  Shelly waits 5 min grace, then resumes watchdog
```

### PC Is Off or Proxy Not Running

```
  Shelly polls /alive → HTTP error (unreachable)
  Shelly: proxy unreachable = safe mode, reset failCount
  No power cycle triggered
```

---

## Watchdog Enable/Disable

### Via HTTP API (from any browser or script)

```
Enable:  http://<shelly-ip>/rpc/KVS.Set?key="watchdog_enabled"&value=true
Disable: http://<shelly-ip>/rpc/KVS.Set?key="watchdog_enabled"&value=false
```

### Via Dashboard

Click **Enable Watchdog** or **Disable Watchdog** on the web dashboard.

### Via Physical Switch

Set `WATCHDOG_INPUT` to an input ID (0 or 1) in the Shelly script. Wire a toggle switch to that input. Switch ON = watchdog enabled, OFF = disabled.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Watchdog never triggers | Proxy unreachable (safe mode) | Verify PC is running and proxy is started |
| Radio cycles immediately on boot | Boot grace too short | Increase `WATCHDOG_BOOT_GRACE` (default 5 min) |
| Radio cycles repeatedly | SmartSDR not recovering | Check radio hardware; increase `WATCHDOG_MAX_CYCLES` or set to 0 |
| Dashboard shows "No Shelly IP configured" | Wizard not completed | Run `/wizard` and enter Shelly IP |
| UPnP forwarding fails | Router UPnP disabled | Enable UPnP/IGD in router settings |
| Battery load shed won't resume | Voltage below `BATTERY_RESUME_V` | Charge battery or lower the threshold |
| "connection refused" in proxy log | SmartSDR process not running | Radio may need manual intervention |
