// FlexRadio Hard Power Cycle
//
// Device: Shelly with two outputs (e.g., Shelly Plus 2PM)
//
// Output 1 (OUT1): Controls a normally closed 30A relay for mains power.
//                   ON = relay open (power cut), OFF = relay closed (power on).
// Output 0 (OUT0): Open drain output connected to the REM ON jack on the
//                   rear of the FlexRadio transceiver.
//                   ON = assert REM ON (radio powers up), OFF = de-assert.
//
// Sequence (triggered by turning OUT1 ON):
//   1. Immediately:  OUT0 OFF  — de-assert REM ON (signal radio to shut down)
//   2. After 60s:    OUT1 OFF  — close relay, restoring mains power
//   3. After 120s:   OUT0 ON   — assert REM ON, booting the radio back up

// Config
let OUT0 = 0;
let OUT1 = 1;
let WAIT_TIME = 60000; // 60 seconds

let sequenceRunning = false;

Shelly.addStatusHandler(function (event) {
  // Only care about Output 1 status changes
  if (event.component !== "switch:" + OUT1) return;

  // Trigger when OUT1 becomes ON
  if (event.delta && event.delta.output === true && !sequenceRunning) {
    sequenceRunning = true;

    // Step 1: OUT0 OFF
    Shelly.call("Switch.Set", { id: OUT0, on: false }, function (res, err) {
      if (err !== 0) {
        print("Step 1 failed: error " + err);
        sequenceRunning = false;
        return;
      }

      // Step 2: wait 60s -> OUT1 OFF
      Timer.set(WAIT_TIME, false, function () {
        Shelly.call("Switch.Set", { id: OUT1, on: false }, function (res, err) {
          if (err !== 0) {
            print("Step 2 failed: error " + err);
            sequenceRunning = false;
            return;
          }

          // Step 3: wait 60s -> OUT0 ON
          Timer.set(WAIT_TIME, false, function () {
            Shelly.call("Switch.Set", { id: OUT0, on: true }, function (res, err) {
              if (err !== 0) {
                print("Step 3 failed: error " + err);
              }
              sequenceRunning = false;
            });
          });
        });
      });
    });
  }
});
