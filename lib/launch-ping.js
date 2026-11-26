'use strict';
// The launch usage-statistics ping (#1073). On a new install the Welcome
// screen is still open when the 8 s launch timer fires, so the ping used to be
// dropped for good. This holds it until the operator's choice is saved: it is
// sent then only if the "Share anonymous usage statistics" box is still ticked,
// and never if it was unticked.
//   allowed()  true when telemetry is on AND Welcome is finished (main.js telemetryAllowed)
//   waiting()  true while Welcome is still open (settings.firstRun)
//   send()     sends the ping
function createLaunchPing({ allowed, waiting, send }) {
  let pending = false;
  let sent = false;
  function fire() { sent = true; pending = false; send(); return true; }
  return {
    // The launch timer.
    onLaunchTimer() {
      if (sent) return false;
      if (allowed()) return fire();
      if (waiting()) pending = true; // Welcome is up: wait for the saved choice
      return false;
    },
    // After every settings save.
    onSettingsSaved() {
      if (!pending || sent) return false;
      if (waiting()) return false;   // still on the Welcome screen
      if (allowed()) return fire();
      pending = false;               // the operator unticked the box: send nothing
      return false;
    },
  };
}

module.exports = { createLaunchPing };
