/**************************************
 * Shelly Plus i4 - Local relay control (maintained switches)
 *
 * Maps physical inputs on a Shelly i4 to relay outputs on one or more
 * remote Shelly devices via local HTTP RPC. Supports 1-4 inputs paired
 * with any combination of output devices.
 *
 * NOTE: Target devices must have static IPs or resolvable internal DNS names.
 *
 * Example mapping:
 *   Input 0 -> 192.168.0.151 Switch id 2
 *   Input 1 -> 192.168.0.151 Switch id 1
 *   Input 2 -> 192.168.0.152 Switch id 1
 *
 * Uses local RPC:
 *   http://<ip>/rpc/Switch.Set?id=<n>&on=true|false
 **************************************/

let CFG = {
  DEBUG: false,
  DEBOUNCE_MS: 150,
  HTTP_TIMEOUT: 4
};

// Map i4 inputs to target relays
let MAP = [
  { inputId: 0, ip: "192.168.0.151", switchId: 2 },
  { inputId: 1, ip: "192.168.0.151", switchId: 1 },
  { inputId: 2, ip: "192.168.0.152", switchId: 1 }
];

function log() {
  if (!CFG.DEBUG) return;
  let a = [];
  for (let i = 0; i < arguments.length; i++) a.push(arguments[i]);
  print.apply(null, a);
}

function httpGet(url, cb) {
  Shelly.call("HTTP.GET", { url: url, timeout: CFG.HTTP_TIMEOUT }, function (res, err_code, err_msg) {
    if (err_code !== 0) return cb(false, "HTTP.GET err " + err_code + " " + err_msg);
    if (!res || res.code !== 200) return cb(false, "HTTP " + (res ? res.code : "null") + " body " + (res ? res.body : ""));
    cb(true, null);
  }, null);
}

function rpcSwitchSet(ip, switchId, on) {
  let url = "http://" + ip + "/rpc/Switch.Set?id=" + switchId + "&on=" + (on ? "true" : "false");
  httpGet(url, function (ok, err) {
    if (!ok) print("Switch.Set failed:", ip, "id", switchId, err);
  });
}

function getInputState(inputId, cb) {
  Shelly.call("Input.GetStatus", { id: inputId }, function (res, err_code, err_msg) {
    if (err_code !== 0 || !res) {
      print("Input.GetStatus failed for", inputId, ":", err_code, err_msg);
      return cb(null);
    }
    cb(!!res.state);
  }, null);
}

let lastFireByInput = {};

// Sync one mapping entry: read input -> set relay to same state
function syncOne(m) {
  getInputState(m.inputId, function (state) {
    if (state === null) return;
    log("Input", m.inputId, "=>", state, "setting", m.ip, "switch", m.switchId);
    rpcSwitchSet(m.ip, m.switchId, state);
  });
}

// Debounced handler for input events
function handleEvent(ev) {
  if (!ev || !ev.component) return;
  if (ev.component.indexOf("input:") !== 0) return;

  let inputId = ev.id;
  if (typeof inputId === "undefined" || inputId === null) {
    // fallback: component like "input:0"
    inputId = parseInt(ev.component.split(":")[1]);
  }
  if (isNaN(inputId)) return;

  let now = Date.now();
  let last = lastFireByInput[inputId] || 0;
  if (now - last < CFG.DEBOUNCE_MS) return;
  lastFireByInput[inputId] = now;

  // Find mapping and sync
  for (let i = 0; i < MAP.length; i++) {
    if (MAP[i].inputId === inputId) {
      syncOne(MAP[i]);
      return;
    }
  }
}

Shelly.addEventHandler(function (ev) {
  if (CFG.DEBUG) print("EV:", JSON.stringify(ev));
  handleEvent(ev);
}, null);

// Optional: sync all on boot so relay states match the physical switches after reboot
Timer.set(800, false, function () {
  for (let i = 0; i < MAP.length; i++) syncOne(MAP[i]);
});

print("i4 local relay mapping loaded");
