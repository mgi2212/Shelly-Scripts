// FlexRadio Hard Power Cycle + Watchdog
//
// Device: Shelly with two outputs (e.g., Shelly Plus 2PM)
//
// Output 1 (OUT1): Controls a normally closed 30A relay for mains power.
//                   ON = relay open (power cut), OFF = relay closed (power on).
// Output 0 (OUT0): Open drain output connected to the REM ON jack on the
//                   rear of the FlexRadio transceiver.
//                   ON = assert REM ON (radio powers up), OFF = de-assert.
//
// Manual power cycle (triggered by turning OUT1 ON):
//   1. Immediately:  OUT0 OFF  — de-assert REM ON (signal radio to shut down)
//   2. After 60s:    OUT1 OFF  — close relay, restoring mains power
//   3. After 120s:   OUT0 ON   — assert REM ON, booting the radio back up
//
// Watchdog:
//   Queries a companion Python script (flexradio-watchdog.py) running
//   on a PC or Mac. The Python script periodically connects to the
//   SmartSDR API (TCP 4992) and sends a ping command to verify the
//   process is alive, then disconnects. It exposes the result via HTTP.
//   The Shelly polls the /alive endpoint — returns "1" (alive) or "0".
//   After WATCHDOG_FAIL_COUNT consecutive "0" responses, waits
//   WATCHDOG_HOLD_OFF then triggers the power cycle sequence.
//
// Safety:
//   - If the proxy is unreachable (PC off, script not running), the
//     watchdog does NOTHING — no accidental power cycles.
//   - Only an explicit "0" from the proxy counts as a failure.
//   - Exponential backoff on retries: if a watchdog-triggered power
//     cycle doesn't fix the problem, subsequent attempts wait longer
//     (5m, 10m, 20m, 40m cap). After WATCHDOG_MAX_CYCLES gives up
//     entirely. Set WATCHDOG_MAX_CYCLES=0 for unlimited retries
//     (backoff still applies, capped at ~40 minutes between attempts).
//
// Battery monitoring (solar / off-grid):
//   Reads voltage from the Shelly's built-in power meter. Three thresholds:
//     BATTERY_MIN_CYCLE_V  — block watchdog power cycles below this voltage
//     BATTERY_CRITICAL_V   — shed load (shut down radio) to protect battery
//     BATTERY_RESUME_V     — restore radio when voltage recovers (hysteresis)
//   Set BATTERY_ENABLED = false to skip (default). Battery monitor starts
//   immediately on boot (no grace period) to protect the battery ASAP.
//
// Enable/disable:
//   Virtual (HTTP API):
//     http://<shelly>/rpc/KVS.Set?key="watchdog_enabled"&value=true
//     http://<shelly>/rpc/KVS.Set?key="watchdog_enabled"&value=false
//   Physical input (optional):
//     Set WATCHDOG_INPUT to an input ID (e.g., 0 or 1). When the input
//     is ON, watchdog is enabled. Set to -1 to disable this feature.

// Config
let OUT0 = 0;
let OUT1 = 1;
let WAIT_TIME = 60000; // 60 seconds

// Watchdog config
let WATCHDOG_ENABLED = true;
let PROXY_IP = "192.168.0.20";         // IP of PC running flexradio-watchdog.py
let PROXY_PORT = 8080;                  // HTTP port of the watchdog proxy
let WATCHDOG_INTERVAL = 30000;          // check every 30s
let WATCHDOG_TIMEOUT = 5;               // HTTP timeout in seconds
let WATCHDOG_FAIL_COUNT = 3;            // consecutive "radio down" before cycle
let WATCHDOG_HOLD_OFF = 60000;          // wait 60s after failure confirmed before cycling
let WATCHDOG_BOOT_GRACE = 300000;       // 5 min grace after Shelly boot (radio may still be starting)
let WATCHDOG_MAX_CYCLES = 3;            // max watchdog-triggered cycles before giving up (0 = unlimited)
let WATCHDOG_INPUT = -1;                // physical input ID to enable/disable (-1 = not used)

