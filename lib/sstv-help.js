// How an SSTV contact works, for operators new to it (Casey 2026-09-30: "I got
// some images that said UR P4 or UR P5 ... non-regulars will find this
// confusing"). Pure data plus the report helpers the reply bar uses. Dual-mode
// like lib/sstv-templates.js (require + window.SstvHelp) so the ECHOCAT app can
// vendor it and both say the same thing.
//
// Sources: CQSSTV's P-system page (P1-P5 wording), the MMSSTV SSTV primer
// (RSV 595, Scottie 1 / Martin 1, 14.230/14.233, listen first, announce the
// mode), and the North American calling-frequency lists (7.171 and 3.845 LSB).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SstvHelp = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The P scale: how the picture itself came through. */
  const P_SCALE = [
    { p: 5, words: 'Perfect, no noise' },
    { p: 4, words: 'Very good, a little noise' },
    { p: 3, words: 'Good, some noise' },
    { p: 2, words: 'Fair, a lot of noise' },
    { p: 1, words: 'Barely visible' },
  ];

  /**
   * A report the operator typed, cleaned up: RSV as three digits (R 1-5,
   * S 1-9, V 1-5) or the P scale (P1-P5). Anything else is null.
   */
  function parseReport(text) {
    const t = String(text == null ? '' : text).trim().toUpperCase().replace(/\s+/g, '');
    if (/^[1-5][1-9][1-5]$/.test(t)) return { kind: 'rsv', value: t };
    const m = /^P([1-5])$/.exec(t);
    if (m) return { kind: 'p', value: 'P' + m[1] };
    return null;
  }

  /** How a report reads on a picture: "RSV 595" or "P5". */
  function reportText(text) {
    const r = parseReport(text);
    if (!r) return '';
    return r.kind === 'rsv' ? 'RSV ' + r.value : r.value;
  }

  /** One line explaining a report, for a tooltip: "P4: very good, a little noise". */
  function explainReport(text) {
    const r = parseReport(text);
    if (!r) return 'A report is RSV (like 595) or the P scale (P1 to P5).';
    if (r.kind === 'p') {
      const e = P_SCALE.find((x) => 'P' + x.p === r.value);
      return r.value + ': ' + e.words.charAt(0).toLowerCase() + e.words.slice(1) + '.';
    }
    const [R, S, V] = r.value.split('').map(Number);
    return 'RSV ' + r.value + ': readability ' + R + ' of 5, strength ' + S + ' of 9, picture ' + V + ' of 5.';
  }

  /**
   * The help, as sections of plain text. `items` are bullet points; a section
   * may carry a `table` of [left, right] rows. No markup: every surface
   * renders it in its own style.
   */
  const SECTIONS = [
    { id: 'what', title: 'What SSTV is',
      text: 'Slow-scan TV sends a picture as sound over an ordinary voice channel. One picture takes from about 30 seconds to a few minutes, depending on the mode, and everyone on the frequency receives it. A contact is a few pictures back and forth.' },
    { id: 'where', title: 'Where to find it',
      text: 'Most activity is on 20 m. The radio must be on the right sideband, or pictures will not decode.',
      table: [
        ['14.230 USB', 'The main calling frequency, 20 m. 14.227 and 14.233 when it is busy.'],
        ['21.340 USB', '15 m'],
        ['28.680 USB', '10 m'],
        ['7.171 LSB', '40 m, North America'],
        ['3.845 LSB', '80 m, North America'],
      ] },
    { id: 'modes', title: 'Modes',
      text: 'Scottie 1 and Martin 1 are the everyday modes (Scottie 1 is the most common in the US, Martin 1 in Europe). PD modes take longer and give a sharper picture. POTACAT recognises the mode of a received picture by itself; reply in the mode they used unless you have a reason not to.' },
    { id: 'contact', title: 'A contact, step by step',
      items: [
        'Listen first, for a few minutes. Never start a picture while one is coming in: the receive progress bar shows it.',
        'Some frequencies run as a round table: someone keeps a list, and you drop your call by voice between pictures and wait your turn.',
        'Call CQ with a picture that shows your call and grid (the CQ template).',
        'Someone answers with a picture: your call, their call, and a report on your picture. Many put your own picture in a corner so you can see how it arrived.',
        'You reply the same way: their call, your call, your report on their picture. In POTACAT, double-click their picture to start a reply.',
        'Finish with a 73 or QSL picture, and log it: mode SSTV, with the reports sent and received.',
      ] },
    { id: 'reports', title: 'Reports: "UR 595" and "UR P5"',
      text: 'Two styles are in use, and both mean the same thing. Answer in the style they used.',
      items: [
        'RSV: Readability 1 to 5, Strength 1 to 9, Video (the picture) 1 to 5. 595 is a perfect picture from a strong signal.',
        'The P scale rates only the picture, P1 to P5. "UR P5" means your picture arrived perfect.',
      ],
      table: P_SCALE.map((x) => ['P' + x.p, x.words]) },
    { id: 'id', title: 'Identifying',
      items: [
        'Your call must be in what you send. POTACAT\'s templates put it in every picture.',
        'Many operators also say their call and mode by voice, for example "K3SBP, Martin 1".',
        'MMSSTV and QSSTV can send the call as a short tone burst after the picture (FSK ID). POTACAT reads it and fills in their call for a reply.',
      ] },
    { id: 'radio', title: 'Your radio',
      items: [
        'A picture is a full-power transmission lasting minutes. Many operators run half power or less to keep the radio cool.',
        'Keep the audio level low enough that ALC barely moves. Overdriven audio smears the picture for everyone.',
        'If a received picture has stripes, colour bars or a slant, the tuning or sideband is off. POTACAT can fix slant after the fact.',
      ] },
  ];

  return { P_SCALE, SECTIONS, parseReport, reportText, explainReport };
}));
