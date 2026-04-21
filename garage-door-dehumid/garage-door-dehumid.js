/**
 * Garage Door -> Dehumidifier controller (raw BLE build)
 *
 * Host:    192.168.0.151 (must be within BLE range of the BLU DW sensor).
 * Target:  192.168.0.153 -- Shelly 1 Gen 4 dehumidifier, controlled via
 *          HTTP RPC at http://<host>/rpc/Switch.*.
 * Sensor:  Shelly BLU Door/Window, MAC 38:39:8f:f4:5f:61.
 *
 * Rules (debounced DEBOUNCE_MS):
 *   - Committed OPEN    -> cache current dehumidifier relay, then OFF
 *   - Committed CLOSED  -> turn dehumidifier ON only if cache was ON
 *
 * BTHome decoder adapted from the ALLTERCO BLU DW example:
 *   https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble/ble-shelly-dw.shelly.js
 */

let CONFIG = {
  SENSOR_MAC:        "38:39:8f:f4:5f:61",
  DEHUMID_HOST:      "192.168.0.153",
  DEHUMID_SWITCH_ID: 0,
  DEBOUNCE_MS:       30 * 1000,
  DEBUG:             true,
};

let TARGET_MAC = CONFIG.SENSOR_MAC.toLowerCase();

// ---- BTHome v2 decoder (from ALLTERCO example) ----

let uint8 = 0, int8 = 1, uint16 = 2, int16 = 3, uint24 = 4, int24 = 5;

let BTH = {
  0x00: { n: "pid",         t: uint8 },
  0x01: { n: "battery",     t: uint8 },
  0x02: { n: "temperature", t: int16,  f: 0.01 },
  0x03: { n: "humidity",    t: uint16, f: 0.01 },
  0x05: { n: "illuminance", t: uint24, f: 0.01 },
  0x1a: { n: "door",        t: uint8 },
  0x21: { n: "motion",      t: uint8 },
  0x2d: { n: "window",      t: uint8 },
  0x2e: { n: "humidity",    t: uint8 },
  0x3a: { n: "button",      t: uint8 },
  0x3f: { n: "rotation",    t: int16,  f: 0.1 },
  0x45: { n: "temperature", t: int16,  f: 0.1 },
};

let BTHOME_SVC_ID_STR = "fcd2";

function typeSize(t) {
  if (t === uint8  || t === int8)  return 1;
  if (t === uint16 || t === int16) return 2;
  if (t === uint24 || t === int24) return 3;
  return 255;
}

let BTHomeDecoder = {
  utoi: function (n, b) {
    let m = 1 << (b - 1);
    return (n & m) ? n - (1 << b) : n;
  },
  u8:  function (buf) { return buf.at(0); },
  i8:  function (buf) { return this.utoi(this.u8(buf), 8); },
  u16: function (buf) { return 0xffff & ((buf.at(1) << 8) | buf.at(0)); },
  i16: function (buf) { return this.utoi(this.u16(buf), 16); },
  u24: function (buf) { return 0xffffff & ((buf.at(2) << 16) | (buf.at(1) << 8) | buf.at(0)); },
  i24: function (buf) { return this.utoi(this.u24(buf), 24); },
  getVal: function (t, buf) {
    if (buf.length < typeSize(t)) return null;
    if (t === uint8)  return this.u8(buf);
    if (t === int8)   return this.i8(buf);
    if (t === uint16) return this.u16(buf);
    if (t === int16)  return this.i16(buf);
    if (t === uint24) return this.u24(buf);
    if (t === int24)  return this.i24(buf);
    return null;
  },
  unpack: function (buf) {
    if (typeof buf !== "string" || buf.length === 0) return null;
    let out = {};
    let dib = buf.at(0);
    out.encryption = !!(dib & 0x1);
    out.version    = dib >> 5;
    if (out.version !== 2) return null;
    if (out.encryption)    return out;
    buf = buf.slice(1);
    while (buf.length > 0) {
      let def = BTH[buf.at(0)];
      if (typeof def === "undefined") break;
      buf = buf.slice(1);
      let v = this.getVal(def.t, buf);
      if (v === null) break;
      if (typeof def.f !== "undefined") v = v * def.f;
      if (typeof out[def.n] === "undefined") out[def.n] = v;
      buf = buf.slice(typeSize(def.t));
    }
    return out;
  },
};

