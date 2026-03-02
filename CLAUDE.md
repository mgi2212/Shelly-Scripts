# CLAUDE.md

## Project Overview
This repository contains JavaScript scripts for Shelly smart home devices. Scripts target the Shelly scripting engine (based on mJS, a subset of ES6).

## Shelly Scripting Conventions
- Scripts use the Shelly scripting API (mJS) — not full Node.js or browser JS
- Available APIs: `Shelly`, `Timer`, `MQTT`, `HTTP`, `BLE`, `Virtual`
- Keep scripts small — Shelly devices have limited memory (~30KB script size)
- Use `Shelly.call()` for RPC calls and `Shelly.addEventHandler()` for events
- No `require()` / modules — each script is self-contained
- Supported types: number, string, boolean, object, array, null, undefined
- No closures over large objects; minimize global state

## Code Style
- Use clear, descriptive variable names
- Add a comment block at the top of each script describing its purpose
- Prefer simple, linear logic over complex abstractions
