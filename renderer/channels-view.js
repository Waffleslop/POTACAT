// Directory > Channels: the operator's saved frequency chart (lib/channels.js,
// renderer/channels.css). Casey 2026-10-30: "a saved frequency chart that
// users can edit and re-arrange as they feel fit, deleting things too."
// Seeded from data/channels.json (lists from KL4XQ and KC8DHX), then theirs:
// drag the grip to reorder, Edit, Delete, Add, import a CHIRP CSV, export one.
// A click tunes; where the radio cannot reach the frequency the SDR plays it
// (main.js listenSdrArbitrate), shown by the SDR tag.
//
// Loaded by index.html after lib/channels.js; app.js calls init() once, then
// render(search) for the tab, setList() from directory pushes, setReach()
// when the radio's or the SDR's reach changes.
(function () {
  'use strict';
  const C = window.Channels;
  let api = null;
  let tuneFn = null;
  let radioKhzFn = () => null;
  let saved = { v: 1, list: [], removed: [], seeded: 0 };
  let reach = { rig: null, sdr: null };
  let editingId = null;
  let dragId = null;
  let lastSearch = '';
  let selectedId = null;

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function covers(r, khz) { return !!(window.ListenSource && window.ListenSource.covers(r, khz * 1000)); }
  function hearable(c) {
    const rig = covers(reach.rig, c.khz);
    const sdr = !rig && covers(reach.sdr, c.khz);
    return { ok: rig || sdr || (!reach.rig && !reach.sdr), viaSdr: sdr };
  }

  function status(text) {
    const s = el('chn-status');
    if (!s) return;
    s.textContent = text || '';
    if (text) setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 6000);
  }

  function persist() {
    if (!api || !api.channelsSave) return Promise.resolve(saved);
    return api.channelsSave(saved).then((s) => { if (s && Array.isArray(s.list)) saved = s; render(lastSearch); return saved; }).catch(() => saved);
  }

  function isTuned(c) {
    const k = radioKhzFn();
    return k != null && Math.abs(Number(c.khz) - Number(k)) < 0.5;
  }

  function tune(c) {
    if (!tuneFn) return;
    selectedId = c.id;
    tuneFn(String(c.khz), C.tuneMode(c.mode));
  }

  // ── Table ────────────────────────────────────────────────────────────────
  function groupsOf(list) {
    const seen = [];
    for (const c of list) { const g = c.group || 'Other'; if (seen.indexOf(g) < 0) seen.push(g); }
    return seen;
  }

  function fillGroupFilter(groups) {
    const sel = el('chn-group-filter');
    if (!sel) return;
    const cur = sel.value || 'all';
    sel.innerHTML = '<option value="all">All groups</option>' + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    sel.value = groups.indexOf(cur) >= 0 ? cur : 'all';
  }

  function render(search) {
    lastSearch = search || '';
    const body = el('chn-body');
    if (!body || !C) return;
    const q = lastSearch.toLowerCase().trim();
    const groups = groupsOf(saved.list);
    fillGroupFilter(groups);
    const gsel = el('chn-group-filter');
    const gfilter = gsel ? gsel.value : 'all';
    body.innerHTML = '';
    if (!saved.list.length) {
      body.innerHTML = '<tr><td colspan="8" class="chn-empty">No channels yet. Add one, import a CHIRP CSV, or restore the starter channels.</td></tr>';
      return;
    }
    let shown = 0, hidden = 0;
    for (const g of groups) {
      if (gfilter !== 'all' && g !== gfilter) continue;
      const rows = saved.list.filter((c) => (c.group || 'Other') === g && (!q || [c.name, c.note, c.group, c.mode, c.tone].some((v) => String(v || '').toLowerCase().includes(q)) || String(c.khz).includes(q) || (c.khz / 1000).toFixed(3).includes(q)));
      if (!rows.length) continue;
      const gr = document.createElement('tr');
      gr.className = 'chn-group';
      gr.innerHTML = `<td colspan="8">${esc(g)} <span class="chn-status">${rows.length}</span></td>`;
      body.appendChild(gr);
      for (const c of rows) {
        const h = hearable(c);
        if (!h.ok) hidden++;
        shown++;
        const tr = document.createElement('tr');
        tr.className = 'chn-row' + (isTuned(c) ? ' chn-tuned' : '') + (h.ok ? '' : ' chn-out') + (c.id === selectedId ? ' lmk-selected' : '');
        tr.draggable = true;
        tr.dataset.id = c.id;
        tr.tabIndex = 0;
        tr.title = h.ok ? (h.viaSdr ? 'Outside the radio’s range; POTACAT plays it through your SDR' : 'Click to tune') : 'Neither the radio nor an SDR you have set up can receive this';
        tr.innerHTML = `<td><span class="chn-grip" title="Drag to reorder">☰</span></td>`
          + `<td class="chn-name">${esc(c.name)}${h.viaSdr ? '<span class="chn-sdr">SDR</span>' : ''}</td>`
          + `<td class="chn-mhz">${(c.khz / 1000).toFixed(c.khz % 1 ? 5 : 4).replace(/0+$/, '').replace(/\.$/, '')}</td>`
          + `<td>${esc(c.mode)}</td>`
          + `<td>${esc(C.formatOffset(c.offsetKhz))}</td>`
          + `<td>${esc(c.tone)}</td>`
          + `<td class="chn-note" title="${esc(c.note)}">${esc(c.note)}</td>`
          + `<td class="chn-tools"><button type="button" class="chn-btn" data-act="edit">Edit</button> <button type="button" class="chn-btn chn-btn-danger" data-act="del">Delete</button></td>`;
        tr.addEventListener('click', (e) => {
          const act = e.target && e.target.dataset ? e.target.dataset.act : '';
          if (act === 'edit') { e.stopPropagation(); openEditor(c); return; }
          if (act === 'del') { e.stopPropagation(); saved = C.remove(saved, c.id); status(`Deleted ${c.name}`); persist(); return; }
          if (e.target && e.target.classList.contains('chn-grip')) return;
          tune(c);
          render(lastSearch);
        });
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tune(c); render(lastSearch); } });
        tr.addEventListener('dragstart', (e) => { dragId = c.id; tr.classList.add('chn-dragging'); try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* fine */ } });
        tr.addEventListener('dragend', () => { dragId = null; body.querySelectorAll('.chn-dragging, .chn-drop-before').forEach((x) => x.classList.remove('chn-dragging', 'chn-drop-before')); });
        tr.addEventListener('dragover', (e) => { if (!dragId || dragId === c.id) return; e.preventDefault(); body.querySelectorAll('.chn-drop-before').forEach((x) => x.classList.remove('chn-drop-before')); tr.classList.add('chn-drop-before'); });
        tr.addEventListener('drop', (e) => {
          e.preventDefault();
          if (!dragId || dragId === c.id) return;
          const target = saved.list.findIndex((x) => x.id === c.id);
          const from = saved.list.findIndex((x) => x.id === dragId);
          const moved = saved.list[from];
          saved = C.move(saved, dragId, target > from ? target - 1 : target);
          // Dropping into another group adopts it: the group is where the row sits.
          if (moved && moved.group !== c.group) saved = C.upsert(saved, { ...moved, group: c.group });
          dragId = null;
          persist();
        });
        body.appendChild(tr);
      }
    }
    if (!shown) {
      body.innerHTML = '<tr><td colspan="8" class="chn-empty">Nothing matches.</td></tr>';
    } else if (hidden) {
      const tr = document.createElement('tr');
      tr.className = 'chn-hidden-note';
      tr.innerHTML = `<td colspan="8">${hidden} channel${hidden === 1 ? ' is' : 's are'} greyed because neither this radio nor an SDR you have set up can receive ${hidden === 1 ? 'it' : 'them'}. An RTL-SDR on the network (Settings &gt; Station &gt; WebSDR) hears all of these.</td>`;
      body.appendChild(tr);
    }
  }

  // ── Editor ───────────────────────────────────────────────────────────────
  function openEditor(c) {
    const box = el('chn-editor');
    if (!box) return;
    editingId = c ? c.id : null;
    const v = c || { name: '', khz: '', mode: 'FM', offsetKhz: 0, tone: '', group: '', note: '' };
    const groups = groupsOf(saved.list);
    box.innerHTML = `
      <label>Name <input id="chn-f-name" maxlength="40" value="${esc(v.name)}" placeholder="Local repeater"></label>
      <label>MHz <input id="chn-f-mhz" inputmode="decimal" value="${v.khz ? esc((v.khz / 1000).toFixed(5).replace(/0+$/, '').replace(/\.$/, '')) : ''}" placeholder="146.520"></label>
      <label>Mode <select id="chn-f-mode">${C.MODES.map((m) => `<option${m === v.mode ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Offset kHz <input id="chn-f-off" inputmode="decimal" value="${esc(v.offsetKhz || '')}" placeholder="-600, +5000, blank = simplex"></label>
      <label>Tone <input id="chn-f-tone" maxlength="12" value="${esc(v.tone)}" placeholder="123.0 or D023"></label>
      <label>Group <input id="chn-f-group" maxlength="40" list="chn-groups" value="${esc(v.group)}" placeholder="Repeaters"><datalist id="chn-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <label class="chn-editor-note">Note <input id="chn-f-note" maxlength="300" value="${esc(v.note)}" placeholder="What it is, who is on it"></label>
      <div class="chn-editor-actions"><button type="button" id="chn-f-cancel" class="chn-btn">Cancel</button><button type="button" id="chn-f-save" class="chn-btn chn-btn-tint">${c ? 'Save' : 'Add'}</button></div>`;
    box.classList.remove('hidden');
    el('chn-f-cancel').addEventListener('click', closeEditor);
    el('chn-f-save').addEventListener('click', saveEditor);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); saveEditor(); } if (e.key === 'Escape') closeEditor(); });
    el('chn-f-name').focus();
  }
  function closeEditor() { const box = el('chn-editor'); if (box) { box.classList.add('hidden'); box.innerHTML = ''; } editingId = null; }
  function saveEditor() {
    const mhz = parseFloat(String(el('chn-f-mhz').value).replace(',', '.'));
    if (!(mhz > 0)) { el('chn-f-mhz').focus(); status('A frequency in MHz is needed'); return; }
    const offRaw = String(el('chn-f-off').value).trim().replace(',', '.');
    const existing = editingId ? saved.list.find((x) => x.id === editingId) : null;
    const c = {
      id: editingId || C.newId(),
      name: el('chn-f-name').value, khz: Math.round(mhz * 1e6) / 1000, mode: el('chn-f-mode').value,
      offsetKhz: offRaw ? parseFloat(offRaw) : 0, tone: el('chn-f-tone').value, group: el('chn-f-group').value || (existing && existing.group) || 'My channels',
      note: el('chn-f-note').value, src: existing ? existing.src : 'user',
    };
    saved = C.upsert(saved, c);
    closeEditor();
    status(existing ? `Saved ${c.name}` : `Added ${c.name}`);
    persist();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function init(opts) {
    api = opts.api;
    tuneFn = opts.tune;
    radioKhzFn = opts.radioKhz || radioKhzFn;
    const on = (id, fn) => { const b = el(id); if (b) b.addEventListener('click', fn); };
    on('chn-add', () => openEditor(null));
    on('chn-import', async () => {
      if (!api.channelsImportCsv) return;
      status('Choose a CHIRP CSV file...');
      const r = await api.channelsImportCsv();
      if (!r || r.canceled) { status(''); return; }
      if (r.error) { status(r.error); return; }
      status(`Imported ${r.added} channel${r.added === 1 ? '' : 's'} into "${r.group}"${r.dupes ? `, ${r.dupes} already here` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`);
      load();
    });
    on('chn-export', async () => {
      if (!api.channelsExportCsv) return;
      const r = await api.channelsExportCsv();
      if (!r || r.canceled) return;
      status(r.error ? r.error : `Exported ${r.count} channels as a CHIRP CSV`);
    });
    on('chn-restore', () => { if (!api.channelsGet) return; saved.removed = []; saved.seeded = 0; persist().then(() => status('Starter channels restored')); });
    const gsel = el('chn-group-filter');
    if (gsel) gsel.addEventListener('change', () => render(lastSearch));
    load();
  }
  function load() {
    if (!api || !api.channelsGet) return;
    api.channelsGet().then((s) => { if (s && Array.isArray(s.list)) { saved = s; render(lastSearch); } }).catch(() => {});
  }
  function setList(list) {
    if (!Array.isArray(list)) return;
    saved = { ...saved, list: C.sanitizeList(list) };
    render(lastSearch);
  }
  function setReach(r) {
    reach = { rig: r && r.rig ? r.rig : null, sdr: r && r.sdr ? r.sdr : null };
    render(lastSearch);
  }
  function refresh() { render(lastSearch); }

  window.ChannelsView = { init, render, load, setList, setReach, refresh, openEditor };
})();
