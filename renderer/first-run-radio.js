// A shorter first run, part 2: the "which radio" and "radio check" screens of
// the Welcome dialog (renderer/index.html #welcome-screen-radio and
// #welcome-screen-check). The flow itself (which step, Back, Esc, the saves of
// settings.firstRunState) lives in app.js and lib/first-run.js; app.js hands
// this file its hooks as window.WelcomeFlow.
//
// Which radio: the model first (lib/rig-quick-setup.js searches the model
// table), then POTACAT fills in the connection, baud rate and CI-V address
// from it, by the same rule as the Settings rig editor. The port list is the
// one the system reports (window.api.listPorts); no port is opened to look for
// a radio. Flex "Find my radio" only listens for the radio's own broadcast
// (window.api.discoverFlex). Radio menu settings come from
// lib/rig-setup-notes.js (window.api.getRigSetupNotes), never guessed. The
// saved radio has the Settings editor's own record shape (lib/rig-record.js).
//
// Radio check: Station Setup's "POTACAT can control your radio" and "Hearing
// the radio" steps, inline (lib/radio-check.js picks them from
// window.api.stationSetupGet). It reads the CAT link and listens to the
// radio's sound input with Station Setup's own 3-second listen. Nothing here
// transmits or changes anything on the radio: there are no transmit buttons,
// and the transmit steps stay in Station Setup's window with its confirmation.
// test/first-run-radio-test.js holds this file to the window.api calls below.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dlg = $('welcome-dialog');
  if (!dlg || !window.api || !window.RigQuickSetup || !window.RadioCheck || !window.FirstRun) return;
  const Q = window.RigQuickSetup;
  const RC = window.RadioCheck;
  const flow = () => window.WelcomeFlow;

  // --- Which radio ------------------------------------------------------------

  let groups = null;      // getRigModels()
  let plan = null;        // RigQuickSetup.planForModel
  let answers = { port: '', baudRate: null, flexHost: '' };
  let flexSeq = 0;
  let notesSeq = 0;

  const search = $('wfr-search');
  const results = $('wfr-results');
  const hint = $('wfr-search-hint');
  const saveBtn = $('wfr-save');
  const errEl = $('wfr-error');

  function showError(text) {
    errEl.textContent = text || '';
    errEl.classList.toggle('hidden', !text);
  }

  async function loadGroups() {
    if (groups) return groups;
    try { groups = await window.api.getRigModels(); } catch { groups = []; }
    return groups || [];
  }

  function renderResults() {
    const found = Q.searchModels(groups || [], search.value, 8);
    results.textContent = '';
    if (!search.value.trim()) { hint.textContent = 'Start typing. Every radio POTACAT knows is listed.'; return; }
    hint.textContent = found.length ? '' : 'No radio by that name. Try only the number, for example 7300. Not listed? Choose the nearest model, or set it up in Settings > Radio.';
    for (const r of found) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wfr-result';
      b.setAttribute('role', 'option');
      const brand = document.createElement('span');
      brand.className = 'wfr-result-brand';
      brand.textContent = r.brand;
      const model = document.createElement('span');
      model.className = 'wfr-result-model';
      model.textContent = r.model;
      b.appendChild(model);
      b.appendChild(brand);
      b.addEventListener('click', () => choose(r.model));
      results.appendChild(b);
    }
  }
  search.addEventListener('input', renderResults);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = results.querySelector('.wfr-result');
      if (first) first.click();
    }
  });

  function showPicker() {
    plan = null;
    $('wfr-pick').classList.remove('hidden');
    $('wfr-setup').classList.add('hidden');
    showError('');
    updateSave();
    renderResults();
    search.focus();
  }
  $('wfr-change').addEventListener('click', showPicker);

  function updateSave() {
    const miss = plan ? Q.missing(plan, answers) : 'Choose your radio first.';
    saveBtn.disabled = !plan || !plan.quick || !!miss;
    saveBtn.classList.toggle('hidden', !plan || !plan.quick);
    saveBtn.title = miss || '';
  }

  // The ports the system lists, read again on "Look again". Nothing is opened.
  async function loadPorts(keep) {
    const sel = $('wfr-port');
    const note = $('wfr-port-note');
    let ports = [];
    try { ports = await window.api.listPorts(); } catch { ports = []; }
    const shown = Q.radioPorts(ports);
    const sug = Q.suggestPort(ports, plan);
    const pick = keep && shown.some((p) => p.path === keep) ? keep : sug.path;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = shown.length ? 'Choose the radio\'s port' : 'No port is showing';
    sel.appendChild(none);
    for (const p of shown) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.path + ' — ' + (p.friendlyName || p.path);
      sel.appendChild(o);
    }
    sel.value = pick || '';
    answers.port = sel.value;
    if (!shown.length) note.textContent = 'No port is showing. Plug the radio\'s USB cable into this computer, switch the radio on, then press Look again.';
    else if (pick && pick === keep) note.textContent = '';
    else if (sug.reason === 'only') note.textContent = sug.path + ' is the only port showing, so POTACAT chose it.';
    else if (sug.reason === 'match') note.textContent = 'POTACAT chose ' + sug.path + ': its name matches your radio.';
    else note.textContent = 'More than one port is showing. To find the radio\'s: unplug its USB cable, press Look again, and see which port is gone. Then plug it back in and press Look again.';
    updateSave();
  }
  $('wfr-port').addEventListener('change', () => { answers.port = $('wfr-port').value; $('wfr-port-note').textContent = ''; updateSave(); });
  $('wfr-port-refresh').addEventListener('click', () => loadPorts(answers.port));

  $('wfr-baud').addEventListener('change', () => { answers.baudRate = parseInt($('wfr-baud').value, 10) || null; });

  // Flex: listen for the radio's own broadcast (it announces itself every
  // second or so). Nothing is sent to the network to look for it.
  async function findFlex() {
    const btn = $('wfr-flex-find');
    const note = $('wfr-flex-note');
    const seq = ++flexSeq;
    btn.disabled = true;
    note.textContent = 'Listening for your FlexRadio...';
    let radios = [];
    try { radios = await window.api.discoverFlex(); } catch { radios = []; }
    if (seq !== flexSeq) return;
    btn.disabled = false;
    if (radios && radios.length) {
      const r = radios[0];
      $('wfr-flex-host').value = r.ip;
      answers.flexHost = r.ip;
      note.textContent = 'Found ' + (r.model || 'FlexRadio') + (r.nickname ? ' "' + r.nickname + '"' : '') + ' at ' + r.ip + '.' +
        (radios.length > 1 ? ' ' + radios.length + ' radios answered and POTACAT chose the first. Type another address if that one is not yours.' : '');
    } else {
      note.textContent = 'No FlexRadio answered. Make sure it is switched on and on the same network as this computer, then press Find my radio again. You can also type its address.';
    }
    updateSave();
  }
  $('wfr-flex-find').addEventListener('click', findFlex);
  $('wfr-flex-host').addEventListener('input', () => { answers.flexHost = $('wfr-flex-host').value.trim(); updateSave(); });

  // Radio menu settings for talking to the computer (feature CAT), from the
  // rig notes only. Shown, never applied: POTACAT cannot change them over CAT.
  async function loadNotes() {
    const box = $('wfr-notes');
    const seq = ++notesSeq;
    let notes = [];
    try { notes = await window.api.getRigSetupNotes({ model: plan.model, radioType: plan.radioType }) || []; } catch { notes = []; }
    if (seq !== notesSeq || !plan) return;
    const cat = notes.filter((n) => n && n.feature === 'CAT');
    box.textContent = '';
    box.classList.toggle('hidden', !cat.length);
    if (!cat.length) return;
    const head = document.createElement('div');
    head.className = 'wfr-notes-head';
    head.textContent = 'On the radio';
    box.appendChild(head);
    for (const n of cat) {
      const t = document.createElement('div');
      t.className = 'wfr-note-title';
      t.textContent = n.title + (n.level === 'required' ? ' (needed)' : '');
      box.appendChild(t);
      const ol = document.createElement(n.steps.length > 1 ? 'ol' : 'ul');
      ol.className = 'wfr-note-steps';
      for (const s of n.steps) {
        const li = document.createElement('li');
        li.textContent = s;
        ol.appendChild(li);
      }
      box.appendChild(ol);
      // The reason is kept for what the radio needs; the rest stay short.
      if (n.why && n.level === 'required') {
        const w = document.createElement('div');
        w.className = 'wfr-note-why';
        w.textContent = n.why;
        box.appendChild(w);
      }
    }
  }

  async function choose(model, prev) {
    await loadGroups();
    plan = Q.planForModel(groups, model);
    if (!plan) { showPicker(); return; }
    const p = prev || {};
    answers = { port: p.port || '', baudRate: p.baudRate || plan.baudRate, flexHost: p.flexHost || '' };
    $('wfr-pick').classList.add('hidden');
    $('wfr-setup').classList.remove('hidden');
    showError('');
    $('wfr-chosen-name').textContent = (model.toLowerCase().startsWith(plan.brand.toLowerCase()) ? '' : plan.brand + ' ') + model;
    $('wfr-how').textContent = plan.quick ? plan.how : '';
    $('wfr-how').classList.toggle('hidden', !plan.quick);

    $('wfr-port-row').classList.toggle('hidden', !plan.needsPort);
    if (plan.needsPort) loadPorts(answers.port);

    $('wfr-baud-row').classList.toggle('hidden', !plan.chooseBaud);
    if (plan.chooseBaud) {
      const sel = $('wfr-baud');
      sel.innerHTML = '';
      for (const b of Q.BAUD_CHOICES) {
        const o = document.createElement('option');
        o.value = String(b);
        o.textContent = String(b);
        sel.appendChild(o);
      }
      sel.value = String(answers.baudRate || plan.baudRate);
    }

    $('wfr-flex-row').classList.toggle('hidden', plan.radioType !== 'flex');
    $('wfr-flex-host').value = answers.flexHost;
    if (plan.radioType === 'flex' && !answers.flexHost) findFlex();

    // Connections this screen does not set up, or the network way of reaching
    // a radio it does: the full rig editor in Settings, with the model picked.
    const full = $('wfr-full-row');
    full.classList.toggle('hidden', plan.quick && !plan.networkAlt);
    $('wfr-full-text').textContent = plan.quick
      ? 'Connected over your network instead of a USB cable?'
      : 'POTACAT connects to this radio over the network. Its settings are in Settings > Radio.';
    $('wfr-full-btn').textContent = plan.quick ? 'Set it up in Settings > Radio' : 'Open radio settings';
    $('wfr-full-btn').className = plan.quick ? 'wfr-link' : 'welcome-back-btn';

    loadNotes();
    updateSave();
  }

  $('wfr-full-btn').addEventListener('click', async () => {
    const model = plan && plan.model;
    flow().closeFlow();
    if (typeof openSettingsDialog !== 'function') return;
    await openSettingsDialog('radio');
    if (typeof openRigEditor !== 'function') return;
    await openRigEditor('add');
    const sel = $('set-rig-model-select');
    if (sel && model) { sel.value = model; sel.dispatchEvent(new Event('change')); }
  });

  // Save: the radio in the Settings editor's record shape, made the radio in
  // use (the CAT menu's switch: save, then connect). The connection is the
  // operator's own choice of radio; nothing is sent to it but CAT reads.
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled || !plan) return;
    showError('');
    saveBtn.disabled = true;
    try {
      const s = await window.api.getSettings();
      const st = flow().getState();
      const prev = st && st.rigId ? (s.rigs || []).find((r) => r && r.id === st.rigId) : null;
      const rig = Q.buildRig(plan, { id: prev ? prev.id : '', port: answers.port, baudRate: answers.baudRate, flexHost: answers.flexHost });
      if (!rig) { showError('This radio is set up in Settings > Radio.'); return; }
      if (prev && prev.model === rig.model) {
        // Came Back from the check: keep the sound devices chosen there.
        rig.remoteAudioInput = prev.remoteAudioInput || '';
        rig.remoteAudioOutput = prev.remoteAudioOutput || '';
      }
      await window.api.saveSettings(Q.activationPatch(s.rigs, rig));
      window.api.connectCat(rig.catTarget);
      const r = window.FirstRun.saveRadio(st, rig.id);
      flow().setState(r.state);
      await window.api.saveSettings(r.patch);
      if (typeof loadPrefs === 'function') loadPrefs();
      flow().showStep('check');
    } catch (e) {
      showError('The radio could not be saved: ' + ((e && e.message) || e));
    } finally {
      updateSave();
    }
  });

  $('wfr-back').addEventListener('click', () => flow().goTo('where'));

  async function showRadio() {
    await loadGroups();
    const st = flow().getState();
    let prev = null;
    if (st && st.rigId) {
      try {
        const s = await window.api.getSettings();
        prev = (s.rigs || []).find((r) => r && r.id === st.rigId) || null;
      } catch { prev = null; }
    }
    if (prev && prev.model && Q.planForModel(groups, prev.model)) {
      const t = prev.catTarget || {};
      await choose(prev.model, { port: t.path || t.serialPort || '', baudRate: t.baudRate || null, flexHost: prev.flexApiHost || '' });
    } else {
      search.value = '';
      showPicker();
    }
  }

  // --- Radio check ------------------------------------------------------------

  const ICON = { ok: '✓', confirmed: '✓', needs: '!', unknown: '?', blocked: '–', skipped: '–', optional: '·' };
  let checkTimer = null;
  let payload = null;
  let busy = '';          // the listen in progress, shown on the hearing step
  let listenedOnce = false;
  let audioNote = '';
  let checkRig = null;    // the saved radio being checked
  const stepsEl = $('wfc-steps');
  const blocks = {};      // step id -> { root, icon, title, detail, extra, instr, actions }

  function stopCheck() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  }

  function block(id) {
    if (blocks[id]) return blocks[id];
    const root = document.createElement('div');
    root.className = 'wfc-step';
    const icon = document.createElement('div');
    icon.className = 'wfc-icon';
    const main = document.createElement('div');
    main.className = 'wfc-main';
    const title = document.createElement('div');
    title.className = 'wfc-title';
    const detail = document.createElement('div');
    detail.className = 'wfc-detail';
    const extra = document.createElement('div');
    extra.className = 'wfc-extra';
    const instr = document.createElement('div');
    const actions = document.createElement('div');
    actions.className = 'wfc-actions';
    main.append(title, detail, extra, instr, actions);
    root.append(icon, main);
    stepsEl.appendChild(root);
    return (blocks[id] = { root, icon, title, detail, extra, instr, actions });
  }

  function renderCheck() {
    const view = RC.inlineSteps(payload);
    for (const st of view.steps) {
      const b = block(st.id);
      b.root.className = 'wfc-step wfc-state-' + st.state;
      b.icon.textContent = ICON[st.state] || '?';
      b.title.textContent = st.title;
      b.detail.textContent = st.id === 'rx-audio' && busy ? busy : st.detail;
      if (st.id === 'radio-control') {
        b.extra.textContent = st.state === 'ok' && /MHz/.test(st.detail) ? 'Turn the radio\'s dial: this number follows.' : '';
      } else if (st.id === 'rx-audio') {
        const n = b.extra.querySelector('.wfc-audio-note');
        if (n) n.textContent = audioNote;
      }
      b.instr.textContent = '';
      if (st.state === 'needs' || (st.state === 'unknown' && st.instructions.length)) {
        for (const blk of st.instructions) {
          if (blk.title) {
            const t = document.createElement('div');
            t.className = 'wfc-instr-title';
            t.textContent = blk.title;
            b.instr.appendChild(t);
          }
          const ol = document.createElement((blk.steps || []).length > 1 ? 'ol' : 'ul');
          ol.className = 'wfc-instr';
          for (const line of blk.steps || []) {
            const li = document.createElement('li');
            li.textContent = line;
            ol.appendChild(li);
          }
          b.instr.appendChild(ol);
          if (blk.why) {
            const w = document.createElement('div');
            w.className = 'wfc-why';
            w.textContent = blk.why;
            b.instr.appendChild(w);
          }
        }
      }
      b.actions.textContent = '';
      st.actions.forEach((a, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'welcome-back-btn' + (i === 0 && (st.state === 'needs' || st.state === 'unknown') ? ' wfc-primary' : '');
        btn.textContent = a.label;
        btn.disabled = !!busy;
        btn.addEventListener('click', () => runCheckAction(a.id));
        b.actions.appendChild(btn);
      });
    }
    const done = $('wfc-done');
    done.textContent = view.passed ? 'Done' : 'Finish for now';
  }

  async function refreshCheck() {
    if (!dlg.open || !checkRig) return;
    try { payload = await window.api.stationSetupGet(checkRig.id); } catch { return; }
    renderCheck();
  }

  // The 3-second listen is Station Setup's own (renderer/station-setup.js);
  // main keeps the result for the checklist, so Station Setup shows it too.
  async function listen() {
    if (busy || !checkRig || !window.StationSetupChecks) return;
    const s = await window.api.getSettings();
    const rig = (s.rigs || []).find((r) => r && r.id === checkRig.id) || {};
    if (!rig.remoteAudioInput) return;
    busy = 'Listening for 3 seconds...';
    renderCheck();
    let result;
    try { result = await window.StationSetupChecks.listenTest(rig.remoteAudioInput); } catch (e) { result = { result: 'error', error: (e && e.message) || 'could not listen' }; }
    try { payload = await window.api.stationSetupReport({ rigId: checkRig.id, kind: 'rxTest', result }); } catch {}
    busy = '';
    listenedOnce = true;
    renderCheck();
  }

  function runCheckAction(id) {
    if (!RC.ACTIONS.includes(id)) return;
    if (id === 'recheck') return refreshCheck();
    if (id === 'rx-test') return listen();
    if (id === 'open-rig-editor') return flow().goTo('radio');
  }

  // The sound input for "Hearing the radio": the radio's own, picked from the
  // names when one plainly matches, saved on the radio, and said in one line.
  async function setupAudioRow() {
    const b = block('rx-audio');
    b.extra.textContent = '';
    if (!checkRig || RC.audioIsNetwork(checkRig.audioSource)) return;
    const row = document.createElement('label');
    row.className = 'wfc-audio-row';
    row.textContent = 'The radio\'s sound input ';
    const sel = document.createElement('select');
    sel.className = 'wfc-audio-select';
    row.appendChild(sel);
    const note = document.createElement('div');
    note.className = 'wfc-audio-note help-text';
    b.extra.append(row, note);
    let devices = [];
    try { if (typeof MicLabelProbe !== 'undefined') await MicLabelProbe.unlockDeviceLabels(navigator.mediaDevices); } catch {}
    try {
      devices = typeof enumerateAudioDevicesAugmented === 'function'
        ? await enumerateAudioDevicesAugmented() : await navigator.mediaDevices.enumerateDevices();
    } catch { devices = []; }
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId && !d.isAlsaSeparator);
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose the radio\'s sound input';
    sel.appendChild(none);
    for (const d of inputs) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || (d.deviceId.slice(0, 12) + '...');
      sel.appendChild(o);
    }
    const s = await window.api.getSettings();
    const rig = (s.rigs || []).find((r) => r && r.id === checkRig.id) || {};
    let chosen = rig.remoteAudioInput || '';
    if (!chosen) {
      const sug = RC.suggestInput(devices, checkRig.model, checkRig.brand);
      if (sug) {
        await saveInput(sug, devices);
        chosen = sug;
        const d = inputs.find((x) => x.deviceId === sug);
        audioNote = 'POTACAT chose ' + ((d && d.label) || 'the radio\'s sound card') + ' because its name matches a radio.';
      } else {
        audioNote = 'Choose the sound input that belongs to the radio. It is usually called "USB Audio CODEC" or has the radio\'s name in it.';
      }
    }
    sel.value = chosen;
    note.textContent = audioNote;
    sel.addEventListener('change', async () => {
      await saveInput(sel.value, devices);
      audioNote = '';
      note.textContent = '';
      await refreshCheck();
      if (sel.value) listen();
    });
    await refreshCheck();
    // Station Setup runs this listen by itself when the checklist opens; so
    // does the check (it transmits nothing).
    if (chosen && !listenedOnce) listen();
  }

  async function saveInput(inputId, devices) {
    const s = await window.api.getSettings();
    const patch = RC.audioPatch(s.rigs, checkRig.id, inputId, inputId ? RC.matchingOutput(devices, inputId) : '');
    if (patch) await window.api.saveSettings(patch);
  }

  async function showCheck() {
    stopCheck();
    stepsEl.textContent = '';
    for (const k of Object.keys(blocks)) delete blocks[k];
    busy = '';
    listenedOnce = false;
    audioNote = '';
    payload = null;
    // The checklist's two steps are on screen now: the after-Welcome launch
    // card must not offer Station Setup again in this sitting (#1076, #1078).
    if (typeof window.stationSetupSeenInline === 'function') window.stationSetupSeenInline();
    const st = flow().getState();
    const s = await window.api.getSettings();
    const rig = st && st.rigId ? (s.rigs || []).find((r) => r && r.id === st.rigId) : null;
    if (!rig) { flow().goTo('radio'); return; }
    await loadGroups();
    const p = Q.planForModel(groups, rig.model);
    checkRig = { id: rig.id, model: rig.model || '', brand: p ? p.brand : '', audioSource: rig.audioSource || '' };
    block('radio-control');
    block('rx-audio');
    await refreshCheck();
    setupAudioRow();
    // Live read-back: the frequency follows the dial while this screen is up.
    checkTimer = setInterval(() => { if (!busy) refreshCheck(); }, 1500);
  }

  async function endCheck(result) {
    stopCheck();
    const r = window.FirstRun.finishCheck(flow().getState(), result);
    if (r.error) return;
    flow().setState(r.state);
    await window.api.saveSettings(r.patch);
    flow().closeFlow();
  }
  $('wfc-done').addEventListener('click', () => endCheck(RC.outcome(payload)));
  $('wfc-skip').addEventListener('click', () => endCheck('skipped'));
  $('wfc-back').addEventListener('click', () => { stopCheck(); flow().goTo('radio'); });
  dlg.addEventListener('close', stopCheck);

  window.FirstRunRadio = {
    show(step) {
      if (step !== 'check') stopCheck();
      if (step === 'radio') return showRadio();
      if (step === 'check') return showCheck();
    },
  };
})();