// ---- state ----

let committedState  = null; // "open" | "closed" | null
let pendingState    = null;
let debounceTimer   = null;
let debounceStartMs = 0;
let savedRelayState = null;
let lastRawState    = null;
let lastPacketId    = 0x100;
let bleTotal        = 0;
let targetParsed    = 0;
let firstTargetSeen = false;
let lastBattery     = null;

function log(msg) {
  if (CONFIG.DEBUG) print("[garage-dehumid] " + msg);
}

// ---- remote RPC to the dehumidifier ----

function remoteCall(method, params, cb) {
  let qs = "";
  if (params) {
    for (let k in params) {
      qs += (qs.length === 0 ? "?" : "&") + k + "=" + params[k];
    }
  }
  let url = "http://" + CONFIG.DEHUMID_HOST + "/rpc/" + method + qs;
  Shelly.call("HTTP.GET", { url: url, timeout: 5 }, function (res, err) {
    if (err) { if (cb) cb(null, err); return; }
    if (!res || res.code !== 200) {
      if (cb) cb(null, { msg: "http_status " + (res ? res.code : "?") });
      return;
    }
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) {}
    if (cb) cb(body, null);
  });
}

function getDehumidState(cb) {
  remoteCall("Switch.GetStatus", { id: CONFIG.DEHUMID_SWITCH_ID }, function (body, err) {
    if (err || !body) { cb(null, err || { msg: "empty body" }); return; }
    cb(!!body.output, null);
  });
}

function setDehumid(on, reason) {
  remoteCall(
    "Switch.Set",
    { id: CONFIG.DEHUMID_SWITCH_ID, on: on ? "true" : "false" },
    function (_body, err) {
      if (err) log("  Switch.Set FAILED (" + reason + "): " + JSON.stringify(err));
      else     log("  Switch.Set OK (" + reason + "): dehumidifier -> " + (on ? "ON" : "OFF"));
    }
  );
}

// ---- debounce + control ----

function onRawState(isOpen) {
  let state = isOpen ? "open" : "closed";

  if (state !== lastRawState) {
    log("raw flip: " + (lastRawState === null ? "(init)" : lastRawState) + " -> " + state);
    lastRawState = state;
  }

  if (committedState === null) {
    committedState = state;
    log("baseline committed: " + state + " (no action on baseline)");
    return;
  }

  if (state === committedState) {
    if (debounceTimer !== null) {
      let elapsed = Date.now() - debounceStartMs;
      Timer.clear(debounceTimer);
      debounceTimer = null;
      pendingState  = null;
      log("debounce CANCELLED after " + elapsed + "ms; reverted to " + state);
    }
    return;
  }

  if (pendingState === state && debounceTimer !== null) return;

  if (debounceTimer !== null) Timer.clear(debounceTimer);
  pendingState    = state;
  debounceStartMs = Date.now();
  log("debounce START: " + committedState + " -> " + state +
      " (must hold " + (CONFIG.DEBOUNCE_MS / 1000) + "s)");
  debounceTimer = Timer.set(CONFIG.DEBOUNCE_MS, false, function () {
    let s = pendingState;
    let elapsed = Date.now() - debounceStartMs;
    pendingState  = null;
    debounceTimer = null;
    log("debounce COMMIT after " + elapsed + "ms: " + committedState + " -> " + s);
    committedState = s;
    if (s === "open") handleOpen();
    else              handleClosed();
  });
}

