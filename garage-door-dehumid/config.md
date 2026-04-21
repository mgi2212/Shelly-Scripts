# Configuration & Troubleshooting

## Architecture recap

```text
BLU DW sensor  (BLE adverts, BTHome v2, UUID 0xFCD2)
     │
     ▼
Shelly gateway @ 192.168.0.151  — runs garage-door-dehumid.js
     │   (30s debounce, save/restore logic)
     │
     │  HTTP GET /rpc/Switch.GetStatus?id=0
     │  HTTP GET /rpc/Switch.Set?id=0&on=true|false
     ▼
Shelly 1 Gen 4 Dehumidifier @ 192.168.0.153
```

## Prerequisites

- 192.168.0.151 has BLE enabled (**Settings → Bluetooth**).
- 192.168.0.151 is within BLE range of the BLU DW sensor (verified: packets
  parse at RSSI ≈ -65 to -80 dBm).
- 192.168.0.151 can reach 192.168.0.153 over the LAN (plain HTTP, no auth).
- 192.168.0.153 has RPC authentication **disabled** (default for local LAN).
  If you've enabled auth, this script needs to be updated to pass credentials.

## CONFIG parameters

```javascript
let CONFIG = {
  SENSOR_MAC:        "38:39:8f:f4:5f:61", // lowercase, colon-separated
  DEHUMID_HOST:      "192.168.0.153",     // IP or hostname
  DEHUMID_SWITCH_ID: 0,                   // 0 for Shelly 1 / 1PM / Plus 1
  DEBOUNCE_MS:       30 * 1000,           // 30 seconds
  DEBUG:             true,                // false silences [garage-dehumid] logs
};
```

## Deployment

1. In a browser, open `http://192.168.0.151`.
2. **Scripts → Add Script** → paste the contents of `garage-door-dehumid.js`.
3. Name it e.g. `garage-door-dehumid`. Save.
4. Press **Start**. Enable **"Run on startup"** so it survives reboots.
5. Watch the log pane for the startup trace described in the main README.

## Verifying each spec item

| Test                                          | Expected log evidence                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Script boots and reaches the dehumidifier     | `initial dehumidifier state: ON` (or OFF)                                  |
| Sensor is identified via BLE                  | `SENSOR IDENTIFIED: mac=38:39:8f:f4:5f:61 rssi=… window=… battery=…%`      |
| Brief door flicker does not trigger any relay | `debounce START …` → `debounce CANCELLED after Nms`                        |
| Door held open ≥30s turns OFF                 | `debounce COMMIT after ~30000ms …` → `Switch.Set OK: dehumidifier -> OFF`  |
| Door closed ≥30s restores prior ON state      | `ACTION CLOSED … prior was ON …` → `dehumidifier -> ON`                    |
| Door closed when prior was OFF/unknown        | `ACTION CLOSED … prior was OFF/UNKNOWN -> leaving dehumidifier UNCHANGED`  |

## Troubleshooting

### No `SENSOR IDENTIFIED` line and heartbeat shows `target_parsed=0`

The gateway can hear BLE (`ble_total > 0`) but no BTHome v2 packets from our
MAC. Possible causes:

- Sensor out of BLE range — the BLU DW's CR2032 radio is low-power.
- Sensor's CR2032 is dead.
- Another Shelly on the network has "consumed" the advertisements by pairing
  the sensor as a local BTHome device (removes them from other scanners). If
  so, either unpair there or re-host this script on the paired device.

### Heartbeat shows `ble_total=0`

The gateway's BLE scanner isn't delivering any events. Check:

- **Settings → Bluetooth** on the gateway — Bluetooth must be enabled.
- Script log should say `BLE scanner already running; subscribing` or
  `BLE.Scanner.Start returned: …`. If neither, something interrupted
  initialisation.

### `initial remote Switch.GetStatus FAILED`

The gateway can't reach 192.168.0.153 over HTTP. Check:

- The dehumidifier is powered and on the network.
- Ping / curl from another machine: `curl http://192.168.0.153/rpc/Shelly.GetStatus`.
- If the dehumidifier has RPC auth enabled, this script needs credentials
  (not currently implemented).

### Debounce never commits

If the reed switch is mechanically marginal, the sensor may emit `window=0/1`
flips faster than 30 seconds apart, resetting the debounce each time.
Diagnosis:

- Physically move the magnet to a cleaner alignment.
- If that's not an option, shorten `DEBOUNCE_MS` so more transitions survive,
  or switch to an N-consecutive-samples strategy (requires small script
  change).

### Relay doesn't change on commit

Look for `Switch.Set FAILED` in the log. Common causes: network blip, auth
required on target. The error object is logged verbatim.

## Extending

- **Different target device** — change `DEHUMID_HOST` and `DEHUMID_SWITCH_ID`.
- **Different sensor** — change `SENSOR_MAC`. BLU DW and BLU DW Plus both
  emit `window` (0x2D). For other BLU devices, check the BTHome object id
  and add a field to the `BTH` map if needed.
- **Different debounce** — change `DEBOUNCE_MS` (milliseconds).
- **Silent mode** — set `CONFIG.DEBUG = false`.
