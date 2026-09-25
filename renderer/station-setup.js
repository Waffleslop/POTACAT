// Station Setup — the per-radio checklist window and the launch card.
//
// Policy lives in lib/station-setup.js (main evaluates it and sends the
// steps); this file draws them and runs the two checks that need an audio
// device opened in a renderer: the 3-second listen and the output-device open.
// Written for the operator least comfortable with computers: one step
// highlighted as "next", plain words, and a button wherever POTACAT can do
// the work. Transmitting always asks first, in the window, with the warning.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dlg = $('station-setup-dialog');
  if (!dlg || !window.api || !window.api.stationSetupGet) return;

  const stepsEl = $('ss-steps');
  const progressEl = $('ss-progress');
  const messageEl = $('ss-message');
  const rigSel = $('ss-rig');
  const card = $('station-setup-card');
  const shareEl = $('ss-share');

  let rigId = null;
  let current = null;
  let busy = {};            // step id -> label while a check runs
  let confirmTx = null;     // action id awaiting the transmit confirmation
  let autoRan = new Set();  // rigId:check — automatic checks run once per open
  // "Share my working setup": null | 'form' | 'preview' | 'sending'
  let shareMode = null;
  let shareNotes = '';
  let shareCallsign = false;
  let sharePreview = null;

  const ICON = { ok: '✓', confirmed: '✓', needs: '!', unknown: '?', blocked: '–', optional: '·', skipped: '–' };
  const TAG = { confirmed: 'you confirmed this', optional: 'optional', skipped: 'not using', blocked: 'waiting on a step above' };

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function showMessage(text) {
    if (!text) { messageEl.classList.add('hidden'); messageEl.textContent = ''; return; }
    messageEl.textContent = text;
    messageEl.classList.remove('hidden');
  }

  // Settings keeps its own copy of the rig list (app.js currentRigs) and
  // saves the whole list. When the checklist changes a rig's setup fields
  // with Settings open underneath, bring that copy up to date, or the next
  // Settings save would put the old values back.
  const RIG_SETUP_FIELDS = ['setupDone', 'setupSkipped', 'setupChecklistHidden', 'setupAnnounced', 'setupPassed', 'setupShareId', 'setupShared'];
  async function syncSettingsRigCopy() {
    try {
      if (typeof currentRigs === 'undefined' || !Array.isArray(currentRigs) || !currentRigs.length) return;
      const s = await window.api.getSettings();
      for (const fresh of s.rigs || []) {
        const mine = currentRigs.find(r => r && r.id === fresh.id);
        if (!mine) continue;
        for (const k of RIG_SETUP_FIELDS) if (k in fresh) mine[k] = fresh[k];
      }
    } catch {}
  }

  async function refresh() {
    current = await window.api.stationSetupGet(rigId);
    if (current && current.rig) rigId = current.rig.id;
    render();
    return current;
  }

  function render() {
    if (!current || !current.rig) {
      $('ss-title').textContent = 'Station Setup';
      progressEl.textContent = '';
      stepsEl.innerHTML = '<p class="ss-detail">Add your radio first: Settings, then My Rigs, then Add Rig.</p>';
      rigSel.classList.add('hidden');
      return;
    }
    $('ss-title').textContent = 'Station Setup — ' + (current.rig.model || current.rig.name);
    // Radio picker only when there is more than one.
    rigSel.innerHTML = '';
    for (const r of current.rigs || []) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name + (r.active ? ' (in use)' : '');
      rigSel.appendChild(o);
    }
    rigSel.value = current.rig.id;
    rigSel.classList.toggle('hidden', (current.rigs || []).length < 2);

    const s = current.summary;
    progressEl.innerHTML = s.requiredLeft === 0
      ? '<strong>Everything you need is working.</strong> The optional items below are only for features you may want.'
      : `<strong>${s.requiredTotal - s.requiredLeft} of ${s.requiredTotal}</strong> essential steps are working. ` +
        (s.next ? 'The highlighted step is next.' : '');

    $('ss-hide').textContent = current.prefs && current.prefs.hidden
      ? 'Show reminders again for this radio' : 'Don\'t show this again for this radio';

    stepsEl.innerHTML = '';
    let group = null;
    for (const st of current.steps) {
      if (st.group !== group) {
        group = st.group;
        const g = document.createElement('div');
        g.className = 'ss-group';
        g.textContent = group;
        stepsEl.appendChild(g);
      }
      stepsEl.appendChild(renderStep(st, st.id === s.next));
    }
    renderShare();
  }

  // --- "Share my working setup" (lib/setup-share.js) -------------------------
  // Offered only when every essential step works. The preview is built by
  // main from the SAME payload Send posts, so what the operator reads is
  // exactly what leaves the computer.

  function renderShare() {
    if (!shareEl) return;
    const sh = current && current.share;
    // Lives at the end of the scrolling step list (render() empties that list,
    // so it is re-attached every time).
    stepsEl.appendChild(shareEl);
    if (!sh || !sh.eligible) { shareEl.classList.add('hidden'); shareEl.innerHTML = ''; return; }
    shareEl.classList.remove('hidden');
    shareEl.innerHTML = '';
    const name = current.rig.model || current.rig.name;
    const p = (html) => { const d = document.createElement('div'); d.innerHTML = html; shareEl.appendChild(d); return d; };
    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls; b.textContent = label;
      b.disabled = shareMode === 'sending';
      b.addEventListener('click', fn);
      return b;
    };
    const row = () => { const r = document.createElement('div'); r.className = 'ss-actions'; shareEl.appendChild(r); return r; };

    if (!shareMode) {
      p('<strong>Help other ' + esc(name) + ' owners.</strong> Your radio is working. You can send POTACAT your working settings so they become the defaults for everyone with this radio.');
      if (sh.pending) p('Your settings are saved and will be sent the next time POTACAT starts.');
      else if (sh.sharedAt) p("You shared this radio's settings on " + esc(new Date(sh.sharedAt).toISOString().slice(0, 10)) + '. Thank you.');
      row().appendChild(btn(sh.sharedAt || sh.pending ? 'Share again' : 'Share my working setup', sh.sharedAt || sh.pending ? 'ss-btn' : 'ss-btn ss-btn-primary', () => { shareMode = 'form'; render(); }));
      return;
    }

    if (shareMode === 'form') {
      p('<strong>One question (you can leave it empty).</strong> Did you change anything in the radio&rsquo;s own menus to get it working with POTACAT? Tell us what, in your own words. For example: which menu you changed and what you set it to.');
      const ta = document.createElement('textarea');
      ta.maxLength = 1000;
      ta.value = shareNotes;
      ta.placeholder = 'Menu settings you changed, if you remember';
      ta.addEventListener('input', () => { shareNotes = ta.value; });
      shareEl.appendChild(ta);
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = shareCallsign;
      cb.addEventListener('change', () => { shareCallsign = cb.checked; });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode('Include my callsign, so POTACAT can ask me about it'));
      shareEl.appendChild(lab);
      const r = row();
      r.appendChild(btn('See what will be sent', 'ss-btn ss-btn-primary', showSharePreview));
      r.appendChild(btn('Cancel', 'ss-btn', () => { shareMode = null; render(); }));
      return;
    }

    // preview / sending
    p('<strong>This is everything that will be sent.</strong> No passwords, addresses or computer names are ever included.');
    const dl = document.createElement('dl');
    dl.className = 'ss-share-list';
    for (const line of (sharePreview && sharePreview.lines) || []) {
      const dt = document.createElement('dt'); dt.textContent = line.label;
      const dd = document.createElement('dd'); dd.textContent = line.value;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    shareEl.appendChild(dl);
    if (sharePreview && sharePreview.alreadyShared) p('You already sent exactly these settings. Sending again just updates them.');
    const r = row();
    r.appendChild(btn(shareMode === 'sending' ? 'Sending…' : 'Send', 'ss-btn ss-btn-primary', sendShare));
    r.appendChild(btn('Change my answer', 'ss-btn', () => { shareMode = 'form'; render(); }));
    r.appendChild(btn('Cancel', 'ss-btn', () => { shareMode = null; render(); }));
  }

  // Device names, not ids: main never sees labels, and an id is a
  // per-machine hash that means nothing to anyone else.
  async function shareAudioLabels() {
    const out = { input: '', output: '' };
    try {
      const dev = await rigDevices();
      const list = await navigator.mediaDevices.enumerateDevices();
      const find = (id, kind) => { const d = list.find(x => x.deviceId === id && x.kind === kind); return d ? d.label : ''; };
      out.input = find(dev.input, 'audioinput');
      out.output = find(dev.output, 'audiooutput');
    } catch {}
    return out;
  }

  function shareRequest(labels) {
    return { rigId, audioLabels: labels, answers: { menuNotes: shareNotes, includeCallsign: shareCallsign } };
  }

  async function showSharePreview() {
    const labels = await shareAudioLabels();
    let res = null;
    try { res = await window.api.stationSetupSharePreview(shareRequest(labels)); } catch {}
    if (!res || res.error) { showMessage((res && res.error) || 'Could not prepare the report.'); shareMode = null; render(); return; }
    sharePreview = res;
    shareMode = 'preview';
    render();
  }

  async function sendShare() {
    shareMode = 'sending';
    render();
    const labels = await shareAudioLabels();
    try { current = await window.api.stationSetupShareSend(shareRequest(labels)); } catch {}
    shareMode = null;
    sharePreview = null;
    showMessage(current && current.message);
    render();
  }

  function renderStep(st, isNext) {
    const el = document.createElement('div');
    el.className = `ss-step ss-state-${st.state}` + (isNext ? ' ss-next' : '');
    el.dataset.step = st.id;
    const tag = busy[st.id] ? busy[st.id] : (TAG[st.state] || (isNext ? 'next' : ''));
    el.innerHTML = `<div class="ss-icon">${ICON[st.state] || '?'}</div>` +
      `<div class="ss-step-title">${esc(st.title)}${tag ? `<span class="ss-tag">${esc(tag)}</span>` : ''}</div>`;
    const body = document.createElement('div');
    body.className = 'ss-step-body';
    const detail = document.createElement('div');
    detail.className = 'ss-detail';
    detail.textContent = st.detail || '';
    body.appendChild(detail);

    // Instructions: expanded for anything that needs the operator, and for
    // optional steps (they are the explanation of what the feature needs).
    const showInstr = st.state === 'needs' || st.state === 'optional' || (st.state === 'unknown' && st.instructions && st.instructions.length);
    if (showInstr) {
      for (const block of st.instructions || []) {
        if (block.title) {
          const t = document.createElement('div');
          t.className = 'ss-instr-title';
          t.textContent = block.title;
          body.appendChild(t);
        }
        const ol = document.createElement(block.steps && block.steps.length > 1 ? 'ol' : 'ul');
        ol.className = 'ss-instr';
        for (const line of block.steps || []) {
          const li = document.createElement('li');
          li.textContent = line;
          ol.appendChild(li);
        }
        body.appendChild(ol);
        if (block.why) {
          const w = document.createElement('div');
          w.className = 'ss-why';
          w.textContent = block.why;
          body.appendChild(w);
        }
      }
    }

    if (confirmTx && confirmTx.step === st.id) {
      body.appendChild(renderTxConfirm());
    } else if (st.actions && st.actions.length) {
      const row = document.createElement('div');
      row.className = 'ss-actions';
      st.actions.forEach((a, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        const primary = i === 0 && (st.state === 'needs' || st.state === 'unknown');
        b.className = a.id === 'skip' ? 'ss-link' : ('ss-btn' + (primary ? ' ss-btn-primary' : ''));
        b.textContent = a.label;
        b.disabled = !!busy[st.id];
        b.addEventListener('click', () => runAction(st, a));
        row.appendChild(b);
      });
      body.appendChild(row);
    }
    el.appendChild(body);
    return el;
  }

  function renderTxConfirm() {
    const box = document.createElement('div');
    box.className = 'ss-confirm';
    const keep = confirmTx.action === 'tx-test-current-power';
    box.innerHTML =
      `<div><strong>This will transmit for 3 seconds${keep ? ' at the power the radio is set to now' : ' at low power'}.</strong></div>` +
      '<ul class="ss-instr">' +
      '<li>Make sure your antenna or a dummy load is connected.</li>' +
      '<li>Listen first: the frequency the radio is on should be clear.</li>' +
      (keep ? '' : '<li>POTACAT turns the power down for the test and puts it back afterwards.</li>') +
      '</ul>';
    const row = document.createElement('div');
    row.className = 'ss-actions';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ss-btn ss-btn-danger';
    go.textContent = 'Transmit now';
    go.addEventListener('click', async () => {
      const act = confirmTx.action, step = confirmTx.step;
      confirmTx = null;
      busy[step] = 'transmitting…';
      render();
      try { current = await window.api.stationSetupAction({ rigId, action: act }); } catch {}
      delete busy[step];
      showMessage(current && current.message);
      render();
      afterChange();
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ss-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { confirmTx = null; render(); });
    row.appendChild(go);
    row.appendChild(cancel);
    box.appendChild(row);
    return box;
  }

  // --- checks that run here --------------------------------------------------

  // Listen to the radio's input for 3 s and report the loudest RMS in dBFS.
  // -80 dBFS is the app's "NO RX AUDIO" line; -50 its "RX AUDIO LOW" line.
  async function listenTest(deviceId) {
    if (!deviceId) return { result: 'error', error: 'no input chosen' };
    if (/^alsa:/.test(deviceId)) return { result: 'unsupported', error: 'This input is a Linux sound device POTACAT opens directly; it is checked when FT8 runs.' };
    let stream = null, ctx = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        await new Promise(r => setTimeout(r, 100));
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > peak) peak = rms;
      }
      const dbfs = peak > 0 ? 20 * Math.log10(peak) : -120;
      return { result: dbfs < -80 ? 'silent' : dbfs < -50 ? 'low' : 'ok', dbfs };
    } catch (err) {
      return { result: 'error', error: (err && (err.message || err.name)) || 'could not open the input' };
    } finally {
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {}
      try { if (ctx) ctx.close(); } catch {}
    }
  }

  // Open the configured output the way FT8 TX does (setSinkId is the only
  // ground truth — enumerateDevices misses ids setSinkId accepts).
  async function outputTest(deviceId) {
    if (!deviceId) return { ok: false, error: 'no output chosen' };
    if (/^alsa:/.test(deviceId)) return { ok: false, result: 'unsupported', error: 'This output is a Linux sound device POTACAT opens directly; it is checked when you transmit.' };
    let ctx = null;
    try {
      ctx = new AudioContext();
      if (typeof ctx.setSinkId !== 'function') return { ok: false, result: 'unsupported', error: 'This system cannot choose an audio output here.' };
      await ctx.setSinkId(deviceId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && (err.message || err.name)) || 'could not open the output' };
    } finally {
      try { if (ctx) ctx.close(); } catch {}
    }
  }

  async function rigDevices() {
    const s = await window.api.getSettings();
    const rig = (s.rigs || []).find(r => r.id === rigId) || {};
    return { input: rig.remoteAudioInput || '', output: rig.remoteAudioOutput || '' };
  }

  async function afterChange() { await syncSettingsRigCopy(); }

  async function runLocalCheck(stepId, kind) {
    busy[stepId] = kind === 'rxTest' ? 'listening…' : 'checking…';
    render();
    const dev = await rigDevices();
    const result = kind === 'rxTest' ? await listenTest(dev.input) : await outputTest(dev.output);
    try { current = await window.api.stationSetupReport({ rigId, kind, result }); } catch {}
    delete busy[stepId];
    render();
    afterChange();
  }

  async function runAction(st, a) {
    showMessage('');
    switch (a.id) {
      case 'rx-test': return runLocalCheck(st.id, 'rxTest');
      case 'tx-device-test': return runLocalCheck(st.id, 'txDeviceTest');
      case 'tx-test':
      case 'tx-test-current-power':
        confirmTx = { step: st.id, action: a.id };
        return render();
      case 'open-settings':
        dlg.close();
        if (typeof openSettingsDialog === 'function') openSettingsDialog('station');
        return;
      case 'open-rig-editor':
        dlg.close();
        if (typeof openSettingsDialog === 'function') {
          await openSettingsDialog('radio');
          if (typeof openRigEditor === 'function' && rigId) openRigEditor('edit', rigId);
        }
        return;
      default: {
        busy[st.id] = 'working…';
        render();
        try {
          current = await window.api.stationSetupAction({ rigId, action: a.id, step: a.step, noteIds: a.noteIds });
        } catch {}
        delete busy[st.id];
        showMessage(current && current.message);
        render();
        afterChange();
      }
    }
  }

  // Checks that cost nothing and transmit nothing run by themselves on open,
  // once, so the operator sees real answers instead of question marks.
  async function autoChecks() {
    if (!current || !current.steps) return;
    const once = (k) => { const key = rigId + ':' + k; if (autoRan.has(key)) return false; autoRan.add(key); return true; };
    const by = (id) => current.steps.find(x => x.id === id);
    const tx = by('tx-audio');
    if (tx && tx.state === 'unknown' && tx.actions.some(a => a.id === 'tx-device-test') && once('tx')) await runLocalCheck('tx-audio', 'txDeviceTest');
    const rx = by('rx-audio');
    if (rx && rx.state === 'unknown' && rx.actions.some(a => a.id === 'rx-test') && once('rx')) await runLocalCheck('rx-audio', 'rxTest');
    const clk = by('clock');
    if (clk && clk.state === 'unknown' && once('clock')) {
      busy.clock = 'checking…';
      render();
      try { current = await window.api.stationSetupAction({ rigId, action: 'check-clock' }); } catch {}
      delete busy.clock;
      render();
    }
  }

  async function open(id) {
    rigId = id || null;
    busy = {};
    confirmTx = null;
    shareMode = null;
    sharePreview = null;
    showMessage('');
    hideCard();
    await refresh();
    if (!dlg.open) dlg.showModal();
    autoChecks();
  }

  // --- wiring ----------------------------------------------------------------

  dlg.addEventListener('close', () => { afterChange(); });
  $('ss-close').addEventListener('click', () => dlg.close());
  $('ss-done').addEventListener('click', () => dlg.close());
  $('ss-recheck').addEventListener('click', async () => {
    autoRan = new Set();
    showMessage('');
    await refresh();
    autoChecks();
  });
  $('ss-hide').addEventListener('click', async () => {
    const hidden = current && current.prefs && current.prefs.hidden;
    current = await window.api.stationSetupAction({ rigId, action: hidden ? 'unhide' : 'hide' });
    afterChange();
    showMessage(hidden
      ? 'Reminders are back on for this radio.'
      : 'POTACAT will not remind you about this radio again. You can always open Station Setup from the More menu or from Settings.');
    render();
  });
  rigSel.addEventListener('change', () => open(rigSel.value));
  window.api.onStationSetupChanged(() => { if (dlg.open && !confirmTx && !shareMode && !Object.keys(busy).length) refresh(); });

  const moreBtn = $('view-station-setup-btn');
  if (moreBtn) moreBtn.addEventListener('click', () => open());
  const settingsBtn = $('settings-station-setup-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => open());

  // --- launch card -----------------------------------------------------------

  let cardRigId = null, cardNewSteps = [];
  function hideCard() { if (card) card.classList.add('hidden'); }
  function showCard(text) {
    $('ss-card-text').textContent = text;
    card.classList.remove('hidden');
  }
  $('ss-card-continue').addEventListener('click', () => {
    if (cardNewSteps.length) window.api.stationSetupAction({ rigId: cardRigId, action: 'announced', steps: cardNewSteps });
    open(cardRigId);
  });
  $('ss-card-later').addEventListener('click', () => {
    // "Later" = next launch. A new-feature card is also marked seen so it is
    // offered once, as promised; the unfinished-setup card comes back.
    if (cardNewSteps.length) window.api.stationSetupAction({ rigId: cardRigId, action: 'announced', steps: cardNewSteps });
    hideCard();
  });
  $('ss-card-never').addEventListener('click', async () => {
    if (cardNewSteps.length) await window.api.stationSetupAction({ rigId: cardRigId, action: 'announced', steps: cardNewSteps });
    await window.api.stationSetupAction({ rigId: cardRigId, action: 'hide' });
    hideCard();
  });

  // Called once, some seconds after launch, so the radio has had time to
  // connect (a radio still connecting must not read as "setup unfinished").
  async function launchCheck() {
    let p;
    try { p = await window.api.stationSetupGet(); } catch { return; }
    if (!p || !p.rig || !p.launch || p.launch.firstRun || dlg.open) return;
    const name = p.rig.model || p.rig.name;
    cardRigId = p.rig.id;
    cardNewSteps = [];
    if (p.launch.prompt) {
      const left = p.summary.requiredNeverDone;
      showCard(`Finish setting up your ${name}: ${left} step${left === 1 ? '' : 's'} left. The checklist shows what is working and what to do next.`);
      $('ss-card-continue').textContent = 'Continue setup';
    } else if (p.launch.newSteps && p.launch.newSteps.length) {
      cardNewSteps = p.launch.newSteps.map(s => s.id);
      const what = p.launch.newSteps.map(s => s.title.toLowerCase()).join(' and ');
      showCard(`New for your ${name}: ${what}. It takes a couple of minutes to set up.`);
      $('ss-card-continue').textContent = 'Set it up';
    }
  }
  setTimeout(launchCheck, 12000);

  window.openStationSetup = open;
})();
