'use strict';
/**
 * A rig's saved audio devices follow the device by NAME when its ID changes
 * (AE5JE 2026-10-26). Pure, dual-mode (require + window.AudioDeviceHeal).
 *
 * Chromium hands out a device ID that is a per-install hash. When that hash
 * changes — a new USB port, a Windows driver update, or security software
 * resetting the app's browser storage (his Bitdefender) — the saved ID matches
 * nothing: the Settings boxes show blank, FT8 hears silence and Tune refuses.
 * WSJT-X picks by name and never noticed.
 *
 * Rules:
 *  - The ID that is present wins. While it is, its label is LEARNED onto the
 *    rig (`remoteAudioInputLabel` / `remoteAudioOutputLabel`), so a later ID
 *    change can be followed.
 *  - A missing ID is replaced only by the ONE device of the same kind whose
 *    label is EXACTLY the saved label. Two identical devices = ambiguous =
 *    left alone (picking one could be the wrong radio). No label = left alone.
 *    A different device is never chosen: a chosen device is never silently
 *    replaced (CLAUDE.md audio rule) — this is the same device, renamed by ID.
 *  - Role IDs ('default', 'communications') and raw ALSA IDs are not
 *    enumerated devices; they are never touched.
 */

const KINDS = [
  { kind: 'audioinput', idKey: 'remoteAudioInput', labelKey: 'remoteAudioInputLabel', word: 'input' },
  { kind: 'audiooutput', idKey: 'remoteAudioOutput', labelKey: 'remoteAudioOutputLabel', word: 'output' },
];

function untouchable(id) {
  return !id || id === 'default' || id === 'communications' || /^alsa:/.test(id);
}

/**
 * @param {Array<object>} rigs     settings.rigs (not mutated)
 * @param {Array<{kind:string, deviceId:string, label:string}>} devices  enumerateDevices()
 * @returns {{ changed: boolean, rigs: Array<object>, notes: string[] }}
 *   notes = one log line per device that was followed to a new ID (or could not be)
 */
function healRigAudioDevices(rigs, devices) {
  const list = Array.isArray(devices) ? devices : [];
  const out = { changed: false, rigs: [], notes: [] };
  // Labels are blank until the page has media permission: learn nothing then.
  const labelsKnown = list.some((d) => d && d.label);
  for (const rig0 of Array.isArray(rigs) ? rigs : []) {
    if (!rig0 || typeof rig0 !== 'object') { out.rigs.push(rig0); continue; }
    let rig = rig0;
    for (const k of KINDS) {
      const id = rig[k.idKey];
      if (untouchable(id)) continue;
      const ofKind = list.filter((d) => d && d.kind === k.kind);
      const present = ofKind.find((d) => d.deviceId === id);
      if (present) {
        const label = String(present.label || '').trim();
        if (labelsKnown && label && rig[k.labelKey] !== label) {
          rig = { ...rig, [k.labelKey]: label };
          out.changed = true;
        }
        continue;
      }
      const want = String(rig[k.labelKey] || '').trim();
      if (!want || !labelsKnown) continue;
      const same = ofKind.filter((d) => String(d.label || '').trim() === want);
      const name = rig.name || rig.id || 'rig';
      if (same.length === 1) {
        rig = { ...rig, [k.idKey]: same[0].deviceId };
        out.changed = true;
        out.notes.push(`[Audio] ${name}: the ${k.word} "${want}" came back under a new device ID (USB port, driver update, or security software resetting POTACAT's storage) — following it by name`);
      } else if (same.length > 1) {
        out.notes.push(`[Audio] ${name}: the saved ${k.word} "${want}" is gone and ${same.length} devices share that name — not guessing; pick it again in Settings > My Rigs > Audio`);
      }
    }
    out.rigs.push(rig);
  }
  return out;
}

const api = { healRigAudioDevices, KINDS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.AudioDeviceHeal = api;
