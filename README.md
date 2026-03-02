# Shelly Scripts

A collection of JavaScript scripts for [Shelly](https://www.shelly.com/) smart home devices (Gen2+).

## About

Shelly Gen2 and Gen3 devices include a built-in scripting engine based on **mJS** — a lightweight subset of JavaScript (ES6). Scripts run directly on the device, enabling local automation without cloud dependencies.

## What Can Scripts Do?

- Automate actions based on sensor data, schedules, or events
- Integrate with MQTT brokers and HTTP APIs
- Control relays, lights, covers, and other components
- Implement custom logic for energy management, notifications, and more

## Scripts

### [flexradio-power-cycle.js](flexradio-power-cycle.js)

A hard power-off cycle for FlexRadio transceivers. Designed for a two-output Shelly device (e.g., Shelly Plus 2PM):

- **Output 1** — controls a normally closed 30A relay for mains power
- **Output 0** — open drain output wired to the transceiver's REM ON jack

Turning Output 1 ON triggers the sequence:

1. Immediately de-assert REM ON (signal radio to shut down)
2. After 60s, restore mains power (close relay)
3. After 120s, assert REM ON (boot the radio back up)

### [i4-relay-mapper.js](i4-relay-mapper.js)

Maps 1–4 physical inputs on a Shelly Plus i4 to relay outputs on one or more remote Shelly devices via local HTTP RPC. Useful for pairing a centralized button panel with distributed relay devices.

- Edit the `MAP` array to define input-to-relay pairings (input ID, target IP, switch ID)
- Target devices must have **static IPs** or resolvable internal DNS names
- Includes debounce (150ms default) and boot-time sync so relays match switch positions after a reboot
- Set `CFG.DEBUG` to `true` for event logging

### [fan-oscillation-interlock.js](fan-oscillation-interlock.js)

Interlocks a fan and its oscillation motor on a single Shelly 2PM. Prevents the oscillation motor from running without the fan:

- **Output 0** — fan power
- **Output 1** — oscillation motor

Enforcement rules (applied to non-physical / remote control only):

- If oscillation is turned ON while the fan is OFF, the fan is automatically turned ON
- If the fan is turned OFF while oscillation is ON, oscillation is automatically turned OFF
- Physical wall switch actions are detected and given a grace window (2.5s) so manual operation is never overridden

## Getting Started

1. Open your Shelly device's web UI (e.g., `http://192.168.x.x`)
2. Navigate to **Scripts**
3. Create a new script and paste in the desired `.js` file
4. Click **Save** and **Start**

## Shelly Scripting Resources

- [Shelly Scripting Tutorial](https://shelly-api-docs.shelly.cloud/gen2/Scripts/Tutorial)
- [Shelly Script API Reference](https://shelly-api-docs.shelly.cloud/gen2/Scripts/ShellyScriptLanguageFeatures)
- [Shelly Script Examples](https://github.com/ALLTERCO/shelly-script-examples)