// Battery monitoring config (for solar / off-grid sites)
// Reads voltage from the Shelly's own power meter on BATTERY_SWITCH_ID.
// Set BATTERY_ENABLED = false to skip battery checks entirely.
let BATTERY_ENABLED = false;
let BATTERY_SWITCH_ID = 0;              // which switch output to read voltage from
let BATTERY_CHECK_INTERVAL = 60000;     // check battery every 60s
let BATTERY_MIN_CYCLE_V = 12.0;         // don't allow power cycle below this voltage
let BATTERY_CRITICAL_V = 11.5;          // shed load: shut down radio to protect battery
let BATTERY_RESUME_V = 12.5;            // hysteresis: resume radio when voltage recovers above this
// Example thresholds for common battery banks:
//   12V: critical=11.5  min_cycle=12.0  resume=12.5
//   24V: critical=23.0  min_cycle=24.0  resume=25.0
//   48V: critical=46.0  min_cycle=48.0  resume=50.0

let KVS_KEY = "watchdog_enabled";

let sequenceRunning = false;
let failCount = 0;
let watchdogTimer = null;
let cycleCount = 0;                     // consecutive watchdog-triggered cycles (resets when radio comes back)
let batteryTimer = null;
let loadShed = false;                   // true when radio was shut down due to low battery

function log(msg) { print("[FlexCycle] " + msg); }

// ---- Watchdog enable/disable ----

// Check if the watchdog is allowed to act (both virtual and physical).
// Calls back with true (enabled) or false (disabled).
function isWatchdogEnabled(cb) {
  // Check KVS first
  Shelly.call("KVS.Get", { key: KVS_KEY }, function (res, err) {
    let kvsEnabled = true; // default to enabled if key doesn't exist
    if (err === 0 && res && typeof res.value !== "undefined") {
      // KVS stores strings — accept "true", "1", true, 1
      let v = res.value;
      kvsEnabled = (v === true || v === "true" || v === 1 || v === "1");
    }

    if (!kvsEnabled) {
      cb(false);
      return;
    }

    // If no physical input configured, we're done
    if (WATCHDOG_INPUT < 0) {
      cb(true);
      return;
    }

    // Check physical input state
    Shelly.call("Input.GetStatus", { id: WATCHDOG_INPUT }, function (res, err) {
      if (err !== 0 || !res) {
        log("Input.GetStatus failed for input " + WATCHDOG_INPUT + ", assuming enabled");
        cb(true);
        return;
      }
      cb(!!res.state);
    });
  });
}

// Set the KVS enable/disable key
function setWatchdogEnabled(enabled) {
  Shelly.call("KVS.Set", { key: KVS_KEY, value: enabled }, function (res, err) {
    if (err !== 0) {
      log("KVS.Set failed: " + err);
      return;
    }
    log("Watchdog " + (enabled ? "enabled" : "disabled") + " via KVS");
    if (enabled) {
      startWatchdog();
    } else {
      stopWatchdog();
    }
  });
}

// ---- Battery monitoring ----

// Read battery voltage from the Shelly's power meter.
// Calls back with voltage (number) or null on error.
function getBatteryVoltage(cb) {
  Shelly.call("Switch.GetStatus", { id: BATTERY_SWITCH_ID }, function (res, err) {
    if (err !== 0 || !res || typeof res.voltage !== "number") {
      log("Battery voltage read failed: err=" + err);
      cb(null);
      return;
    }
    cb(res.voltage);
  });
}

// Shed load: gracefully shut down the radio to protect the battery.
function shedLoad() {
  if (loadShed || sequenceRunning) return;
  loadShed = true;
  log("BATTERY CRITICAL — shedding load (shutting down radio)");

  // De-assert REM ON first (graceful shutdown signal), then cut power after delay
  Shelly.call("Switch.Set", { id: OUT0, on: false }, function (res, err) {
    Timer.set(WAIT_TIME, false, function () {
      Shelly.call("Switch.Set", { id: OUT1, on: true }); // open NC relay = cut power
      log("Load shed complete — radio powered off");
    });
  });
}

// Resume from load shed: restore power and boot the radio.
function resumeFromShed() {
  if (!loadShed) return;
  log("Battery recovered above " + BATTERY_RESUME_V + "V — restoring radio");
  loadShed = false;

  // Close relay (restore mains), then assert REM ON after delay
  Shelly.call("Switch.Set", { id: OUT1, on: false }, function (res, err) {
    Timer.set(WAIT_TIME, false, function () {
      Shelly.call("Switch.Set", { id: OUT0, on: true }, function (res, err) {
        log("Radio restored from load shed");
      });
    });
  });
}

