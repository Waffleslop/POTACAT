// A shorter first run: the steps of the Welcome flow, where it resumes, and the
// local milestone markers a later "getting started" card ticks from.
//
// The flow is one decision per screen inside the Welcome dialog:
//   station  callsign, grid square, look, and the usage statistics choice
//   where    where the radio is: here, another computer running POTACAT, or
//            no radio yet
// Later steps (which radio, the radio check, ...) are added to STEPS as they
// are built; each screen's code asks this module what comes next.
//
// settings.firstRun turns false when the station step is finished, not at the
// end of the flow. main.js telemetryAllowed() and lib/launch-ping.js key off
// firstRun, so nothing is sent before the operator has seen the statistics
// choice on that screen, and nothing waits on the later steps.
//
// State lives in settings.firstRunState (a machine-scoped key, main.js
// GLOBAL_KEYS): { step, where, draft, milestones }. Everything here is pure;
// the renderer saves what these functions return. No telemetry: the markers
// stay on this computer.
//
// Dual-mode: require() in tests, window.FirstRun in the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirstRun = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEPS = ['station', 'where'];

  // The three answers to "Where is your radio?" and what each one opens.
  //   here    the radio is on this computer or its network: the rig editor
  //   remote  another computer runs POTACAT with the radio: the shack pairing panel
  //   none    no radio yet: close the flow, the spots table is the main window
  const WHERE = {
    here: { action: 'rig-editor' },
    remote: { action: 'remote-panel' },
    none: { action: 'spots' },
  };

  // Local markers, each a time (ms) or absent. phoneConnected also reads the
  // existing settings.echocatAppConnected flag, so a phone that connected
  // before this module existed still counts.
  const MILESTONES = ['radioCheck', 'cloudOn', 'phoneConnected', 'firstQso', 'logImported'];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** A clean state from whatever settings.firstRunState holds (missing, old, damaged). */
  function normalize(raw) {
    const r = isObj(raw) ? raw : {};
    const out = {
      step: STEPS.includes(r.step) ? r.step : 'station',
      where: Object.prototype.hasOwnProperty.call(WHERE, r.where) ? r.where : null,
      draft: null,
      milestones: {},
    };
    if (r.step === 'done') out.step = 'done';
    if (isObj(r.draft)) {
      out.draft = {
        callsign: typeof r.draft.callsign === 'string' ? r.draft.callsign.slice(0, 12) : '',
        grid: typeof r.draft.grid === 'string' ? r.draft.grid.slice(0, 8) : '',
      };
    }
    if (isObj(r.milestones)) {
      for (const k of MILESTONES) {
        const t = Number(r.milestones[k]);
        if (Number.isFinite(t) && t > 0) out.milestones[k] = t;
      }
    }
    return out;
  }

  /**
   * Which step to open, or null for none.
   * A new install (firstRun) opens at the station step, every launch until that
   * step is finished. force (F11, "set up again") opens at the station step,
   * with the saved values filled in. An existing install, or one that finished
   * the station step, sees nothing unasked: a later step is resumed from the
   * getting-started card, never by reopening the flow at launch.
   */
  function openAt(settings, opts) {
    const s = settings || {};
    if ((opts && opts.force) || s.firstRun) return 'station';
    return null;
  }

  /** The step a card's "continue" opens: where the operator stopped. */
  function resumeStep(settings) {
    const s = settings || {};
    if (s.firstRun) return 'station';
    const st = normalize(s.firstRunState);
    return st.step === 'done' ? null : st.step;
  }

  function stepIndex(step) { return STEPS.indexOf(step); }
  function nextStep(step) {
    const i = stepIndex(step);
    return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : null;
  }
  function backStep(step) {
    const i = stepIndex(step);
    return i > 0 ? STEPS[i - 1] : null;
  }
  /** "Step 1 of 2" */
  function stepLabel(step) {
    const i = stepIndex(step);
    return i < 0 ? '' : `Step ${i + 1} of ${STEPS.length}`;
  }

  // Maidenhead: 4, 6 or 8 characters (FN20, FN20jb, FN20jb12).
  const GRID_RE = /^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/i;

  /**
   * The grid box, read. Blank is allowed and means "not set": nothing invents a
   * location for the operator. Returns { grid, error }: grid '' when blank, the
   * usual spelling (FN20jb) when valid; error is the sentence to show otherwise.
   */
  function readGrid(text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, '');
    if (!t) return { grid: '', error: null };
    if (!GRID_RE.test(t)) {
      return { grid: null, error: 'That is not a grid square. A grid square is 4 or 6 characters, for example FN20 or FN20jb. Leave it blank if you are not sure.' };
    }
    const g = t.slice(0, 4).toUpperCase() + t.slice(4, 6).toLowerCase() + t.slice(6);
    return { grid: g, error: null };
  }

  /** The line under the grid box: what the grid is for, or what a blank one means. */
  function gridNote(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return 'No grid square yet. Distances and your place on the map stay blank until you add one in Settings > Station.';
    return 'Used for distances, the map and your log.';
  }

  function readCallsign(text) {
    return String(text == null ? '' : text).replace(/\s+/g, '').toUpperCase().slice(0, 12);
  }

  /**
   * Finishing the station step. fields: { callsign, grid, telemetry, appVersion }.
   * Returns { error } when the grid is not a grid square, otherwise
   * { patch, state }: patch is the one settings save, and it is the save that
   * turns firstRun false (and so releases the held launch ping, if allowed).
   */
  function finishStation(stateIn, fields) {
    const f = fields || {};
    const g = readGrid(f.grid);
    if (g.error) return { error: g.error };
    const state = normalize(stateIn);
    state.draft = null;
    state.step = 'where';
    const patch = {
      myCallsign: readCallsign(f.callsign),
      grid: g.grid,
      enableTelemetry: f.telemetry === true,
      firstRun: false,
      firstRunState: state,
    };
    if (f.appVersion) patch.lastVersion = f.appVersion;
    return { patch, state };
  }

  /**
   * The flow closed part-way (Esc or the close button) on the station step: keep
   * what was typed so the next open shows it again. Nothing else changes, and
   * firstRun stays as it is.
   */
  function keepDraft(stateIn, fields) {
    const f = fields || {};
    const state = normalize(stateIn);
    state.draft = { callsign: readCallsign(f.callsign), grid: String(f.grid == null ? '' : f.grid).trim().slice(0, 8) };
    return state;
  }

  /**
   * An answer to "Where is your radio?". Returns { action, state, patch } or
   * { error } for an unknown answer. The flow ends here until the next steps are
   * built, so the state is 'done' and the action says what to open.
   */
  function chooseWhere(stateIn, choice) {
    if (!Object.prototype.hasOwnProperty.call(WHERE, choice)) return { error: 'unknown choice' };
    const state = normalize(stateIn);
    state.where = choice;
    // The remote panel is still part of this step (the operator pairs, then
    // presses Get Started); the other two end the flow at once.
    state.step = choice === 'remote' ? 'where' : 'done';
    return { action: WHERE[choice].action, state, patch: { firstRunState: state } };
  }

  /** Get Started on the remote panel, or any other normal end of the flow. */
  function finishFlow(stateIn) {
    const state = normalize(stateIn);
    state.step = 'done';
    state.draft = null;
    return { state, patch: { firstRunState: state } };
  }

  /** Record a milestone once; the first time stays. */
  function markMilestone(stateIn, name, now) {
    const state = normalize(stateIn);
    if (!MILESTONES.includes(name)) return state;
    if (!state.milestones[name]) state.milestones[name] = Number(now) || Date.now();
    return state;
  }

  /** Whether a milestone is reached, from the markers and the flags that already exist. */
  function milestoneDone(settings, name) {
    const s = settings || {};
    const st = normalize(s.firstRunState);
    if (st.milestones[name]) return true;
    if (name === 'phoneConnected' && s.echocatAppConnected === true) return true;
    return false;
  }

  /** The values the station screen opens with: a kept draft wins over what is saved. */
  function stationFields(settings) {
    const s = settings || {};
    const st = normalize(s.firstRunState);
    const d = st.draft;
    return {
      callsign: d ? d.callsign : (s.myCallsign || ''),
      grid: d ? d.grid : (s.grid || ''),
      // A new install's settings carry enableTelemetry: true (the box is ticked);
      // an older install that never chose has it unset, which stays unticked.
      telemetry: s.enableTelemetry === true,
    };
  }

  return {
    STEPS, WHERE, MILESTONES,
    normalize, openAt, resumeStep, stepIndex, nextStep, backStep, stepLabel,
    readGrid, gridNote, readCallsign, finishStation, keepDraft, chooseWhere, finishFlow,
    markMilestone, milestoneDone, stationFields,
  };
});