function handleOpen() {
  log("ACTION OPEN: reading dehumidifier relay before turning OFF");
  getDehumidState(function (state, err) {
    if (err) {
      log("  remote GetStatus FAILED: " + JSON.stringify(err) + " (prior-state cache -> null)");
      savedRelayState = null;
    } else {
      savedRelayState = state;
      log("  cached prior dehumidifier state = " + (savedRelayState ? "ON" : "OFF"));
    }
    setDehumid(false, "OPEN action");
  });
}

function handleClosed() {
  let priorTxt = (savedRelayState === null) ? "UNKNOWN" : (savedRelayState ? "ON" : "OFF");
  log("ACTION CLOSED: cached prior dehumidifier state = " + priorTxt);
  if (savedRelayState === true) {
    log("  decision: prior was ON -> restoring dehumidifier to ON");
    setDehumid(true, "CLOSED action (restore)");
  } else {
    log("  decision: prior was " + priorTxt + " -> leaving dehumidifier UNCHANGED");
  }
  savedRelayState = null;
}

// ---- BLE scan callback ----

function scanCB(ev, res) {
  if (ev !== BLE.Scanner.SCAN_RESULT) return;
  bleTotal += 1;

  if (!res || !res.addr) return;
  if (res.addr.toLowerCase() !== TARGET_MAC) return;
  if (typeof res.service_data === "undefined") return;
  let raw = res.service_data[BTHOME_SVC_ID_STR];
  if (typeof raw === "undefined") return;

  let parsed = BTHomeDecoder.unpack(raw);
  if (parsed === null) { log("BTHome parse failed"); return; }

  // Dedupe repeated burst adverts with the same packet id.
  if (lastPacketId === parsed.pid) return;
  lastPacketId = parsed.pid;
  targetParsed += 1;

  if (!firstTargetSeen) {
    firstTargetSeen = true;
    log("SENSOR IDENTIFIED: mac=" + res.addr +
        " rssi=" + res.rssi +
        " window=" + parsed.window +
        " battery=" + parsed.battery + "%");
  }

  if (typeof parsed.battery !== "undefined" && parsed.battery !== lastBattery) {
    log("battery -> " + parsed.battery + "%" +
        (lastBattery !== null ? " (was " + lastBattery + "%)" : ""));
    lastBattery = parsed.battery;
  }

  if (typeof parsed.window === "undefined") return;
  onRawState(parsed.window === 1);
}

// ---- heartbeat + startup ----

function heartbeat() {
  log("heartbeat: ble_total=" + bleTotal +
      " target_parsed=" + targetParsed +
      " committed=" + (committedState === null ? "(none)" : committedState) +
      " savedRelay=" + (savedRelayState === null ? "null" : (savedRelayState ? "ON" : "OFF")));
}

function init() {
  log("starting: sensor_mac=" + TARGET_MAC +
      " target=http://" + CONFIG.DEHUMID_HOST +
      " switch_id=" + CONFIG.DEHUMID_SWITCH_ID +
      " debounce=" + (CONFIG.DEBOUNCE_MS / 1000) + "s");

  let bleCfg = Shelly.getComponentConfig("ble");
  if (!bleCfg || !bleCfg.enable) {
    log("BLE is DISABLED on this device; enable Settings > Bluetooth and restart");
    return;
  }
  log("BLE enabled");

  getDehumidState(function (state, err) {
    if (err) log("initial remote Switch.GetStatus FAILED: " + JSON.stringify(err));
    else     log("initial dehumidifier state: " + (state ? "ON" : "OFF"));
  });

  if (BLE.Scanner.isRunning()) {
    log("BLE scanner already running; subscribing");
  } else {
    let ok = BLE.Scanner.Start({
      duration_ms: BLE.Scanner.INFINITE_SCAN,
      active: true,
    });
    log("BLE.Scanner.Start returned: " + JSON.stringify(ok));
  }

  BLE.Scanner.Subscribe(scanCB);
  log("subscribed; waiting for packets from " + TARGET_MAC);

  Timer.set(60 * 1000, true, heartbeat);
}

init();