// Periodic battery check
function checkBattery() {
  getBatteryVoltage(function (v) {
    if (v === null) return;

    if (loadShed) {
      // Currently shed — check if recovered
      if (v >= BATTERY_RESUME_V) {
        resumeFromShed();
      } else {
        log("Battery " + v + "V — still below resume threshold (" + BATTERY_RESUME_V + "V)");
      }
    } else {
      // Normal operation — check for critical
      if (v <= BATTERY_CRITICAL_V) {
        shedLoad();
      }
    }
  });
}

function startBatteryMonitor() {
  if (!BATTERY_ENABLED) return;
  if (batteryTimer !== null) return;

  batteryTimer = Timer.set(BATTERY_CHECK_INTERVAL, true, function () {
    checkBattery();
  });
  log("Battery monitor started (interval " + (BATTERY_CHECK_INTERVAL / 1000) + "s, "
      + "critical=" + BATTERY_CRITICAL_V + "V, min_cycle=" + BATTERY_MIN_CYCLE_V + "V, "
      + "resume=" + BATTERY_RESUME_V + "V)");

  // Run an initial check
  checkBattery();
}

// ---- Power cycle sequence ----

function runPowerCycle(trigger) {
  if (sequenceRunning) {
    log("Cycle already running, ignoring trigger: " + trigger);
    return;
  }
  sequenceRunning = true;
  stopWatchdog();
  log("Power cycle started (" + trigger + ")");

  // Step 1: OUT0 OFF — de-assert REM ON
  Shelly.call("Switch.Set", { id: OUT0, on: false }, function (res, err) {
    if (err !== 0) {
      log("Step 1 failed: error " + err);
      sequenceRunning = false;
      startWatchdog();
      return;
    }

    // Step 2: wait 60s -> OUT1 OFF — restore mains power
    Timer.set(WAIT_TIME, false, function () {
      Shelly.call("Switch.Set", { id: OUT1, on: false }, function (res, err) {
        if (err !== 0) {
          log("Step 2 failed: error " + err);
          sequenceRunning = false;
          startWatchdog();
          return;
        }

        // Step 3: wait 60s -> OUT0 ON — boot the radio
        Timer.set(WAIT_TIME, false, function () {
          Shelly.call("Switch.Set", { id: OUT0, on: true }, function (res, err) {
            if (err !== 0) {
              log("Step 3 failed: error " + err);
            }
            sequenceRunning = false;
            log("Power cycle complete");
            if (trigger === "watchdog") {
              cycleCount++;
              if (WATCHDOG_MAX_CYCLES > 0 && cycleCount >= WATCHDOG_MAX_CYCLES) {
                log("Max watchdog cycles (" + WATCHDOG_MAX_CYCLES + ") reached — giving up. Manual intervention required.");
                return;
              }
              // Exponential backoff: grace doubles each cycle (5m, 10m, 20m, ...)
              // Capped at 30 minutes to avoid absurd waits on unlimited retries
              let backoff = WATCHDOG_BOOT_GRACE * Math.pow(2, Math.min(cycleCount - 1, 3));
              let label = WATCHDOG_MAX_CYCLES > 0
                ? "cycle " + cycleCount + "/" + WATCHDOG_MAX_CYCLES
                : "cycle " + cycleCount + " (unlimited)";
              log("Backoff: waiting " + (backoff / 1000) + "s before resuming watchdog (" + label + ")");
              Timer.set(backoff, false, function () {
                startWatchdog();
              });
            } else {
              startWatchdog();
            }
          });
        });
      });
    });
  });
}

// ---- Manual trigger (OUT1 switched ON) ----

Shelly.addStatusHandler(function (event) {
  if (event.component !== "switch:" + OUT1) return;

  if (event.delta && event.delta.output === true && !sequenceRunning) {
    runPowerCycle("manual");
  }
});

// ---- Watch for physical input toggle (if configured) ----

if (WATCHDOG_INPUT >= 0) {
  Shelly.addEventHandler(function (ev) {
    if (!ev || ev.name !== "input" || !ev.info) return;
    if (ev.info.id !== WATCHDOG_INPUT) return;

    // Input toggled — check new state
    Shelly.call("Input.GetStatus", { id: WATCHDOG_INPUT }, function (res, err) {
      if (err !== 0 || !res) return;
      if (res.state) {
        log("Physical input " + WATCHDOG_INPUT + " ON — enabling watchdog");
        startWatchdog();
      } else {
        log("Physical input " + WATCHDOG_INPUT + " OFF — disabling watchdog");
        stopWatchdog();
      }
    });
  });
}

