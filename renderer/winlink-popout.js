// Winlink mail window. No Node here: main owns Pat, the radio and the
// mailbox cache (lib/winlink-state.js) and pushes ONE state payload that every
// surface — this window, ECHOCAT Web, the phone — renders the same way.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var state = null;              // last winlink-state payload
  var lists = { in: [], out: [], sent: [], archive: [] };
  var box = 'in';
  var openMid = null;
  var pendingFiles = [];         // [{name,size,dataBase64}]
  var gateways = [];
  var noticeThen = null;         // what to do after the notice is accepted

  $('wl-min').addEventListener('click', function () { window.api.minimize(); });
  $('wl-max').addEventListener('click', function () { window.api.maximize(); });
  $('wl-close').addEventListener('click', function () { window.api.close(); });
  if (window.api.onPopoutTheme) window.api.onPopoutTheme(function (t) {
    document.documentElement.classList.toggle('light', t && t.theme === 'light');
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtDate(d) {
    var t = new Date(d);
    if (isNaN(t.getTime())) return '';
    var now = new Date();
    var sameDay = t.toDateString() === now.toDateString();
    return sameDay ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function fmtSize(n) { return n >= 1024 ? (n / 1024).toFixed(n >= 10240 ? 0 : 1) + ' kB' : n + ' B'; }

  // ── state ────────────────────────────────────────────────────────────────
  var STATE_WORDS = { idle: '', starting: 'Starting', connecting: 'Connecting', connected: 'Connected', disconnecting: 'Stopping', done: 'Finished', error: 'Failed' };
  function renderState() {
    var s = state || {};
    $('wl-mycall').textContent = s.mycall || '—';
    var off = !s.enabled ? 'Winlink is off. Turn it on in Settings > Station > Winlink.'
      : !s.patReady ? ('Starting Pat…' + (s.patError ? '<br><span style="color:#e94560">' + esc(s.patError) + '</span>' : ''))
      : '';
    $('wl-off').innerHTML = off ? off + '<br><br><button class="wl-btn" id="wl-off-settings">Open Settings</button>' : '';
    $('wl-off').style.display = off ? '' : 'none';
    $('wl-main').style.display = off ? 'none' : '';
    var os = $('wl-off-settings'); if (os) os.addEventListener('click', function () { window.api.openSettings(); });

    // Modes
    var modeSel = $('wl-mode');
    var modes = s.modes || [];
    var cur = modeSel.value || s.mode || 'telnet';
    modeSel.innerHTML = modes.map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (m.available ? '' : ' disabled') + ' title="' + esc(m.reason) + '">' + esc(m.label) + (m.available ? '' : ' — unavailable') + '</option>';
    }).join('');
    var avail = modes.filter(function (m) { return m.available; }).map(function (m) { return m.id; });
    modeSel.value = avail.indexOf(cur) >= 0 ? cur : (avail.indexOf(s.mode) >= 0 ? s.mode : 'telnet');
    renderModeNote();

    // Counts
    var c = s.counts || {};
    ['in', 'out', 'sent', 'archive'].forEach(function (b) {
      var el = $('wl-c-' + b);
      var n = b === 'in' ? (s.unread || 0) : (c[b] || 0);
      el.textContent = n ? String(n) : '';
      el.classList.toggle('unread', b === 'in' && n > 0);
    });
    renderSession(s.session || {});
  }

  function currentMode() {
    var id = $('wl-mode').value;
    return ((state && state.modes) || []).find(function (m) { return m.id === id; }) || { id: 'telnet', available: true };
  }

  function renderModeNote() {
    var m = currentMode();
    var radio = m.id !== 'telnet';
    $('wl-radio-pick').style.display = radio ? 'inline-flex' : 'none';
    var note = '';
    if (m.id === 'mercury') note = 'Experimental: few gateways run Mercury yet.';
    if (m.id === 'vara') note = 'Start VARA HF first, with its PTT set to None.';
    if (m.id === 'telnet') {
      // Say WHY the radio modes are greyed — a tooltip on a disabled option
      // is invisible on most systems. One line per distinct reason.
      var seen = {};
      var reasons = ((state && state.modes) || []).filter(function (x) { return !x.available && x.reason && !seen[x.reason] && (seen[x.reason] = 1); })
        .map(function (x) { return x.reason; });
      if (reasons.length) note = 'Radio: ' + reasons.join(' · ');
    }
    $('wl-mode-note').textContent = note;
    if (radio && !gateways.length) loadGateways(false);
  }

  function renderSession(ss) {
    var st = ss.state || 'idle';
    var el = $('wl-state');
    el.className = 'wl-state ' + st;
    el.textContent = STATE_WORDS[st] || st;
    var active = ['starting', 'connecting', 'connected', 'disconnecting'].indexOf(st) >= 0;
    $('wl-connect').disabled = active || !(state && state.patReady);
    $('wl-abort').disabled = !active;
    $('wl-mode').disabled = active;
    var ptt = $('wl-ptt');
    ptt.textContent = active && ss.mode !== 'telnet' ? (ss.ptt ? 'TX' : 'RX') : '';
    ptt.classList.toggle('on', !!ss.ptt);
    $('wl-bar').style.width = (active && ss.total ? ss.pct : 0) + '%';
    var text = ss.error && st === 'error' ? ss.error : (ss.text || '');
    if (active && ss.subject) text = (ss.direction === 'receiving' ? 'Receiving ' : 'Sending ') + '"' + ss.subject + '" ' + (ss.total ? fmtSize(ss.bytes) + ' / ' + fmtSize(ss.total) : '');
    $('wl-text').textContent = text;
    $('wl-text').style.color = st === 'error' ? '#e94560' : st === 'done' ? 'var(--accent-green, #4ecca3)' : '';
    $('wl-text').style.fontWeight = (st === 'done' || st === 'error') ? '700' : '';
    $('wl-remaining').textContent = active && ss.remainingSec != null ? Math.floor(ss.remainingSec / 60) + ':' + String(ss.remainingSec % 60).padStart(2, '0') + ' left' : '';

    var p = ss.prompt;
    var pr = $('wl-prompt');
    pr.classList.toggle('show', !!p);
    if (p) {
      if (p.kind === 'busy-channel') {
        $('wl-prompt-text').textContent = 'The frequency is busy. Wait for it to clear, or give up?';
        $('wl-prompt-yes').textContent = 'Keep waiting';
        $('wl-prompt-no').textContent = 'Give up';
        $('wl-prompt-yes').onclick = function () { pr.classList.remove('show'); };
        $('wl-prompt-no').onclick = function () { window.api.answerPrompt(p.id, 'abort'); };
      } else {
        $('wl-prompt-text').textContent = p.message || 'Winlink asks for a decision';
        $('wl-prompt-yes').textContent = 'Accept';
        $('wl-prompt-no').textContent = 'Decline';
        $('wl-prompt-yes').onclick = function () { window.api.answerPrompt(p.id, 'accept'); };
        $('wl-prompt-no').onclick = function () { window.api.answerPrompt(p.id, 'decline'); };
      }
    }
  }

  // ── lists ────────────────────────────────────────────────────────────────
  function renderList() {
    var rows = lists[box] || [];
    if (!rows.length) { $('wl-list').innerHTML = '<div class="wl-empty">Nothing in ' + ({ in: 'the inbox', out: 'the outbox', sent: 'Sent', archive: 'the archive' })[box] + '.</div>'; return; }
    $('wl-list').innerHTML = rows.map(function (m) {
      var who = box === 'in' ? m.from : (m.to || []).join(', ');
      return '<div class="wl-row' + (m.read ? '' : ' unread') + (m.mid === openMid ? ' active' : '') + '" data-mid="' + esc(m.mid) + '">'
        + '<div class="wl-row-top"><span class="wl-from">' + esc(who) + '</span><span>' + esc(fmtDate(m.date)) + '</span></div>'
        + '<div class="wl-subj">' + (m.attachments && m.attachments.length ? '[' + m.attachments.length + ' att] ' : '') + esc(m.subject || '(no subject)') + '</div></div>';
    }).join('');
  }

  $('wl-list').addEventListener('click', function (e) {
    var row = e.target.closest('.wl-row');
    if (row) openMessage(row.getAttribute('data-mid'));
  });

  Array.prototype.forEach.call(document.querySelectorAll('.wl-folder'), function (f) {
    f.addEventListener('click', function () {
      box = f.getAttribute('data-box');
      Array.prototype.forEach.call(document.querySelectorAll('.wl-folder'), function (x) { x.classList.toggle('active', x === f); });
      openMid = null;
      showReader('<div class="wl-empty">Pick a message.</div>');
      renderList();
      window.api.list(box);
    });
  });

  function showReader(html) {
    $('wl-compose').classList.remove('show');
    $('wl-reader').style.display = '';
    $('wl-reader').innerHTML = html;
  }

  function openMessage(mid) {
    openMid = mid;
    renderList();
    showReader('<div class="wl-empty">Opening…</div>');
    window.api.read(box, mid).then(function (r) {
      if (openMid !== mid) return;
      if (!r || !r.ok) { showReader('<div class="wl-empty">' + esc((r && r.error) || 'Could not open it') + '</div>'); return; }
      var m = r.message;
      var html = '<div class="wl-reader-actions">'
        + (box === 'in' ? '<button class="wl-btn" id="wl-reply">Reply</button>' : '')
        + '<button class="wl-btn" id="wl-fwd">Forward</button>'
        + '<span class="wl-spacer"></span><button class="wl-btn danger" id="wl-del">Delete</button></div>'
        + '<div class="wl-hdr"><b>' + esc(m.subject || '(no subject)') + '</b><br>From <b>' + esc(m.from) + '</b> · ' + esc(new Date(m.date).toLocaleString()) + '<br>To ' + esc((m.to || []).join(', '))
        + (m.cc && m.cc.length ? '<br>Cc ' + esc(m.cc.join(', ')) : '') + '</div>'
        + '<div class="wl-body">' + esc(m.body || '') + '</div>'
        + (m.attachments && m.attachments.length ? '<div class="wl-attach">' + m.attachments.map(function (a) {
          return '<button class="wl-btn wl-att" data-name="' + esc(a.name) + '">Save ' + esc(a.name) + ' (' + fmtSize(a.size) + ')</button>';
        }).join('') + '</div>' : '');
      showReader(html);
      var rp = $('wl-reply'); if (rp) rp.onclick = function () { compose({ to: m.from, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, body: '\n\n--- ' + m.from + ' wrote:\n' + (m.body || '').split('\n').map(function (l) { return '> ' + l; }).join('\n') }); };
      $('wl-fwd').onclick = function () { compose({ subject: 'Fwd: ' + m.subject, body: '\n\n--- Forwarded from ' + m.from + ':\n' + (m.body || '') }); };
      $('wl-del').onclick = function () {
        window.api.del(box, mid).then(function (d) { if (d && d.ok) { openMid = null; showReader('<div class="wl-empty">Deleted.</div>'); } });
      };
      Array.prototype.forEach.call(document.querySelectorAll('.wl-att'), function (b) {
        b.onclick = function () { window.api.saveAttachment(box, mid, b.getAttribute('data-name')); };
      });
    });
  }

  // ── compose ──────────────────────────────────────────────────────────────
  function requireNotice(then) {
    if (state && state.noticeAccepted) { then(); return; }
    noticeThen = then;
    $('wl-notice-text').textContent = (state && state.noticeText) || '';
    $('wl-notice').classList.add('show');
  }
  $('wl-notice-ok').addEventListener('click', function () {
    window.api.acceptNotice().then(function () {
      $('wl-notice').classList.remove('show');
      if (state) state.noticeAccepted = true;
      var f = noticeThen; noticeThen = null; if (f) f();
    });
  });
  $('wl-notice-no').addEventListener('click', function () { $('wl-notice').classList.remove('show'); noticeThen = null; });

  function compose(pre) {
    requireNotice(function () {
      pre = pre || {};
      $('wl-reader').style.display = 'none';
      $('wl-compose').classList.add('show');
      $('wl-c-to').value = pre.to || '';
      $('wl-c-cc').value = '';
      $('wl-c-subj').value = pre.subject || '';
      $('wl-c-body').value = pre.body || '';
      pendingFiles = [];
      renderFiles();
      $('wl-c-err').textContent = '';
      (pre.to ? $('wl-c-body') : $('wl-c-to')).focus();
    });
  }
  function renderFiles() {
    var total = pendingFiles.reduce(function (n, f) { return n + f.size; }, 0);
    $('wl-c-files').textContent = pendingFiles.length ? pendingFiles.map(function (f) { return f.name; }).join(', ') + ' — ' + fmtSize(total) + (total > 100 * 1024 ? ' (large for HF: minutes per kB at ARDOP 500)' : '') : '';
  }
  $('wl-new').addEventListener('click', function () { compose({}); });
  $('wl-c-cancel').addEventListener('click', function () { showReader('<div class="wl-empty">Pick a message.</div>'); });
  $('wl-c-attach').addEventListener('click', function () {
    window.api.pickAttachments().then(function (r) {
      if (r && r.ok) { pendingFiles = pendingFiles.concat(r.files); renderFiles(); }
      else if (r && r.error) $('wl-c-err').textContent = r.error;
    });
  });
  $('wl-c-send').addEventListener('click', function () {
    $('wl-c-err').textContent = '';
    $('wl-c-send').disabled = true;
    window.api.send({ to: $('wl-c-to').value, cc: $('wl-c-cc').value, subject: $('wl-c-subj').value, body: $('wl-c-body').value, attachments: pendingFiles }).then(function (r) {
      $('wl-c-send').disabled = false;
      if (!r || !r.ok) { $('wl-c-err').textContent = (r && r.error) || 'Could not queue it'; return; }
      showReader('<div class="wl-empty">In the Outbox. It goes out on the next Send / Receive.</div>');
    });
  });
  $('wl-pos').addEventListener('click', function () {
    requireNotice(function () {
      window.api.posreport({}).then(function (r) {
        showReader('<div class="wl-empty">' + esc(r && r.ok ? 'Position report in the Outbox.' : ((r && r.error) || 'Could not queue it')) + '</div>');
      });
    });
  });
  $('wl-settings').addEventListener('click', function () { window.api.openSettings(); });

  // ── sessions ─────────────────────────────────────────────────────────────
  $('wl-mode').addEventListener('change', function () {
    gateways = [];
    $('wl-gateway').innerHTML = '<option value="">Load gateways…</option>';
    window.api.setMode($('wl-mode').value);
    renderModeNote();
  });
  $('wl-band').addEventListener('change', function () { loadGateways(false); });
  $('wl-gw-refresh').addEventListener('click', function () { loadGateways(true); });

  function loadGateways() {
    var m = currentMode();
    if (m.id === 'telnet' || !m.available) return;
    var sel = $('wl-gateway');
    sel.innerHTML = '<option value="">Loading gateways…</option>';
    window.api.gateways(m.id, $('wl-band').value).then(function (r) {
      if (!r || !r.ok) { sel.innerHTML = '<option value="">' + esc((r && r.error) || 'No list') + '</option>'; return; }
      gateways = r.list || [];
      if (!gateways.length) { sel.innerHTML = '<option value="">No gateways for that band</option>'; return; }
      var last = state && state.lastGateway;
      sel.innerHTML = gateways.slice(0, 120).map(function (g, i) {
        var label = g.call + '  ' + (g.dialKhz ? g.dialKhz.toFixed(1) + ' kHz' : '') + (g.distKm != null ? '  ' + g.distKm + ' km' : '') + (g.quality != null ? '  ' + g.quality + '%' : '') + (g.mercury ? '  (Mercury)' : '');
        var selAttr = last && last.call === g.call && last.dialKhz === g.dialKhz ? ' selected' : '';
        return '<option value="' + i + '"' + selAttr + '>' + esc(label) + '</option>';
      }).join('');
    });
  }

  $('wl-connect').addEventListener('click', function () {
    requireNotice(function () {
      var m = currentMode();
      var o = { mode: m.id };
      if (m.id !== 'telnet') {
        var g = gateways[parseInt($('wl-gateway').value, 10)];
        if (!g) { $('wl-text').textContent = 'Pick a gateway first'; return; }
        o.gateway = g.call; o.dialKhz = g.dialKhz;
      }
      window.api.connect(o).then(function (r) {
        if (r && !r.ok) { $('wl-text').textContent = r.error || 'Could not start'; $('wl-text').style.color = '#e94560'; }
      });
    });
  });
  $('wl-abort').addEventListener('click', function () { window.api.abort(); });

  // ── wiring ───────────────────────────────────────────────────────────────
  window.api.onState(function (s) { state = s; renderState(); });
  window.api.onSession(function (ss) { if (state) state.session = ss; renderSession(ss); });
  window.api.onMailbox(function (d) {
    if (!d || !lists.hasOwnProperty(d.box)) return;
    lists[d.box] = d.messages || [];
    if (d.box === box) renderList();
  });
  window.api.getState().then(function (s) { state = s; renderState(); });
})();
