'use strict';
//
// Ragchew log pop-out renderer (W9TEF feature). Replaces the Ctrl+L modal
// with a persistent always-visible window that adds:
//   * QTH (country / US-state) under the callsign field
//   * QRZ.com link (separate from the callsign input)
//   * Up to 5 most-recent past QSOs with this callsign from the local log,
//     plus a "View all in Logbook →" link that opens the QSO pop-out
//     pre-filtered by callsign.
//
// Submission reuses the main window's `save-qso` IPC, so the resulting
// ADIF record is identical to one made from the modal.
//

(function () {
  // ── DOM refs ────────────────────────────────────────────────────────────
  const callInput = document.getElementById('lp-callsign');
  const nameInput = document.getElementById('lp-name');
  const qrzBtn = document.getElementById('lp-qrz-link');
  const identityEl = document.getElementById('lp-identity');
  const chipsEl = document.querySelectorAll('.lp-chip');
  const refSection = document.getElementById('lp-ref-section');
  const refInput = document.getElementById('lp-ref');
  const freqInput = document.getElementById('lp-frequency');
  const modeSelect = document.getElementById('lp-mode');
  const dateInput = document.getElementById('lp-date');
  const timeInput = document.getElementById('lp-time');
  const powerInput = document.getElementById('lp-power');
  const rstSentInput = document.getElementById('lp-rst-sent');
  const rstRcvdInput = document.getElementById('lp-rst-rcvd');
  const notesInput = document.getElementById('lp-notes');
  const saveBtn = document.getElementById('lp-save');
  const clearBtn = document.getElementById('lp-clear');
  const minBtn = document.getElementById('lp-min');
  const closeBtn = document.getElementById('lp-close');
  const pastCountEl = document.getElementById('lp-past-count');
  const pastBodyEl = document.getElementById('lp-past-body');
  const pastViewAllEl = document.getElementById('lp-past-view-all');
  const toastEl = document.getElementById('lp-toast');
  const respotSectionEl = document.getElementById('lp-respot-section');
  const respotCheckEl = document.getElementById('lp-respot');
  const respotCommentEl = document.getElementById('lp-respot-comment');

  // Per-type respot endpoint availability — mirrors qso-popout.js's
  // NEW_QSO_TYPE_META so behavior is consistent across all logging paths.
  // SOTA / Tiles / DX (without active cluster) have no public spot-submit
  // path so we hide the toggle for them.
  const RESPOT_ELIGIBLE = { pota: true, wwff: true, llota: true };

  let selectedType = 'dx';
  let respotDefaultPref = true; // hydrated from settings on init
  // Per-network templates (Chris NR9Q). Empty WWFF/LLOTA fall back to POTA.
  let potaTemplatePref  = '{rst} in {QTH} 73s {mycallsign} via POTACAT';
  let wwffTemplatePref  = '';
  let llotaTemplatePref = '';
  function templateFor(type) {
    if (type === 'wwff')  return wwffTemplatePref  || potaTemplatePref;
    if (type === 'llota') return llotaTemplatePref || potaTemplatePref;
    return potaTemplatePref;
  }
  let myCallsignPref = ''; // for {mycallsign} substitution in respot comment
  let myGridPref = '';     // for {QTH} substitution
  // True while the comment field holds the rendered default for the current
  // type. Flips to false as soon as the user types into the field — at which
  // point the "Use default" checkbox auto-unchecks. Re-checking restores it.
  let respotCommentIsDefault = true;
  let lastQrzInfo = null;
  let lastLookupCall = '';
  let lookupTimer = null;
  let timeUserEdited = false;
  let freqUserEdited = false;
  let modeUserEdited = false;
  let clockTimer = null;
  // Activation context — passed through prefill, applied to qsoData on save
  // so a ragchew QSO during an activation is still tagged with mySig/mySigInfo.
  let activationCtx = null;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, type) {
    toastEl.textContent = msg;
    toastEl.style.background = type === 'error' ? 'var(--accent-red, #e94560)' : 'var(--accent-green, #4ecca3)';
    toastEl.classList.add('visible');
    setTimeout(() => toastEl.classList.remove('visible'), 1800);
  }

  /** Clean a QRZ name field for display ("BOB" / "Bob" / null → "Bob"). */
  function cleanName(n) {
    if (!n) return '';
    const s = String(n).trim();
    if (!s) return '';
    // Title-case if all-caps, otherwise keep as-is.
    if (s === s.toUpperCase()) return s.charAt(0) + s.slice(1).toLowerCase();
    return s;
  }

  /** Build "Bob McDonnell" from a QRZ info record. */
  function qrzDisplayName(info) {
    if (!info) return '';
    const first = cleanName(info.nickname) || cleanName(info.fname);
    const last = cleanName(info.name);
    return [first, last].filter(Boolean).join(' ');
  }

  /** "Bob McDonnell · US-VA" / "Bob · Germany" — same format as Bottom Banner Logger. */
  function qrzNameAndLocation(info) {
    const name = qrzDisplayName(info);
    if (!info) return name;
    const country = (info.country || '').trim();
    const state = (info.state || '').trim();
    let loc = '';
    if (state && /^united states|^usa$/i.test(country)) {
      loc = `US-${state.toUpperCase()}`;
    } else if (country) {
      loc = country;
    } else if (state) {
      loc = state;
    }
    return { name, loc };
  }

  /** "20260914" + "1530" → "2026-09-14 15:30" (UTC). */
  function formatQsoDateTime(date, time) {
    const d = (date || '').padStart(8, '0');
    const t = (time || '').padStart(4, '0').slice(0, 4);
    if (d.length !== 8 && d.length !== 0) return `${date} ${time || ''}`.trim();
    if (!d) return time || '';
    const datePart = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (!t) return datePart;
    return `${datePart} ${t.slice(0, 2)}:${t.slice(2, 4)}`;
  }

  /** Display an integer kHz as "14074" (no decimals). */
  function formatFreq(kHz) {
    if (kHz == null || isNaN(kHz)) return '';
    return String(Math.round(kHz));
  }

  /** Render the past-QSOs panel. */
  function renderPastQsos(qsos, totalCount, call) {
    if (!call) {
      pastCountEl.textContent = '';
      pastViewAllEl.style.display = 'none';
      pastBodyEl.innerHTML = '<div class="lp-past-empty">Type a callsign to see prior QSOs from your log.</div>';
      return;
    }
    if (!qsos || qsos.length === 0) {
      pastCountEl.textContent = '';
      pastViewAllEl.style.display = 'none';
      pastBodyEl.innerHTML = `<div class="lp-past-empty">No QSOs with ${escapeHtml(call.toUpperCase())} in your log yet.</div>`;
      return;
    }
    pastCountEl.textContent = `(${totalCount})`;
    if (totalCount > qsos.length) {
      pastViewAllEl.style.display = '';
      pastViewAllEl.textContent = `View all ${totalCount} in Logbook →`;
    } else {
      pastViewAllEl.style.display = '';
      pastViewAllEl.textContent = `View in Logbook →`;
    }
    const rows = qsos.map((q) => {
      const when = formatQsoDateTime(q.date, q.time);
      const band = q.band ? q.band : '';
      const mode = q.mode ? q.mode : '';
      const freq = formatFreq(q.freq);
      const ref = q.ref || '';
      const comment = q.comment || '';
      return `
        <tr>
          <td>${escapeHtml(when)}</td>
          <td>${escapeHtml(band)}</td>
          <td class="lp-past-mode">${escapeHtml(mode)}</td>
          <td>${escapeHtml(freq)}</td>
          ${ref ? `<td class="lp-past-ref">${escapeHtml(ref)}</td>` : '<td></td>'}
          ${comment ? `<td class="lp-past-comment">${escapeHtml(comment)}</td>` : ''}
        </tr>`;
    }).join('');
    pastBodyEl.innerHTML = `<table class="lp-past-table"><tbody>${rows}</tbody></table>`;
  }

  /** Update the QRZ button + identity row from a lookup result. */
  function updateIdentity(info, call) {
    lastQrzInfo = info;
    if (call && call.length >= 3) {
      qrzBtn.classList.add('active');
    } else {
      qrzBtn.classList.remove('active');
    }
    if (info) {
      const { name, loc } = qrzNameAndLocation(info);
      nameInput.value = name || '';
      identityEl.innerHTML = name
        ? (loc ? `${escapeHtml(name)}<span class="lp-loc"> · ${escapeHtml(loc)}</span>` : escapeHtml(name))
        : (loc ? `<span class="lp-loc">${escapeHtml(loc)}</span>` : '');
    } else {
      nameInput.value = '';
      identityEl.innerHTML = '';
    }
  }

  /** Debounced callsign lookup — fires combined QRZ + past-QSO query. */
  function scheduleLookup() {
    const raw = callInput.value.trim().toUpperCase();
    // Cheap input update: enable/disable QRZ button based on length only.
    if (raw && raw.length >= 3) qrzBtn.classList.add('active');
    else qrzBtn.classList.remove('active');

    if (lookupTimer) clearTimeout(lookupTimer);
    if (!raw || raw.length < 3) {
      // Empty state — clear identity / past QSOs immediately, no IPC needed.
      updateIdentity(null, raw);
      renderPastQsos([], 0, '');
      lastLookupCall = '';
      return;
    }
    if (raw === lastLookupCall) return; // no change since last lookup

    lookupTimer = setTimeout(async () => {
      lastLookupCall = raw;
      try {
        const result = await window.api.callsignInfo(raw, 5);
        // Race protection: if the user typed more chars while we were
        // awaiting, ignore stale results.
        if (raw !== callInput.value.trim().toUpperCase()) return;
        updateIdentity(result.qrz, raw);
        renderPastQsos(result.pastQsos, result.totalQsos, raw);
      } catch (err) {
        console.warn('[log-popout] callsign lookup failed:', err);
      }
    }, 350);
  }

  // ── Form helpers ────────────────────────────────────────────────────────

  function selectChip(type) {
    selectedType = type;
    chipsEl.forEach((c) => c.classList.toggle('active', c.dataset.type === type));
    refSection.classList.toggle('hidden', type === 'dx');
    if (type === 'dx') refInput.value = '';
    // Show the respot toggle only for types with a public spot-submit
    // endpoint. Default-checked state is the user's persisted preference,
    // not always true — if they unchecked last time, stay unchecked.
    const eligible = !!RESPOT_ELIGIBLE[type];
    respotSectionEl.classList.toggle('hidden', !eligible);
    if (eligible) {
      respotCheckEl.checked = !!respotDefaultPref;
      // Always refresh the comment to the *current network's* template when
      // switching chips, unless the user has already typed a custom comment
      // for this QSO (respotCommentIsDefault === false).
      if (respotCommentIsDefault) {
        respotCommentEl.value = templateFor(type);
      }
    }
  }

  /** Live-clock the date/time fields until the user edits them. */
  function startClock() {
    stopClock();
    const tick = () => {
      if (timeUserEdited) return;
      const now = new Date();
      const iso = now.toISOString();
      dateInput.value = iso.slice(0, 10);
      timeInput.value = iso.slice(11, 16);
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }
  function stopClock() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  function clearForm(opts) {
    callInput.value = '';
    nameInput.value = '';
    refInput.value = '';
    notesInput.value = '';
    rstSentInput.value = '59';
    rstRcvdInput.value = '59';
    // Next QSO starts fresh: comment field reverts to current network's
    // template, "Use default" checkbox returns to the user's saved pref.
    respotCommentIsDefault = true;
    respotCheckEl.checked = !!respotDefaultPref;
    selectChip('dx');
    identityEl.innerHTML = '';
    qrzBtn.classList.remove('active');
    renderPastQsos([], 0, '');
    timeUserEdited = false;
    // Don't reset freqUserEdited / modeUserEdited — if the user is QSY-ing
    // manually between ragchews the form should track the rig automatically
    // again (the convention is "user-edited" means the user typed in the
    // field directly, which doesn't survive a save).
    freqUserEdited = false;
    modeUserEdited = false;
    startClock(); // resume live time
    lastLookupCall = '';
    if (!opts || !opts.skipFocus) callInput.focus();
  }

  function bandFromKHz(kHz) {
    if (kHz < 1900) return '160m';
    if (kHz < 4000) return '80m';
    if (kHz < 5500) return '60m';
    if (kHz < 7300) return '40m';
    if (kHz < 10200) return '30m';
    if (kHz < 14400) return '20m';
    if (kHz < 18200) return '17m';
    if (kHz < 21500) return '15m';
    if (kHz < 24999) return '12m';
    if (kHz < 29701) return '10m';
    if (kHz < 54000) return '6m';
    if (kHz < 148000) return '2m';
    if (kHz < 450000) return '70cm';
    return '';
  }

  function modeFamily(m) {
    const u = (m || '').toUpperCase();
    if (u === 'USB' || u === 'LSB') return 'SSB';
    return u;
  }

  /** Build the qsoData object that save-qso expects. */
  function buildQsoData() {
    const callsignRaw = callInput.value.trim().toUpperCase();
    if (!callsignRaw) return { error: 'Callsign required' };
    const freqKhzNum = parseFloat(freqInput.value);
    if (!isFinite(freqKhzNum) || freqKhzNum < 100) return { error: 'Frequency required (kHz)' };
    const date = (dateInput.value || '').replace(/-/g, '');
    // Normalize H:MM / HH:M / 9:5 / 0930 forms → HHMM. Pad each side.
    let timeRaw = (timeInput.value || '').trim();
    if (/^\d{1,2}:\d{1,2}$/.test(timeRaw)) {
      const [hh, mm] = timeRaw.split(':');
      timeRaw = hh.padStart(2, '0') + mm.padStart(2, '0');
    } else {
      timeRaw = timeRaw.replace(/:/g, '');
    }
    const time = timeRaw;
    if (date.length !== 8) return { error: 'Date required (YYYY-MM-DD)' };
    if (time.length < 4) return { error: 'Time required (HH:MM)' };
    const mode = modeFamily(modeSelect.value || 'CW');
    const band = bandFromKHz(freqKhzNum);
    const ref = (refInput.value || '').trim().toUpperCase();
    let sig = '';
    let sigInfo = '';
    let potaRef = '';
    let sotaRef = '';
    let wwffRef = '';
    if (selectedType !== 'dx' && ref) {
      sig = selectedType.toUpperCase();
      sigInfo = ref;
      if (selectedType === 'pota') potaRef = ref;
      else if (selectedType === 'sota') sotaRef = ref;
      else if (selectedType === 'wwff') wwffRef = ref;
    }
    // Re-spot: pick up the checkbox + comment when the chip's a respottable
    // type. Mirrors the spot-row Log dialog flag-set so saveQsoRecord on
    // main runs the same postPotaRespot / wwff / llota paths.
    let respotFields = {};
    const wantsRespot = !!respotCheckEl.checked && !!RESPOT_ELIGIBLE[selectedType] && !!ref;
    if (wantsRespot) {
      const tmpl = respotCommentEl.value.trim() || templateFor(selectedType);
      const respotComment = tmpl
        .replace(/\{rst\}/gi, (rstSentInput.value || '59').slice(0, 3))
        .replace(/\{QTH\}/gi, myGridPref)
        .replace(/\{mycallsign\}/gi, myCallsignPref)
        .replace(/\{op_firstname\}/gi, '');
      if (selectedType === 'pota') respotFields = { respot: true, respotComment };
      else if (selectedType === 'wwff') respotFields = { wwffRespot: true, wwffReference: ref, respotComment };
      else if (selectedType === 'llota') respotFields = { llotaRespot: true, llotaReference: ref, respotComment };
    }
    const info = lastQrzInfo;
    const data = {
      callsign: callsignRaw,
      frequency: String(freqKhzNum),
      mode,
      band,
      qsoDate: date,
      timeOn: time,
      rstSent: (rstSentInput.value || '59').slice(0, 3),
      rstRcvd: (rstRcvdInput.value || '59').slice(0, 3),
      txPower: powerInput.value ? Number(powerInput.value) : undefined,
      sig,
      sigInfo,
      potaRef,
      sotaRef,
      wwffRef,
      name: info ? qrzDisplayName(info) : '',
      state: info ? (info.state || '') : '',
      gridsquare: info ? (info.grid || '') : '',
      country: info ? (info.country || '') : '',
      comment: notesInput.value.trim(),
      // Activation context — only added if an activation was running when
      // this popout instance opened. Tags the QSO with mySig=POTA + the
      // activator's primary park ref.
      ...(activationCtx && activationCtx.mySig
        ? { mySig: activationCtx.mySig, mySigInfo: activationCtx.mySigInfo }
        : {}),
      // Re-spot fields (only when chip is POTA/WWFF/LLOTA and checkbox
      // is checked). saveQsoRecord on main reads these and triggers the
      // appropriate postPotaRespot / postWwffRespot / postLlotaRespot.
      ...respotFields,
    };
    return { data };
  }

  async function doSave() {
    const built = buildQsoData();
    if (built.error) { showToast(built.error, 'error'); return; }
    // Defensive: WG9I on macOS darwin v1.5.14 saw
    //   "Cannot read properties of undefined: reading 'saveQso'"
    // here — meaning window.api was undefined at click time. The cause
    // (preload didn't expose, sandbox stripped a require, etc.) is hard
    // to diagnose remotely. Surface a clear actionable message and dump
    // diagnostic info to the console so DevTools paints a useful trace
    // instead of the vague TypeError. (2026-05-05.)
    if (!window.api || typeof window.api.saveQso !== 'function') {
      console.error('[log-popout] window.api missing saveQso',
        { hasApi: !!window.api, apiKeys: window.api ? Object.keys(window.api) : null });
      showToast('Save failed: log-popout preload bridge not loaded. Restart POTACAT and try again. If this persists, send the DevTools console output via Help → Bug Report.', 'error');
      return;
    }
    saveBtn.disabled = true;
    try {
      const result = await window.api.saveQso(built.data);
      if (result && result.success) {
        const call = built.data.callsign;
        showToast(`✓ Saved ${call}`);
        // Sticky form on save: clear callsign-specific fields, keep
        // freq/mode/power so consecutive ragchews are quick. Refresh the
        // past-QSOs panel to include the freshly-saved QSO if user retypes
        // the callsign immediately.
        clearForm();
      } else {
        const err = (result && result.error) || 'Save failed';
        showToast(err, 'error');
      }
    } catch (err) {
      showToast(err.message || 'Save failed', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  // Window controls
  minBtn.addEventListener('click', () => window.api.minimizeWindow());
  closeBtn.addEventListener('click', () => window.api.closeWindow());

  // Type chips
  chipsEl.forEach((c) => c.addEventListener('click', () => selectChip(c.dataset.type)));

  // Callsign input
  callInput.addEventListener('input', () => {
    callInput.value = callInput.value.toUpperCase();
    scheduleLookup();
  });

  // QRZ button — opens qrz.com/db/<call> in default browser
  qrzBtn.addEventListener('click', () => {
    const call = callInput.value.trim().toUpperCase();
    if (!call) return;
    const baseCall = call.split('/')[0];
    window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(baseCall)}`);
  });

  // Past QSOs "View all" → opens QSO Logbook pop-out filtered by callsign
  pastViewAllEl.addEventListener('click', (e) => {
    e.preventDefault();
    const call = callInput.value.trim().toUpperCase();
    if (call) window.api.searchInLogbook(call);
  });

  // Field-edit detection — once the user touches a field, stop auto-filling
  // it from CAT updates / live clock.
  timeInput.addEventListener('input', () => { timeUserEdited = true; });
  dateInput.addEventListener('input', () => { timeUserEdited = true; });
  freqInput.addEventListener('input', () => { freqUserEdited = true; });
  modeSelect.addEventListener('change', () => { modeUserEdited = true; });

  // Save / clear
  saveBtn.addEventListener('click', doSave);
  clearBtn.addEventListener('click', () => clearForm());

  // Enter key on callsign field shifts focus to RST Rcvd (typical operating flow);
  // Enter on RST Rcvd saves.
  callInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); rstRcvdInput.focus(); rstRcvdInput.select(); }
  });
  rstRcvdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  });

  // ── CAT live updates ────────────────────────────────────────────────────

  if (window.api.onCatFrequency) {
    window.api.onCatFrequency((hz) => {
      if (!hz || hz < 100000) return;
      if (freqUserEdited) return; // user is typing — don't fight them
      freqInput.value = String(Math.round(hz / 1000));
    });
  }
  if (window.api.onCatMode) {
    window.api.onCatMode((mode) => {
      if (!mode) return;
      if (modeUserEdited) return;
      const m = modeFamily(mode);
      if ([...modeSelect.options].some((o) => o.value === m)) modeSelect.value = m;
    });
  }

  // ── Prefill on open ─────────────────────────────────────────────────────

  if (window.api.onPrefill) {
    window.api.onPrefill((p) => {
      if (!p) return;
      if (p.freqKhz && !freqUserEdited) freqInput.value = String(Math.round(p.freqKhz));
      if (p.mode && !modeUserEdited) {
        const m = modeFamily(p.mode);
        if ([...modeSelect.options].some((o) => o.value === m)) modeSelect.value = m;
      }
      if (p.power && !powerInput.value) powerInput.value = String(p.power);
      // Carry activation context for save-time tagging. Refreshed on every
      // open so a user toggling activation on/off mid-session sees consistent
      // behavior.
      activationCtx = p.activationCtx || null;
      // Pre-fill from a currently-tuned spot: jump callsign in, then skip
      // straight to RST Sent so the operator can type the signal report
      // without an extra click. (W9TEF: "the call should pre-fill, and it
      // should be on RST Sent so I can quickly type in the RST".)
      if (p.callsign && !callInput.value) {
        callInput.value = String(p.callsign).toUpperCase();
        // Trigger the callsign lookup so QTH/past QSOs populate.
        scheduleLookup();
        rstSentInput.focus();
        rstSentInput.select();
      }
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────

  (async () => {
    try {
      const settings = await window.api.getSettings();
      // Default power from settings.defaultPower (existing field)
      if (settings && settings.defaultPower != null && powerInput.value === '') {
        powerInput.value = String(settings.defaultPower);
      }
      // Re-spot prefs hydrated from the same settings keys the spot-row
      // Log dialog and Bottom Banner Logger use, so all three desktop
      // logging paths agree on default state and comment template.
      if (settings) {
        respotDefaultPref = settings.respotDefault !== false; // default true
        if (settings.respotTemplate)      potaTemplatePref  = settings.respotTemplate;
        if (settings.wwffRespotTemplate)  wwffTemplatePref  = settings.wwffRespotTemplate;
        if (settings.llotaRespotTemplate) llotaTemplatePref = settings.llotaRespotTemplate;
        myCallsignPref = (settings.myCallsign || '').toUpperCase();
        myGridPref = (settings.grid || '').toUpperCase();
      }
      // Apply hydrated defaults to the (currently DX-by-default) chip.
      // selectChip() runs before this resolves, so push the values now.
      respotCheckEl.checked = respotDefaultPref;
      respotCommentEl.value = templateFor(selectedType);
      respotCommentIsDefault = true;
    } catch {}
  })();

  // Persist the *checkbox state* across popouts. The per-QSO comment text
  // is one-shot — never saved as the template. (Chris NR9Q: earlier builds
  // overwrote settings.respotTemplate whenever a user typed a situational
  // note like "Rare park!" into the comment, wiping their saved default.)
  // The saved template only changes from Settings → Spots.
  //
  // "Use default" behavior: checkbox checked → comment shows the current
  // network's templated text. As soon as the user types, the box auto-
  // unchecks and their custom text is preserved. Re-checking restores the
  // template (overwriting the custom text).
  respotCheckEl.addEventListener('change', () => {
    respotDefaultPref = !!respotCheckEl.checked;
    if (respotCheckEl.checked) {
      respotCommentEl.value = templateFor(selectedType);
      respotCommentIsDefault = true;
    } else {
      respotCommentIsDefault = false;
    }
    try { window.api.saveSettings({ respotDefault: respotDefaultPref }); } catch {}
  });
  respotCommentEl.addEventListener('input', () => {
    if (respotCommentEl.value !== templateFor(selectedType)) {
      respotCommentIsDefault = false;
      if (respotCheckEl.checked) respotCheckEl.checked = false;
    }
  });

  selectChip('dx');
  startClock();
  callInput.focus();

  // ── Theme (light / dark) ────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }
  if (window.api.onTheme) window.api.onTheme(applyTheme);
  // Hydrate from settings on first open in case the IPC race lets the
  // window paint dark before the did-finish-load broadcast lands.
  (async () => {
    try {
      const s = await window.api.getSettings();
      if (s && s.lightMode) applyTheme('light');
    } catch {}
  })();

  // ── Zoom (Ctrl+= / Ctrl+- / Ctrl+0) ─────────────────────────────────────
  // Persisted per-window in localStorage so a user's preferred zoom survives
  // close/reopen. Keys are independent of the main window's zoom.
  const ZOOM_KEY = 'potacat-log-popout-zoom';
  const ZOOM_MIN = 0.7, ZOOM_MAX = 2.0, ZOOM_STEP = 0.1;
  function setZoom(z) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    window.api.setZoom(clamped);
    try { localStorage.setItem(ZOOM_KEY, clamped.toFixed(2)); } catch {}
  }
  // Restore saved zoom on init.
  try {
    const saved = parseFloat(localStorage.getItem(ZOOM_KEY) || '1');
    if (isFinite(saved) && saved >= ZOOM_MIN && saved <= ZOOM_MAX) setZoom(saved);
  } catch {}
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      setZoom((window.api.getZoom() || 1) + ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom((window.api.getZoom() || 1) - ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom(1);
    }
  });
  // Also support Ctrl+wheel zoom (matches every browser convention).
  document.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    setZoom((window.api.getZoom() || 1) + dir * ZOOM_STEP);
  }, { passive: false });
})();
