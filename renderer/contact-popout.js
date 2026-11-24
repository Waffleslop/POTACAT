'use strict';
// Contact details window. Main builds everything it shows (lib/contact-card.js)
// and sends it as one view model; this page only draws it, keeps the station's
// clock ticking, copies the address and opens the QRZ page. It never logs.

(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api || {};
  if (api.platform) document.body.classList.add('platform-' + api.platform);

  let vm = null;
  let clockTimer = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function tile(label, value, sub) {
    const t = el('div', 'cd-tile');
    t.appendChild(el('div', 'l', label));
    const v = el('div', 'v', value);
    t.appendChild(v);
    if (sub) t.appendChild(el('div', 's', sub));
    return t;
  }

  function stationClock(offsetMinutes) {
    return new Date(Date.now() + offsetMinutes * 60000).toISOString().slice(11, 16);
  }

  function drawGlance() {
    const g = $('cd-glance');
    g.textContent = '';
    if (!vm) return;
    if (vm.time) {
      const t = tile('Local time', (vm.time.approx ? 'about ' : '') + stationClock(vm.time.offsetMinutes), vm.time.utc);
      t.id = 'cd-clock';
      g.appendChild(t);
    }
    if (vm.weather) {
      const t = tile('Weather', vm.weather.text, '');
      const s = el('div', 's', 'Open-Meteo ');
      const off = el('button', 'cd-link cd-weather-stop', 'Turn off');
      off.type = 'button';
      off.addEventListener('click', () => api.setWeather && api.setWeather(false));
      s.appendChild(off);
      t.appendChild(s);
      g.appendChild(t);
    } else if (vm.weatherPending) {
      g.appendChild(tile('Weather', '...', 'Asking Open-Meteo'));
    }
    if (vm.path) {
      g.appendChild(tile('Beam, short path', vm.path.shortPath, vm.path.distance));
      g.appendChild(tile('Beam, long path', vm.path.longPath, vm.path.longDistance));
    }
    g.hidden = !g.children.length;
    if (vm.path && vm.path.approx) {
      const n = el('div', 'cd-sub', 'Beam and distance to ' + vm.path.from + ', approximate.');
      n.style.gridColumn = '1 / -1';
      g.appendChild(n);
    }
  }

  function tickClock() {
    const t = $('cd-clock');
    if (!t || !vm || !vm.time) return;
    const v = t.querySelector('.v');
    if (v) v.textContent = (vm.time.approx ? 'about ' : '') + stationClock(vm.time.offsetMinutes);
  }

  function facts(dl, rows) {
    dl.textContent = '';
    for (const r of rows) {
      dl.appendChild(el('dt', null, r.label));
      dl.appendChild(el('dd', null, r.value));
    }
    return rows.length > 0;
  }

  function draw(data) {
    vm = data;
    $('cd-loading').hidden = true;
    $('cd-card').hidden = false;
    document.title = vm.call + ' - Contact details';

    const photo = $('cd-photo');
    if (vm.photo) {
      photo.hidden = false;
      photo.alt = 'Photo of ' + vm.call + ' from QRZ.com';
      if (photo.getAttribute('src') !== vm.photo) photo.src = vm.photo;
    } else {
      photo.hidden = true;
      photo.removeAttribute('src');
    }

    $('cd-call').textContent = vm.call;
    $('cd-name').textContent = vm.name || '';
    $('cd-name').hidden = !vm.name;
    const sub = [vm.nickname ? '"' + vm.nickname + '"' : '', vm.licence].filter(Boolean).join(', ');
    $('cd-sub').textContent = sub;
    $('cd-sub').hidden = !sub;
    const w = $('cd-worked');
    w.textContent = vm.header.text;
    w.classList.toggle('confirmed', !!vm.header.confirmed);
    w.classList.toggle('never', !vm.header.count);

    drawGlance();

    const addr = $('cd-address');
    addr.textContent = '';
    if (vm.address) {
      vm.address.lines.forEach((line) => addr.appendChild(el('div', null, line)));
      const b = $('cd-copy-address');
      b.textContent = 'Copy address';
      b.classList.remove('done');
    }
    $('cd-address-section').hidden = !vm.address;

    const rows = vm.facts.slice();
    if (vm.email) rows.push({ key: 'email', label: 'E-mail', value: vm.email });
    const hasFacts = facts($('cd-facts'), rows);
    const links = $('cd-links');
    links.textContent = '';
    for (const l of vm.links || []) {
      const a = el('button', 'cd-link', l.label);
      a.type = 'button';
      a.title = l.url;
      a.addEventListener('click', () => api.openExternal && api.openExternal(l.url));
      links.appendChild(a);
    }
    $('cd-facts-section').hidden = !hasFacts && !links.children.length;

    const thisRows = [];
    if (vm.thisContact) thisRows.push({ label: 'Logged', value: vm.thisContact });
    if (vm.notes) thisRows.push({ label: 'Notes', value: vm.notes });
    $('cd-this-section').hidden = !facts($('cd-this'), thisRows);

    $('cd-weather-off').hidden = !!vm.weatherOn || (!vm.path && !vm.time); // nowhere to ask about
    const note = $('cd-note');
    note.textContent = vm.qrzNote || '';
    note.hidden = !vm.qrzNote;
  }

  $('cd-photo').addEventListener('error', () => { $('cd-photo').hidden = true; });
  $('cd-copy-address').addEventListener('click', async () => {
    if (!vm || !vm.address || !api.copyText) return;
    const r = await api.copyText(vm.address.copy);
    const b = $('cd-copy-address');
    if (r && r.ok) { b.textContent = 'Copied'; b.classList.add('done'); }
  });
  $('cd-weather-on').addEventListener('click', () => api.setWeather && api.setWeather(true));
  $('tb-min').addEventListener('click', () => api.minimize && api.minimize());
  $('tb-close').addEventListener('click', () => api.close && api.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && api.close) api.close(); });

  if (api.onLoading) api.onLoading((call) => {
    if (vm && vm.call === call) return; // a refresh of the same station keeps it on screen
    vm = null;
    $('cd-card').hidden = true;
    $('cd-loading').hidden = false;
    $('cd-loading').textContent = 'Looking up ' + call + '...';
  });
  if (api.onShow) api.onShow(draw);

  clockTimer = setInterval(tickClock, 15000);
  window.addEventListener('beforeunload', () => clearInterval(clockTimer));
  // For the theme check in a scratch window (no main process): draw a given model.
  window.__drawContactCard = draw;
})();
