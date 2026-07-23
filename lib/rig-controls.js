// Canonical rig-control action registry — the single source of truth for what
// controls exist, how clients (desktop rig popover, ECHOCAT phone, future web)
// should render them, and which capability flag gates each. The dispatcher
// (main.js `applyRigControl`) handles this same set of actions, and
// test/rig-controls-test.js enforces that the registry and the dispatcher never
// drift. Add a control here AND in applyRigControl — the test fails otherwise.
//
// Fields:
//   kind     'toggle' | 'level' | 'momentary' | 'enum'
//   group    'rx' | 'tx' | 'tune' | 'power' | 'cw' | 'freq' | 'ant'
//   caps     capability flag (from getRigCapabilities) a client checks before
//            OFFERING the control. null/absent = always offer.
//   txOnly   true when it only affects TRANSMITTED audio — clients label these
//            so the op doesn't expect a receive-audio change (the COMP/VOX trap).
//   label    short UI label
//   help     one-line tooltip
//   internal true = plumbing, not an operator control; UIs skip it but it is
//            still part of the dispatcher contract (counts for parity).

const RIG_CONTROLS = {
  // --- Receive ---
  'set-nb':            { kind: 'toggle', group: 'rx', caps: 'nb',  label: 'NB',  help: 'Noise blanker — knocks down impulse/ignition noise' },
  'set-nb-level':      { kind: 'level',  group: 'rx', caps: 'nb',  label: 'NB level', help: 'Noise-blanker strength' },
  'set-nr':            { kind: 'toggle', group: 'rx', caps: 'nr',  label: 'NR',  help: 'Noise reduction — lowers broadband background hiss' },
  'set-nr-level':      { kind: 'level',  group: 'rx', caps: 'nr',  label: 'NR level', help: 'Noise-reduction strength' },
  'set-anf':           { kind: 'toggle', group: 'rx', caps: 'anf', label: 'ANF', help: 'Auto-notch — removes steady carriers/heterodynes' },
  // Extended firmware DSP — Flex 8000-series / Aurora slice filters beyond the
  // classic nr/anf (lms_nr / speex_nr / rnnoise / nrf). AetherSDR and SmartSDR+
  // expose the same four; POTACAT drives them over its own API connection, so
  // they work with either GUI client open — or none (Flex Direct).
  'set-nrl':           { kind: 'toggle', group: 'rx', caps: 'nrl', label: 'NRL', help: 'LMS adaptive noise reduction (Flex 8000/Aurora firmware)' },
  'set-nrl-level':     { kind: 'level',  group: 'rx', caps: 'nrlLevel', label: 'NRL level', help: 'LMS noise-reduction strength' },
  'set-nrs':           { kind: 'toggle', group: 'rx', caps: 'nrs', label: 'NRS', help: 'Spectral-subtraction noise reduction — kills noise between words (Flex 8000/Aurora firmware)' },
  'set-nrs-level':     { kind: 'level',  group: 'rx', caps: 'nrsLevel', label: 'NRS level', help: 'Spectral noise-reduction strength' },
  'set-rnn':           { kind: 'toggle', group: 'rx', caps: 'rnn', label: 'RNN', help: 'Neural-net noise reduction — voice-trained, best on SSB (Flex 8000/Aurora firmware)' },
  'set-nrf':           { kind: 'toggle', group: 'rx', caps: 'nrf', label: 'NRF', help: 'NRF noise reduction (Flex 8000/Aurora firmware)' },
  'set-nrf-level':     { kind: 'level',  group: 'rx', caps: 'nrfLevel', label: 'NRF level', help: 'NRF noise-reduction strength' },
  // WNB is a PANADAPTER property on Flex (all 6000/8000 models) — knocks down
  // wideband impulse noise before the slice DSP ever sees it.
  'set-wnb':           { kind: 'toggle', group: 'rx', caps: 'wnb', label: 'WNB', help: 'Wideband noise blanker — whole-panadapter impulse noise removal' },
  'set-wnb-level':     { kind: 'level',  group: 'rx', caps: 'wnbLevel', label: 'WNB level', help: 'Wideband noise-blanker strength' },
  // Flex preamp/attenuator in radio-native dB steps (caps.rfgainSteps lists
  // the model's valid values, e.g. -8..+32 by 8). The 0-100 set-rf-gain
  // mapping tops out at +20 dB and lands between detents — this sends the
  // exact step.
  'set-rf-gain-db':    { kind: 'enum',   group: 'rx', caps: 'rfgainSteps', label: 'RF Gain', help: 'Preamp / attenuation in dB (radio-native steps)' },
  'set-apf':           { kind: 'toggle', group: 'rx', caps: 'apf', label: 'APF', help: 'Audio peak filter — peaks the CW tone for easier copy' },
  'set-rf-gain':       { kind: 'level',  group: 'rx', caps: 'rfgain', label: 'RF Gain', help: 'Receiver RF gain' },
  // FM squelch — mutes RX until a signal exceeds the threshold. Distinct from
  // the FT8/PSK31/FreeDV DSP squelch (those are decoder-side); this is the rig's
  // own SQ/CI-V/Hamlib squelch. Clients show it only in FM mode (see app.js /
  // remote.js FM gate) since that's where it does anything.
  'set-squelch':       { kind: 'level',  group: 'rx', caps: 'squelch', label: 'SQL', help: 'FM squelch threshold — mutes RX until a signal exceeds it' },
  'set-filter-width':  { kind: 'level',  group: 'rx', caps: 'filter', label: 'Filter', help: 'Receiver passband width' },
  'set-agc':           { kind: 'enum',   group: 'rx', caps: 'agc', label: 'AGC', help: 'AGC decay speed' },
  'set-rit':           { kind: 'toggle', group: 'rx', caps: 'rit', label: 'RIT', help: 'Receiver incremental tuning' },
  'set-preamp':        { kind: 'toggle', group: 'rx', caps: 'preamp', label: 'Preamp', help: 'Receive preamplifier' },
  'set-att':           { kind: 'toggle', group: 'rx', caps: 'att', label: 'Att', help: 'Receiver attenuator' },
  'set-dnr-level':     { kind: 'level',  group: 'rx', caps: 'dnrLevel', label: 'DNR', help: 'Digital noise-reduction level' },
  'set-preamp-target': { kind: 'enum',   group: 'rx', caps: 'preampTarget', label: 'Preamp', help: 'Per-band preamp selection' },
  'set-antenna-port':  { kind: 'enum',   group: 'ant', caps: 'antennaPort', label: 'Antenna', help: 'Antenna port selection' },

  // --- Transmit (txOnly: will not change received audio) ---
  'set-tx-power':      { kind: 'level',  group: 'tx', caps: 'txpower', label: 'Power', help: 'Transmit power' },
  'set-comp':          { kind: 'toggle', group: 'tx', caps: 'comp', txOnly: true, label: 'COMP', help: 'Speech processor — transmit audio only' },
  'set-comp-level':    { kind: 'level',  group: 'tx', caps: 'compLevel', txOnly: true, label: 'COMP level', help: 'Speech-processor level (TX only)' },
  'set-vox':           { kind: 'toggle', group: 'tx', caps: 'vox', txOnly: true, label: 'VOX', help: 'Voice-activated transmit (TX only)' },
  'set-vox-level':     { kind: 'level',  group: 'tx', caps: 'vox', txOnly: true, label: 'VOX level', help: 'VOX sensitivity (TX only)' },
  'set-mon':           { kind: 'toggle', group: 'tx', caps: 'mon', txOnly: true, label: 'MON', help: 'Monitor — hear your own transmit audio' },
  'set-mon-level':     { kind: 'level',  group: 'tx', caps: 'mon', txOnly: true, label: 'MON level', help: 'Transmit-monitor level' },
  'set-mic-gain':      { kind: 'level',  group: 'tx', caps: 'micGain', txOnly: true, label: 'Mic', help: 'Microphone gain (TX only)' },

  // --- Tune / power ---
  'atu-tune':          { kind: 'momentary', group: 'tune', caps: 'atu', label: 'Tune', help: 'Run an antenna-tuner cycle' },
  'power-on':          { kind: 'momentary', group: 'power', caps: 'power', label: 'On', help: 'Power the radio on' },
  'power-off':         { kind: 'momentary', group: 'power', caps: 'power', label: 'Off', help: 'Power the radio off' },

  // --- CW ---
  'set-cw-sidetone':   { kind: 'toggle', group: 'cw', caps: 'cwSidetone', label: 'Sidetone', help: "Mute the radio's own CW sidetone" },
  'set-break-in':      { kind: 'toggle', group: 'cw', caps: 'breakIn', label: 'Break-in', help: 'CW QSK / break-in' },
  'set-break-in-delay':{ kind: 'level',  group: 'cw', caps: 'breakInDelay', label: 'BK delay', help: 'Break-in hang time' },

  // --- Clarifier (Yaesu-class) ---
  'set-clar-rx':       { kind: 'toggle', group: 'freq', caps: 'clarRx', label: 'CLAR RX', help: 'RX clarifier' },
  'set-clar-tx':       { kind: 'toggle', group: 'freq', caps: 'clarTx', txOnly: true, label: 'CLAR TX', help: 'TX clarifier' },
  'set-clar-offset':   { kind: 'level',  group: 'freq', caps: 'clarOffset', label: 'CLAR', help: 'Clarifier offset (Hz)' },

  // --- Internal plumbing (not operator controls) ---
  'get-state':         { kind: 'momentary', group: 'rx', internal: true, label: '', help: '' },
  'send-custom-cat':   { kind: 'momentary', group: 'rx', internal: true, label: '', help: '' },
};

module.exports = { RIG_CONTROLS };
