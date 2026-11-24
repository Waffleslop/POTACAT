'use strict';
// Contact details window. Main builds everything it shows (lib/contact-card.js)
// and sends it as one view model; this page draws it, keeps the station's
// clock ticking, copies the mailing address to the clipboard and opens the
// QRZ page. It never writes the log.

(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api || {};
  if (api.platform) document.body.classList.add('platform-' + api.platform);
  const SVG = 'http://www.w3.org/2000/svg';

  let vm = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function kv(label, value, first) {
    const d = el('div', 'cd-kv' + (first ? ' first' : ''));
    d.appendChild(el('span', 'cd-muted', label));
    d.appendChild(el('span', 'v', value));
    return d;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function stationClock(offsetMinutes) {
    return new Date(Date.now() + offsetMinutes * 60000).toISOString().slice(11, 16);
  }

  function compass(deg) {
    const s = svgEl('svg', { width: 76, height: 76, viewBox: '0 0 76 76', role: 'img', 'aria-label': 'Short path bearing ' + deg + ' degrees' });
    s.appendChild(svgEl('circle', { class: 'ring', cx: 38, cy: 38, r: 34, fill: 'none', 'stroke-width': 2 }));
    const n = svgEl('text', { x: 38, y: 15, 'font-size': 10, 'text-anchor': 'middle' });
    n.textContent = 'N';
    s.appendChild(n);
    const a = deg * Math.PI / 180;
    s.appendChild(svgEl('line', { x1: 38, y1: 38, x2: (38 + 30 * Math.sin(a)).toFixed(1), y2: (38 - 30 * Math.cos(a)).toFixed(1), 'stroke-width': 3, 'stroke-linecap': 'round' }));
    s.appendChild(svgEl('circle', { class: 'hub', cx: 38, cy: 38, r: 3 }));
    return s;
  }

  function drawHeader() {
    $('cd-head').hidden = false;
    $('cd-call').textContent = vm.call;
    const pill = $('cd-pill');
    pill.hidden = !vm.statusLabel;
    pill.textContent = vm.statusLabel;
    pill.className = 'cd-pill ' + vm.status;
    $('cd-headline').textContent = vm.headline;
    $('cd-qrz').hidden = !vm.qrzUrl;
  }

  function drawOperator() {
    const o = vm.operator;
    const box = $('cd-photo');
    box.textContent = '';
    box.classList.toggle('none', !o.photo);
    if (o.photo) {
      const img = el('img');
      img.alt = 'Photo of ' + vm.call + ' from QRZ.com';
      img.addEventListener('error', () => { box.textContent = 'No photo'; box.classList.add('none'); });
      img.src = o.photo;
      box.appendChild(img);
    } else {
      box.textContent = 'No photo';
    }
    $('cd-name').textContent = o.name;
    $('cd-name').hidden = !o.name;
    $('cd-town').textContent = o.town;
    $('cd-town').hidden = !o.town;
    const pills = $('cd-pills');
    pills.textContent = '';
    for (const p of o.pills) pills.appendChild(el('span', 'cd-chip' + (p.kind === 'grid' ? ' grid' : ''), p.text));
    pills.hidden = !o.pills.length;
    const notes = $('cd-notes');
    notes.textContent = '';
    for (const n of o.notes) notes.appendChild(el('div', 'cd-small', n));
    if (o.note) notes.appendChild(el('div', 'cd-small', o.note));
  }

  function drawPath() {
    const box = $('cd-path');
    box.textContent = '';
    box.style.cssText = 'display:flex;flex-direction:column;gap:12px;flex-grow:1;';
    const p = vm.path;
    if (!p) {
      box.appendChild(el('span', 'cd-small', 'Set your grid square in Settings > Station to see the beam heading and distance.'));
      return;
    }
    const top = el('div', 'cd-compass');
    top.appendChild(compass(p.shortDeg));
    const t = el('div');
    t.style.cssText = 'display:flex;flex-direction:column;';
    t.appendChild(el('span', 'cd-big', p.shortPath));
    t.appendChild(el('span', 'cd-small', 'short path'));
    top.appendChild(t);
    box.appendChild(top);
    box.appendChild(el('span', 'cd-fill'));
    box.appendChild(kv('Long path', p.longPath, true));
    box.appendChild(kv('Distance', p.distance));
  }

  function drawEnd() {
    const box = $('cd-end');
    box.textContent = '';
    if (vm.time) {
      const d = el('div');
      d.style.cssText = 'display:flex;flex-direction:column;';
      const big = el('span', 'cd-big', stationClock(vm.time.offsetMinutes));
      big.id = 'cd-clock';
      d.appendChild(big);
      d.appendChild(el('span', 'cd-small', vm.time.sub));
      box.appendChild(d);
    } else {
      box.appendChild(el('span', 'cd-small', 'Their local time is not known.'));
    }
    box.appendChild(el('span', 'cd-fill'));
    if (vm.weather) {
      box.appendChild(kv('Weather', vm.weather.text, true));
      const src = el('span', 'cd-small', vm.weather.source + '. ');
      const off = el('button', 'cd-linkbtn', 'Turn off');
      off.type = 'button';
      off.title = 'Stop asking Open-Meteo for the weather (also in Settings > Station)';
      off.addEventListener('click', () => api.setWeather && api.setWeather(false));
      src.appendChild(off);
      box.appendChild(src);
    } else if (vm.weatherPending) {
      box.appendChild(kv('Weather', '...', true));
      box.appendChild(el('span', 'cd-small', 'Asking Open-Meteo'));
    } else if (!vm.weatherOn && (vm.path || vm.time)) {
      const s = el('span', 'cd-small', 'Weather is off. ');
      const on = el('button', 'cd-linkbtn', 'Turn on');
      on.type = 'button';
      on.title = 'Asks Open-Meteo (open-meteo.com) for the weather in this station\'s grid square. No callsign is sent.';
      on.addEventListener('click', () => api.setWeather && api.setWeather(true));
      s.appendChild(on);
      box.appendChild(s);
    }
  }

  function drawStation() {
    const f = $('cd-fields');
    f.textContent = '';
    for (const r of vm.station) {
      const c = el('div', 'cd-field');
      c.appendChild(el('span', 'l', r.label));
      c.appendChild(el('span', 'v', r.value));
      f.appendChild(c);
    }
    $('cd-station-note').textContent = vm.stationNote;
    $('cd-station-note').hidden = !vm.stationNote;
  }

  function drawQsl() {
    const q = vm.qsl;
    $('cd-qsl-card').classList.toggle('cd-dashed', !q.available);
    $('cd-via').hidden = !q.via;
    $('cd-via-v').textContent = q.via;
    const a = $('cd-address');
    a.hidden = !q.address;
    a.textContent = q.address ? q.address.lines.join('\n') : '';
    $('cd-email').hidden = !q.email;
    $('cd-email').textContent = q.email;
    $('cd-qsl-note').hidden = !q.note;
    $('cd-qsl-note').textContent = q.note;
    const b = $('cd-copy');
    b.disabled = !q.address;
    b.textContent = 'Copy mailing address';
    b.classList.remove('done');
  }

  function drawContacts() {
    $('cd-contacts-h').textContent = 'Your contacts with ' + vm.call;
    const t = $('cd-contacts');
    t.textContent = '';
    if (!vm.contacts.length) {
      t.style.display = 'block';
      t.appendChild(el('span', 'cd-small', 'None in your log yet.'));
      return;
    }
    t.style.display = '';
    for (const h of ['Date (UTC)', 'Band', 'Mode', 'Sent / Rcvd', 'Park', 'Status']) t.appendChild(el('span', 'th', h));
    for (const c of vm.contacts) {
      const cls = c.current ? 'current' : '';
      t.appendChild(el('span', cls, c.when || '—'));
      t.appendChild(el('span', cls, c.band || '—'));
      t.appendChild(el('span', cls, c.mode || '—'));
      t.appendChild(el('span', cls, c.rst));
      t.appendChild(el('span', (c.park !== '—' ? 'cd-ok ' : '') + cls, c.park));
      t.appendChild(el('span', (c.status === 'Confirmed' ? 'cd-ok ' : 'cd-worked ') + cls, c.status));
    }
  }

  function draw(data) {
    vm = data;
    $('cd-loading').hidden = true;
    $('cd-grid').hidden = false;
    document.title = vm.call + ' - Contact details';
    drawHeader();
    drawOperator();
    drawPath();
    drawEnd();
    drawStation();
    drawQsl();
    drawContacts();
    $('cd-foot').textContent = vm.source;
  }

  $('cd-copy').addEventListener('click', async () => {
    if (!vm || !vm.qsl.address || !api.copyText) return;
    const r = await api.copyText(vm.qsl.address.copy); // the clipboard only: nothing goes into the log
    if (r && r.ok) { $('cd-copy').textContent = 'Copied'; $('cd-copy').classList.add('done'); }
  });
  $('cd-qrz').addEventListener('click', () => { if (vm && vm.qrzUrl && api.openExternal) api.openExternal(vm.qrzUrl); });
  $('cd-refresh').addEventListener('click', () => api.refresh && api.refresh());
  $('tb-min').addEventListener('click', () => api.minimize && api.minimize());
  $('tb-close').addEventListener('click', () => api.close && api.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && api.close) api.close(); });

  if (api.onLoading) api.onLoading((call) => {
    if (vm && vm.call === call) return; // a refresh of the same station keeps it on screen
    vm = null;
    $('cd-grid').hidden = true;
    $('cd-head').hidden = true;
    $('cd-foot').textContent = '';
    $('cd-loading').hidden = false;
    $('cd-loading').textContent = 'Looking up ' + call + '...';
  });
  if (api.onShow) api.onShow(draw);

  const clock = setInterval(() => {
    const c = $('cd-clock');
    if (c && vm && vm.time) c.textContent = stationClock(vm.time.offsetMinutes);
  }, 15000);
  window.addEventListener('beforeunload', () => clearInterval(clock));
  // For the theme check in a scratch window (no main process): draw a given model.
  window.__drawContactCard = draw;
})();
