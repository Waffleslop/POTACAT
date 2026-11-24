/**
 * The radio's data sub-modes (USB-D / LSB-D) in a mode picker.
 *
 * POTACAT's name for them is DIGU and DIGL; every link maps those to the
 * radio's own: rigctld PKTUSB/PKTLSB (the G90 also gets a CI-V 06 first),
 * Icom USB/LSB with the DATA flag (1A 06), Yaesu MD0C/MD08, Kenwood MD + DA1,
 * TS-890 OM D/C, Elecraft MD6/MD9 + DT0, Flex and TCI DIGU/DIGL. The ECHOCAT
 * app's picker shows DIGU and DIGL and sends {type:'set-mode', mode}; ECHOCAT
 * Web does the same.
 *
 * dataModesFor  which of DIGU/DIGL a radio really has (the shack sends it as
 *               capabilities.dataModes). A link that cannot tell upper from
 *               lower, or sends a data request as plain USB, gets fewer or none.
 * pickerModes   which data buttons a client shows for those capabilities.
 * dataModeOf    DIGU / DIGL for any name a radio reports for them, else null.
 * badge         the mode badge text: data sub-modes read DIGU / DIGL.
 *
 * Dual-mode: Node require() gets module.exports, a <script> gets
 * window.DataModePicker (ECHOCAT Web has it inlined by remote-server). Pure,
 * no require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DataModePicker = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DATA_MODES = ['DIGU', 'DIGL'];

  // Names radios and CAT libraries report for USB-D / LSB-D.
  const UPPER = /^(DIGU|PKTUSB|USB-D\d?|DATA-U|DATA-USB|DATAU)$/;
  const LOWER = /^(DIGL|PKTLSB|LSB-D\d?|DATA-L|DATA-LSB|DATAL)$/;

  /**
   * @param {object} o
   * @param {string} o.rigType   main.js detectRigType(): flex, icom, yaesu, kenwood, rigctld, flrig, commander, tci, unknown
   * @param {string} [o.protocol]  the rig model's protocol ('yaesu-legacy' has one DIG mode)
   * @param {boolean} [o.dataFlagUnsupported]  an Icom that has refused 1A 06 (civ-codec latch)
   * @param {function} [o.resolve]  a Kenwood-protocol codec's resolveMode(mode) -> {md, da?, sub?}
   * @param {boolean} [o.hasDaCmd]  that codec has a DA/DT command
   * @param {string[]} [o.radioModes]  flrig: the radio's modes as POTACAT tokens (normalizeRadioMode)
   * @returns {string[]} a subset of ['DIGU', 'DIGL']
   */
  function dataModesFor(o) {
    if (!o) return [];
    const t = o.rigType;
    if (o.protocol === 'yaesu-legacy') return [];
    if (t === 'flex' || t === 'tci' || t === 'rigctld' || t === 'commander') return DATA_MODES.slice();
    if (t === 'icom') return o.dataFlagUnsupported ? [] : DATA_MODES.slice();
    if (t === 'flrig') {
      if (!Array.isArray(o.radioModes)) return DATA_MODES.slice();
      return DATA_MODES.filter((m) => o.radioModes.indexOf(m === 'DIGU' ? 'PKTUSB' : 'PKTLSB') >= 0);
    }
    if (t === 'kenwood' || t === 'yaesu') {
      // The legacy TCP client (no codec here) always sends MD+DA1 / MD0C, MD08.
      if (typeof o.resolve !== 'function') return DATA_MODES.slice();
      const out = [];
      let upper = null;
      // Plain voice codes: a "data" request that lands on one of them is USB or
      // LSB on the air ((tr)uSDX runs digital in MD2) unless DA/DT goes with it.
      const plainMd = ['USB', 'LSB'].map((p) => o.resolve(p)).filter(Boolean).map((p) => p.md);
      for (const m of DATA_MODES) {
        const d = o.resolve(m);
        if (!d) continue;
        const isData = plainMd.indexOf(d.md) < 0 ||
          (!!o.hasDaCmd && (d.da === 1 || d.sub != null));
        if (!isData) continue;
        // One data code for both sidebands (QMX DIGI): the lower one is not a choice.
        if (m === 'DIGL' && upper && JSON.stringify(upper) === JSON.stringify(d)) continue;
        if (m === 'DIGU') upper = d;
        out.push(m);
      }
      return out;
    }
    return [];
  }

  /** The data buttons to show: the DIGU/DIGL entries of caps.dataModes. Absent = none. */
  function pickerModes(caps) {
    const list = caps && Array.isArray(caps.dataModes) ? caps.dataModes : [];
    return DATA_MODES.filter((m) => list.indexOf(m) >= 0);
  }

  /**
   * DIGU / DIGL for a data sub-mode, else null. dataOn: the radio's DATA flag
   * where it reports it apart from the mode (Icom USB + 1A 06).
   */
  function dataModeOf(mode, dataOn) {
    const m = String(mode || '').trim().toUpperCase();
    if (UPPER.test(m)) return 'DIGU';
    if (LOWER.test(m)) return 'DIGL';
    if (dataOn === true && m === 'USB') return 'DIGU';
    if (dataOn === true && m === 'LSB') return 'DIGL';
    return null;
  }

  /** The badge text for a mode: DIGU / DIGL for the data sub-modes, else the mode. */
  function badge(mode, dataOn) {
    return dataModeOf(mode, dataOn) || (mode || '');
  }

  return { DATA_MODES, dataModesFor, pickerModes, dataModeOf, badge };
});