// ---- Watchdog ----

function pingRadio() {
  if (sequenceRunning) return;

  // Check if watchdog is still enabled before acting
  isWatchdogEnabled(function (enabled) {
    if (!enabled) {
      log("Watchdog disabled — skipping check");
      stopWatchdog();
      return;
    }

    // Query the Python watchdog proxy's /alive endpoint.
    // Returns "1" if SmartSDR ping succeeded, "0" if not.
    let url = "http://" + PROXY_IP + ":" + PROXY_PORT + "/alive";
    Shelly.call("HTTP.GET", { url: url, timeout: WATCHDOG_TIMEOUT },
      function (res, err_code, err_msg) {
        if (sequenceRunning) return;

        // Proxy unreachable — do nothing (PC may be off)
        if (err_code !== 0 || !res) {
          if (failCount > 0) {
            log("Proxy unreachable — resetting fail count (safe mode)");
          }
          failCount = 0;
          return;
        }

        // Proxy responded — check the result
        if (res.code === 200 && res.body === "1") {
          // Radio is alive
          if (failCount > 0 || cycleCount > 0) {
            log("Radio alive — resetting fail count and cycle count");
          }
          failCount = 0;
          cycleCount = 0;
          return;
        }

        // Proxy explicitly reports radio is down
        failCount++;
        log("Radio down (" + failCount + "/" + WATCHDOG_FAIL_COUNT
            + ") proxy: " + (res.body || "?"));

        if (failCount >= WATCHDOG_FAIL_COUNT) {
          log("Radio unresponsive — holding off " + (WATCHDOG_HOLD_OFF / 1000) + "s before power cycle");
          stopWatchdog();
          Timer.set(WATCHDOG_HOLD_OFF, false, function () {
            // Battery gate: don't power cycle if voltage is too low
            if (!BATTERY_ENABLED) {
              failCount = 0;
              runPowerCycle("watchdog");
              return;
            }
            getBatteryVoltage(function (v) {
              if (v !== null && v < BATTERY_MIN_CYCLE_V) {
                log("Battery too low (" + v + "V < " + BATTERY_MIN_CYCLE_V + "V) — skipping power cycle");
                failCount = 0;
                startWatchdog();
                return;
              }
              if (v !== null) {
                log("Battery OK (" + v + "V) — proceeding with power cycle");
              }
              failCount = 0;
              runPowerCycle("watchdog");
            });
          });
        }
      }, null);
  });
}

function startWatchdog() {
  if (!WATCHDOG_ENABLED) return;
  if (watchdogTimer !== null) return;

  failCount = 0;
  watchdogTimer = Timer.set(WATCHDOG_INTERVAL, true, function () {
    pingRadio();
  });
  log("Watchdog started (interval " + (WATCHDOG_INTERVAL / 1000) + "s, "
      + "threshold " + WATCHDOG_FAIL_COUNT + " failures)");
}

function stopWatchdog() {
  if (watchdogTimer !== null) {
    Timer.clear(watchdogTimer);
    watchdogTimer = null;
    log("Watchdog stopped");
  }
}

// ---- Init ----

// Initialize KVS key if it doesn't exist, then start after boot grace period.
// The grace period prevents the watchdog from power-cycling a radio that is
// still booting after a shared power outage.
Timer.set(2000, false, function () {
  log("Script loaded");
  Shelly.call("KVS.Get", { key: KVS_KEY }, function (res, err) {
    if (err !== 0 || !res || typeof res.value === "undefined") {
      Shelly.call("KVS.Set", { key: KVS_KEY, value: true });
      log("KVS key '" + KVS_KEY + "' initialized to true");
    }
    // Start battery monitor immediately (no grace period — protect the battery ASAP)
    startBatteryMonitor();

    log("Boot grace period: " + (WATCHDOG_BOOT_GRACE / 1000) + "s — watchdog will not act until then");
    Timer.set(WATCHDOG_BOOT_GRACE, false, function () {
      log("Boot grace period ended");
      isWatchdogEnabled(function (enabled) {
        if (enabled) {
          startWatchdog();
        } else {
          log("Watchdog disabled at startup");
        }
      });
    });
  });
});
