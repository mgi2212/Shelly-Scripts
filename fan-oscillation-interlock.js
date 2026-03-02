// Shelly Gen3 2PM (Scripting) - Latching wall switches
//
// Interlocks a fan and its oscillation motor on a single Shelly 2PM.
// Ensures the oscillation motor cannot run without the fan, and turns
// off oscillation if the fan is switched off — unless the change came
// from a physical wall switch (grace window to allow manual override).
//
// Output 0 = Fans power
// Output 1 = Oscillation motor
//
// Rule (enforced ONLY for non-physical control):
// - Oscillation (O1) must NOT be ON when Fans (O0) are OFF.
// - If a wall switch action (Input0/Input1) caused the change, do NOT enforce.

const FAN_ID = 0;
const OSC_ID = 1;

const PHYSICAL_GRACE_MS = 2500; // a bit longer for latching toggles + relay response

let physicalOverrideUntil = { 0: 0, 1: 0 };
let state = { 0: null, 1: null };

function now() { return Date.now(); }
function inPhysicalOverride(id) { return now() < (physicalOverrideUntil[id] || 0); }
function markPhysicalOverride(id) { physicalOverrideUntil[id] = now() + PHYSICAL_GRACE_MS; }

function log(msg) { print("[Fans/Osc] " + msg); }

function swSet(id, on, cb) {
  Shelly.call("Switch.Set", { id: id, on: !!on }, function (res, err) {
    if (err) log("Switch.Set id=" + id + " on=" + on + " ERROR: " + JSON.stringify(err));
    if (cb) cb(res, err);
  });
}

function swGet(id, cb) {
  Shelly.call("Switch.GetStatus", { id: id }, function (res, err) {
    if (err) { log("Switch.GetStatus id=" + id + " ERROR: " + JSON.stringify(err)); cb(null, err); return; }
    cb(res, null);
  });
}

// Enforce only when NOT in physical override.
// If Osc turns ON (non-physical) while Fan is OFF -> turn Fan ON.
// If Fan turns OFF (non-physical) while Osc is ON -> turn Osc OFF.
function enforceInvariant(trigger) {
  if (inPhysicalOverride(FAN_ID) || inPhysicalOverride(OSC_ID)) {
    log("Skip enforce (" + trigger + "): physical override active");
    return;
  }

  const fanOn = state[FAN_ID];
  const oscOn = state[OSC_ID];

  if (fanOn === null || oscOn === null) {
    swGet(FAN_ID, function (fanRes) {
      if (fanRes && typeof fanRes.output === "boolean") state[FAN_ID] = fanRes.output;
      swGet(OSC_ID, function (oscRes) {
        if (oscRes && typeof oscRes.output === "boolean") state[OSC_ID] = oscRes.output;
        enforceInvariant(trigger + "/refreshed");
      });
    });
    return;
  }

  if (oscOn && !fanOn) {
    log("Invariant violated (" + trigger + "): osc ON while fan OFF -> turning fan ON (non-physical).");
    swSet(FAN_ID, true, function () { state[FAN_ID] = true; });
  }
}

// ---- Detect physical wall switch actions ----
// When a wall switch toggles, mark that channel as "physical" for a short grace window.
// This prevents the script from enforcing during manual operation.
//
// Assumption: Input0 is wired to control Output0, Input1 wired to Output1.
Shelly.addEventHandler(function (ev) {
  if (!ev || ev.name !== "input" || !ev.info || typeof ev.info.id !== "number") return;

  const inId = ev.info.id;
  if (inId === FAN_ID || inId === OSC_ID) {
    markPhysicalOverride(inId);
    log("Wall switch action on Input " + inId + " -> disable enforcement briefly");
  }
});

// ---- Track output state changes + enforce when appropriate ----
Shelly.addStatusHandler(function (st) {
  if (!st || !st.component || !st.delta) return;

  if (st.component === "switch:" + FAN_ID && typeof st.delta.output === "boolean") {
    state[FAN_ID] = st.delta.output;

    if (state[FAN_ID] === false && state[OSC_ID] === true) {
      if (inPhysicalOverride(FAN_ID) || inPhysicalOverride(OSC_ID)) {
        log("Fan OFF observed, but manual control active -> not enforcing");
      } else {
        log("Fan OFF (non-physical) while osc ON -> turning osc OFF");
        swSet(OSC_ID, false);
        state[OSC_ID] = false;
      }
    }
    return;
  }

  if (st.component === "switch:" + OSC_ID && typeof st.delta.output === "boolean") {
    state[OSC_ID] = st.delta.output;

    if (state[OSC_ID] === true && state[FAN_ID] === false) {
      enforceInvariant("osc_on");
    }
    return;
  }
});

// Initial sync
swGet(FAN_ID, function (fanRes) {
  if (fanRes && typeof fanRes.output === "boolean") state[FAN_ID] = fanRes.output;
  swGet(OSC_ID, function (oscRes) {
    if (oscRes && typeof oscRes.output === "boolean") state[OSC_ID] = oscRes.output;
    log("Init state: fan=" + state[FAN_ID] + " osc=" + state[OSC_ID]);
    enforceInvariant("init");
  });
});
