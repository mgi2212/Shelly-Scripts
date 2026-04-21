# Garage Door → Dehumidifier Controller

Turns a shop dehumidifier OFF when the overhead door is open (debounced 30s), and
back ON when the door closes — but only if the dehumidifier was already ON before
the door opened.

## Topology

| Role    | Device                                                 | IP            |
| ------- | ------------------------------------------------------ | ------------- |
| Sensor  | Shelly BLU Door/Window (`38:39:8f:f4:5f:61`)           | — (BLE)       |
| Gateway | Shelly running this script, in BLE range of the sensor | 192.168.0.151 |
| Target  | Shelly 1 Gen 4 dehumidifier                            | 192.168.0.153 |

The BLU DW broadcasts BTHome v2 advertisements. The gateway Shelly (192.168.0.151)
runs this script, decodes the `window` field from each advert, debounces the
state for 30 seconds, and drives the dehumidifier's relay over HTTP RPC
(`http://192.168.0.153/rpc/Switch.Set`).

## Logic

- **Committed OPEN** → read the dehumidifier's current relay state, cache it,
  then turn the relay OFF.
- **Committed CLOSED** → turn the relay ON *only if* the cached prior state
  was ON. Otherwise leave it unchanged. The cache is cleared after each
  CLOSED commit so the next OPEN re-captures fresh state.
- **Baseline** — on first advertisement after script start, the current state
  is committed silently with no action, so a script restart never spuriously
  toggles the relay.

## Why this host

The dehumidifier itself (192.168.0.153) was considered as the host but proved to
be out of BLE range of the sensor (verified by zero adverts reaching its
scanner). 192.168.0.151 is in range and mains-powered, so it's the gateway.

## Deploying

1. Open `http://192.168.0.151` → **Settings → Bluetooth** → confirm Bluetooth is
   enabled.
2. **Scripts → Add Script** → paste `garage-door-dehumid.js` → Save → Start.
3. Enable **Auto-start on boot**.
4. Watch the log for the startup trace:
   - `BLE enabled`
   - `initial dehumidifier state: ON/OFF` — confirms HTTP reach to .153
   - `SENSOR IDENTIFIED: mac=…` — confirms the sensor is in range
   - `baseline committed: open/closed` — initial state without action

## Log lines to verify the spec

| Spec               | Log signature                                                                        |
| ------------------ | ------------------------------------------------------------------------------------ |
| Sensor identified  | `SENSOR IDENTIFIED: mac=… rssi=… window=… battery=…%`                                |
| 30-second debounce | `debounce START: … (must hold 30s)` → `debounce COMMIT after ~30000ms`               |
| Transient flicker  | `debounce CANCELLED after Nms; reverted to …`                                        |
| Open → OFF         | `ACTION OPEN` → `cached prior … = ON/OFF` → `Switch.Set OK: dehumidifier -> OFF`     |
| Closed → restore   | `ACTION CLOSED` → `decision: prior was ON -> restoring dehumidifier to ON`           |
| Closed, was OFF    | `decision: prior was OFF/UNKNOWN -> leaving dehumidifier UNCHANGED`                  |

A heartbeat line prints every 60s with packet counters and current state:

```text
heartbeat: ble_total=550 target_parsed=19 committed=closed savedRelay=null
```

## Configuration

All knobs live in the `CONFIG` object at the top of the script:

```javascript
let CONFIG = {
  SENSOR_MAC:        "38:39:8f:f4:5f:61", // BLU DW MAC (lowercase)
  DEHUMID_HOST:      "192.168.0.153",     // target Shelly
  DEHUMID_SWITCH_ID: 0,                   // Shelly 1 has one switch
  DEBOUNCE_MS:       30 * 1000,
  DEBUG:             true,
};
```

## Files

| File                     | Purpose                                                 |
| ------------------------ | ------------------------------------------------------- |
| `garage-door-dehumid.js` | The script. Deploy on 192.168.0.151.                    |
| `README.md`              | This file.                                              |
| `config.md`              | Longer-form deployment walkthrough and troubleshooting. |

## Credits

BTHome v2 decoder adapted from the ALLTERCO BLU DW example:
<https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble/ble-shelly-dw.shelly.js>
