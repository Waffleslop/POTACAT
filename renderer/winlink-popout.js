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
  // ── account: shown until the shack has a Winlink password ────────────────
  var acct = { checked: false, exists: null, busy: false };
  function acctRender(s) {
    var card = $('wl-acct-card');
    var need = !!(s && s.patReady && !s.hasPassword);
    card.classList.toggle('show', need);
    if (!need) { acct.checked = false; return; }
    if (!acct.checked && !acct.busy) acctCheck();
  }
  function acctCheck() {
    acct.busy = true;
    $('wl-acct-text').textContent = 'Checking whether your callsign has an account…';
    $('wl-acct-form').style.display = 'none';
    window.api.accountCheck().then(function (r) {
      acct.busy = false; acct.checked = true;
      $('wl-acct-form').style.display = 'inline-flex';
      $('wl-acct-retry').style.display = 'none';
      if (!r || !r.ok) {
        $('wl-acct-text').textContent = 'Could not reach Winlink to check: ' + ((r && r.error) || 'no answer');
        $('wl-acct-retry').style.display = '';
        $('wl-acct-go').style.display = 'none';
        $('wl-acct-email-row').style.display = 'none';
        return;
      }
      acct.exists = !!r.exists;
      $('wl-acct-go').style.display = '';
      if (r.exists) {
        $('wl-acct-text').textContent = r.callsign + ' already has a Winlink account. Enter its password.';
        $('wl-acct-go').textContent = 'Save password';
        $('wl-acct-email-row').style.display = 'none';
      } else {
        $('wl-acct-text').textContent = r.callsign + ' has no Winlink account yet. Create one here; winlink.org does not sign up new users on its website.';
        $('wl-acct-go').textContent = 'Create my Winlink account';
        $('wl-acct-email-row').style.display = '';
      }
    });
  }
  $('wl-acct-retry').addEventListener('click', acctCheck);
  // Winlink's password rule, a verbatim copy of lib/winlink-pat.js (pinned by test).
  var WINLINK_PASSWORD_RE = /^[A-Za-z0-9.!@#$%^&*()_]{6,12}$/;
  var WINLINK_PASSWORD_HINT = '6 to 12 characters: letters, numbers and . ! @ # $ % ^ & * ( ) _ (no dash, no space)';
  function winlinkPasswordProblem(pw) {
    var s = String(pw == null ? '' : pw);
    if (s.length < 6 || s.length > 12) return 'The Winlink password must be ' + WINLINK_PASSWORD_HINT;
    var bad = s.match(/[^A-Za-z0-9.!@#$%^&*()_]/);
    if (bad) return (bad[0] === ' ' ? 'A space' : '"' + bad[0] + '"') + ' is not allowed in a Winlink password. Allowed: letters, numbers and . ! @ # $ % ^ & * ( ) _';
    return '';
  }
  $('wl-acct-go').addEventListener('click', function () {
    var pw = $('wl-acct-pw').value;
    var pwProblem = winlinkPasswordProblem(pw);
    if (pwProblem) { $('wl-acct-text').textContent = pwProblem; return; }
    var btn = $('wl-acct-go'); btn.disabled = true;
    var done = function (r) {
      btn.disabled = false;
      if (r && r.ok) {
        $('wl-acct-pw').value = '';
        $('wl-acct-text').textContent = acct.exists ? 'Saved. Winlink restarts with it — try Send / Receive over the internet.' : 'Account created and saved. Send / Receive over the internet is your first login.';
      } else {
        $('wl-acct-text').textContent = (r && r.error) || 'That did not work.';
      }
    };
    if (acct.exists) window.api.setPassword(pw).then(done);
    else window.api.register({ password: pw, recoveryEmail: $('wl-acct-email').value.trim() }).then(done);
  });

  function renderState() {
    var s = state || {};
    $('wl-mycall').textContent = s.mycall || '—';
    var off = !s.enabled ? 'Winlink is off. Turn it on in Settings > Station > Winlink.'
      : !s.patReady ? ('Starting Pat…' + (s.patError ? '<br><span style="color:#e94560">' + esc(s.patError) + '</span>' : ''))
      : '';
    $('wl-off').innerHTML = off ? off + '<br><br><button class="wl-btn" id="wl-off-settings">Open Settings</button>' : '';
    $('wl-off').style.display = off ? '' : 'none';
    $('wl-main').style.display = off ? 'none' : '';
    acctRender(s);
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
    if (m.id === 'vara' || m.id === 'varafm') note = 'Your own ' + (m.id === 'varafm' ? 'VARA FM' : 'VARA HF') + ', with its PTT set to VOX — POTACAT starts it if needed and keys the radio.';
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
    // Audio levels (session.audio, pushed twice a second during a radio
    // session): what the modem hears from the radio — and how much POTACAT
    // trimmed it to keep VARA's input out of the red — and what it sends back.
    var au = ss.audio || null;
    var ael = $('wl-audio');
    if (active && au && ss.mode !== 'telnet') {
      var parts = [];
      if (au.toModemDb != null) parts.push('to modem ' + au.toModemDb + ' dB' + (au.trimDb ? ' (trimmed ' + Math.abs(au.trimDb) + ' dB)' : ''));
      else if (au.rxDb != null && au.rxDb > -90) parts.push('radio ' + au.rxDb + ' dB');
      if (au.fromModemDb != null && au.fromModemDb > -90) parts.push('from modem ' + au.fromModemDb + ' dB' + (au.boostDb ? ' (raised ' + au.boostDb + ' dB)' : ''));
      ael.textContent = parts.join(' · ');
      ael.classList.toggle('hot', !!au.hot);
    } else { ael.textContent = ''; ael.classList.remove('hot'); }
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
      // Delete asks first: the button becomes "Delete this message?" with a
      // Cancel beside it, and reverts by itself after a few seconds.
      var delBtn = $('wl-del');
      var delArmed = null;
      delBtn.onclick = function () {
        if (!delArmed) {
          delBtn.textContent = 'Delete this message?';
          var cancel = document.createElement('button');
          cancel.className = 'wl-btn'; cancel.textContent = 'Cancel'; cancel.id = 'wl-del-cancel';
          delBtn.parentNode.insertBefore(cancel, delBtn);
          var disarm = function () { if (!delArmed) return; clearTimeout(delArmed); delArmed = null; delBtn.textContent = 'Delete'; cancel.remove(); };
          cancel.onclick = disarm;
          delArmed = setTimeout(disarm, 5000);
          return;
        }
        clearTimeout(delArmed); delArmed = null;
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
      $('wl-c-err').textContent = pre.note || '';
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
  // POTA spot: a message to spot@pota.tdod.org, one line per park; the
  // operator reads and edits it before it goes in the Outbox.
  function composeSpot(t) {
    if (!t || !t.to) return;
    compose({ to: t.to, subject: t.subject, body: t.body, note: (t.missing && t.missing.length) ? 'Fill in ' + t.missing.join(', ') + ' before it goes out.' : 'Check the line, then Put in Outbox and Send / Receive. It posts a real POTA spot.' });
  }
  $('wl-pota-spot').addEventListener('click', function () { window.api.potaSpotTemplate({}).then(composeSpot); });
  if (window.api.onComposePrefill) window.api.onComposePrefill(composeSpot);

  // ── waterfall: is the gateway frequency in use? ──────────────────────────
  // 0–3000 Hz of the receiver's passband, from main's direct-audio frames
  // (Flex Direct / Icom Network) or, on a sound-device rig, the rig's own
  // input captured here. Shown while a radio mode is selected.
  var WF_BINS = 256;                       // 0..3000 Hz at 11.7 Hz
  var WF_N = 2048;                         // FFT window at 24 kHz (85 ms)
  var WF_HOP = 512;                        // a new line every 21 ms (~47/s) before averaging
  var wf = null, wfMode = 'none', wfAcc = new Float32Array(WF_N), wfAccLen = 0, wfRate = 24000;
  var wfSpeed = 60, wfShown = true, wfHidden = false;
  var wfRemote = false; // an ECHOCAT device is watching through the shack
  var wfAvg = new Float32Array(WF_BINS), wfAvgN = 0, wfLastLineMs = 0;
  // Busy: a signal in the modem's band that stands above the noise. The rule
  // is lib/winlink-spectrum.js (BusyDetector — the same one the shack runs
  // for ECHOCAT devices): a sustained signal enters, hysteresis and a 4 s
  // hold keep it, so the badge does not blink between frames.
  var busyDet = new WinlinkSpectrum.BusyDetector(0, 1, WF_BINS), busyLastRender = 0, wfMarkersKey = '';
  function busyUpdate(mags) {
    var now = performance.now();
    var v = busyDet.update(mags, now);
    if (!v.changed && now - busyLastRender < 500) return;
    busyLastRender = now;
    var el = $('wl-wf-busy');
    el.className = 'wl-busy ' + (v.busy ? 'busy' : 'clear');
    el.textContent = v.busy ? 'BUSY +' + v.peakDb + ' dB' : 'Clear';
    el.title = v.busy ? 'A signal in the modem’s band, ' + v.peakDb + ' dB over the noise — wait, or pick another gateway' : 'Nothing above the noise in the modem’s band';
  }
  var wfCtx = null, wfStream = null, wfAnalyser = null, wfTimer = null;
  var wfRe = new Float32Array(WF_N), wfIm = new Float32Array(WF_N), wfWin = null, wfMags = new Float32Array(WF_BINS);

  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1, ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (var s = 0; s < n; s += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < half; k++) {
          var a = s + k, b = a + half;
          var tr = cr * re[b] - ci * im[b], ti = cr * im[b] + ci * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  function wfPush(samples, rate) {
    // Resample to 24 kHz by simple decimation/duplication so the bin→Hz map is fixed.
    var step = rate / 24000;
    for (var i = 0; i < samples.length; i += step) {
      wfAcc[wfAccLen++] = samples[i | 0];
      if (wfAccLen >= WF_N) {
        wfFrame();
        // Keep the last WF_N - WF_HOP samples: the next window overlaps this one.
        wfAcc.copyWithin(0, WF_HOP, WF_N);
        wfAccLen = WF_N - WF_HOP;
      }
    }
  }
  // Speed as the JTCAT pop-out's: lines between drawn lines are AVERAGED,
  // not dropped, so slowing down integrates weak signals. 60 = every line.
  function wfFrame() {
    if (!wf && !wfRemote) return;
    if (!wfWin) { wfWin = new Float32Array(WF_N); for (var w = 0; w < WF_N; w++) wfWin[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / (WF_N - 1)); }
    for (var i = 0; i < WF_N; i++) { wfRe[i] = wfAcc[i] * wfWin[i]; wfIm[i] = 0; }
    fft(wfRe, wfIm);
    for (var b = 0; b < WF_BINS; b++) wfMags[b] = Math.log(wfRe[b] * wfRe[b] + wfIm[b] * wfIm[b] + 1e-12);
    busyUpdate(wfMags); // on every line, before any averaging
    if (wfRemote && wfMode === 'capture') window.api.spectrumMags(Array.from(wfMags));
    if (!wf || !$('wl-wf').classList.contains('show')) return;
    if (wfSpeed >= 60) { wf.pushFrame(wfMags); return; }
    for (var k = 0; k < WF_BINS; k++) wfAvg[k] += wfMags[k];
    wfAvgN++;
    var now = performance.now();
    if (now - wfLastLineMs >= 1000 / wfSpeed) {
      for (var m = 0; m < WF_BINS; m++) { wfMags[m] = wfAvg[m] / wfAvgN; wfAvg[m] = 0; }
      wfAvgN = 0;
      wfLastLineMs = now;
      wf.pushFrame(wfMags);
    }
  }
  function wfApplyPrefs() {
    var p = (state && state.wf) || {};
    if (typeof p.speed === 'number') { wfSpeed = p.speed; $('wl-wf-speed').value = String(wfSpeed); $('wl-wf-speed-val').textContent = String(wfSpeed); }
    if (typeof p.shown === 'boolean') wfShown = p.shown;
  }
  $('wl-wf-speed').addEventListener('input', function () {
    wfSpeed = Math.max(1, Math.min(60, parseInt($('wl-wf-speed').value, 10) || 60));
    $('wl-wf-speed-val').textContent = String(wfSpeed);
    wfAvgN = 0; wfLastLineMs = 0;
    window.api.setPref('winlinkWaterfallSpeed', wfSpeed);
  });
  $('wl-wf-hide').addEventListener('click', function () { wfShown = false; window.api.setPref('winlinkWaterfallShown', false); wfSync(); });
  $('wl-wf-show-btn').addEventListener('click', function () { wfShown = true; window.api.setPref('winlinkWaterfallShown', true); wfSync(); });
  function wfMarkers(mode) {
    if (!wf) return;
    // The modem's band and its label come from the shared rule, with each
    // modem's own bandwidth from Settings (state.modemBw).
    var band = WinlinkSpectrum.markerBand(mode, (state && state.modemBw) || { ardop: state && state.ardopBw });
    var lo = band.lo, hi = band.hi;
    // Every state push (the audio meter, twice a second) comes through here:
    // only a CHANGED band resets the detector and the badge, or the badge
    // blinks "Clear" / "—" for as long as the window is open (K3SBP 2026-10-23).
    var key = lo + '|' + hi + '|' + band.label;
    if (key === wfMarkersKey) return;
    wfMarkersKey = key;
    busyDet.setBand(lo, hi); $('wl-wf-busy').className = 'wl-busy'; $('wl-wf-busy').textContent = '—';
    wf.setMarkers([{ pos: lo, color: [0.3, 0.8, 0.6, 0.8] }, { pos: hi, color: [0.3, 0.8, 0.6, 0.8] }]);
    $('wl-wf-note').textContent = band.label;
  }
  function wfStart(mode) {
    var a = (state && state.audio) || {};
    $('wl-wf-show').classList.toggle('show', !wfShown);
    // Hidden here but a phone is watching on a sound-device rig: keep capturing
    // (the shack has no other copy of this radio's audio) and relay the
    // magnitudes to main; nothing is drawn.
    var relayOnly = !wfShown && wfRemote && !a.viaPotacat;
    if (!wfShown && !relayOnly) { wfStop(true); return; }
    if (relayOnly) {
      $('wl-wf').classList.remove('show');
    } else {
      if (!wf) {
        try { wf = new Waterfall($('wl-wf-canvas'), { bins: WF_BINS, historyRows: 256, gamma: 0.6, crop: true }); } catch (e) { wf = null; }
        if (!wf || !wf.supported) { $('wl-wf').classList.remove('show'); return; }
      }
      $('wl-wf').classList.add('show');
      wfMarkers(mode);
    }
    if (a.viaPotacat) {
      // Frames from main (the same ones the modem gets).
      if (wfMode !== 'frames') { wfStopCapture(); wfMode = 'frames'; window.api.watchAudio(true); }
      return;
    }
    // A sound-device rig: capture its input here (the rig's FT8 input device).
    if (wfMode === 'capture') return;
    wfMode = 'capture';
    window.api.watchAudio(false);
    window.api.audioRig().then(function (rig) {
      var c = { audio: rig && rig.ok && rig.inputId ? { deviceId: { exact: rig.inputId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
      return navigator.mediaDevices.getUserMedia(c);
    }).then(function (stream) {
      if (wfMode !== 'capture') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      wfStream = stream;
      wfCtx = new AudioContext({ sampleRate: 48000 });
      var src = wfCtx.createMediaStreamSource(stream);
      wfAnalyser = wfCtx.createAnalyser();
      wfAnalyser.fftSize = 4096;
      src.connect(wfAnalyser);
      var buf = new Float32Array(4096);
      wfTimer = setInterval(function () {
        if (!wfAnalyser) return;
        wfAnalyser.getFloatTimeDomainData(buf);
        wfAccLen = 0; wfPush(buf, wfCtx.sampleRate);
      }, 90);
    }).catch(function (e) { $('wl-wf-note').textContent = 'No radio audio: ' + (e && e.message || e); });
  }
  function wfStopCapture() {
    if (wfTimer) { clearInterval(wfTimer); wfTimer = null; }
    if (wfStream) { wfStream.getTracks().forEach(function (t) { t.stop(); }); wfStream = null; }
    if (wfCtx) { try { wfCtx.close(); } catch (e) {} wfCtx = null; }
    wfAnalyser = null;
  }
  function wfStop(keepShowButton) {
    wfStopCapture();
    if (wfMode === 'frames') window.api.watchAudio(false);
    wfMode = 'none';
    $('wl-wf').classList.remove('show');
    if (!keepShowButton) $('wl-wf-show').classList.remove('show');
  }
  window.api.onRemoteWatch(function (on) { wfRemote = on; wfSync(); });
  window.api.onAudioFrame(function (d) {
    if (wfMode !== 'frames' || !d || !d.pcm) return;
    var pcm = d.pcm instanceof Float32Array ? d.pcm : new Float32Array(d.pcm);
    wfPush(pcm, d.sampleRate || 24000);
  });
  function wfSync() {
    wfApplyPrefs();
    var m = currentMode();
    if (m.id !== 'telnet' && m.available) wfStart(m.id); else wfStop();
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  $('wl-mode').addEventListener('change', function () {
    gateways = [];
    $('wl-gateway').innerHTML = '<option value="">Load gateways…</option>';
    window.api.setMode($('wl-mode').value);
    renderModeNote();
    wfSync();
  });
  $('wl-band').addEventListener('change', function () { loadGateways(false); });
  // Picking a gateway tunes the radio to it at once, so the waterfall shows
  // that frequency; the dial goes back when the session ends or the window closes.
  $('wl-gateway').addEventListener('change', function () {
    var g = gateways[parseInt($('wl-gateway').value, 10)];
    if (!g || !g.dialKhz) return;
    window.api.qsy({ dialKhz: g.dialKhz, mode: currentMode().id }).then(function (r) {
      if (r && !r.ok && r.error) { $('wl-text').textContent = r.error; }
    });
  });
  $('wl-gw-refresh').addEventListener('click', function () { loadGateways(true); });

  // One line per gateway, the prediction as a word first: what the operator
  // decides on is whether the path is open, not a percentage.
  function gatewayLabel(g) {
    var parts = [g.call];
    if (g.dialKhz) parts.push(g.dialKhz.toFixed(1) + ' kHz');
    if (g.qualityWord) parts.push(g.qualityWord + (g.quality != null ? ' ' + g.quality + '%' : ''));
    if (g.distKm != null) parts.push(g.distKm + ' km');
    if (g.mercury) parts.push('(Mercury)');
    return parts.join('  ');
  }

  function loadGateways() {
    var m = currentMode();
    if (m.id === 'telnet' || !m.available) return;
    var sel = $('wl-gateway');
    var note = $('wl-gw-note');
    var hf = m.id !== 'packet' && m.id !== 'varafm';
    sel.innerHTML = '<option value="">' + (hf ? 'Loading gateways and predicting propagation…' : 'Loading gateways…') + '</option>';
    if (note) note.textContent = '';
    window.api.gateways(m.id, $('wl-band').value).then(function (r) {
      if (!r || !r.ok) { sel.innerHTML = '<option value="">' + esc((r && r.error) || 'No list') + '</option>'; return; }
      gateways = r.list || [];
      if (note) note.textContent = r.note || '';
      if (!gateways.length) { sel.innerHTML = '<option value="">No gateways for that band</option>'; return; }
      var last = state && state.lastGateway;
      sel.innerHTML = gateways.slice(0, 120).map(function (g, i) {
        var label = gatewayLabel(g);
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
        o.gateway = g.call; o.dialKhz = g.dialKhz; o.url = g.url;
      }
      window.api.connect(o).then(function (r) {
        if (r && !r.ok) { $('wl-text').textContent = r.error || 'Could not start'; $('wl-text').style.color = '#e94560'; }
      });
    });
  });
  $('wl-abort').addEventListener('click', function () { window.api.abort(); });

  // ── radio sound: automatic, asked only when POTACAT cannot tell ──────────
  var soundTried = false;
  function shortName(n) { return String(n || '').replace(/\s*\(.*$/, ''); }
  function renderSound() {
    var a = (state && state.audio) || {};
    var el = $('wl-sound');
    if (!a.needed) { el.textContent = ''; return; }
    // Packet (Dire Wolf) still opens the sound card itself; its pick lives in a.packet.
    if (currentMode().id === 'packet' && a.packet && a.packet.needed) {
      el.innerHTML = a.packet.ready
        ? 'Radio sound: ' + esc(shortName(a.packet.capture)) + ' / ' + esc(shortName(a.packet.playback)) + ' · <a id="wl-sound-change">Change</a>'
        : 'Radio sound not set · <a id="wl-sound-change">Choose</a>';
      var ch = $('wl-sound-change');
      if (ch) ch.onclick = function () { openSoundCard(null); };
      return;
    }
    // Everything else rides POTACAT: the Flex Direct / Icom Network stream, or
    // the audio bridge on the radio's own sound card (the devices FT8 uses).
    var b = a.bridge || null;
    if (b && b.state === 'error') { el.innerHTML = '<span style="color:#e94560">Radio sound: ' + esc(b.error) + '</span>'; return; }
    el.textContent = 'Radio sound: via POTACAT (' + shortName(a.capture) + (a.playback && a.playback !== a.capture ? ' → ' + shortName(a.playback) : '') + ')' + (b && b.state === 'starting' ? ' — opening…' : '');
  }
  function fillSelect(sel, list, pick) {
    sel.innerHTML = '<option value="">(choose)</option>' + list.map(function (d) {
      return '<option value="' + esc(d.name) + '"' + (d.name === pick ? ' selected' : '') + '>' + esc(d.name) + '</option>';
    }).join('');
  }
  function openSoundCard(prefill) {
    var card = $('wl-sound-card');
    $('wl-sound-hint').textContent = 'Listing the sound devices…';
    card.classList.add('show');
    window.api.audioList().then(function (r) {
      if (!r || !r.ok) { $('wl-sound-hint').textContent = (r && r.error) || 'Could not list the sound devices'; return; }
      var a = ((state && state.audio) || {}).packet || (state && state.audio) || {};
      fillSelect($('wl-sound-in'), r.devices.capture, (prefill && prefill.capture) || a.capture);
      fillSelect($('wl-sound-out'), r.devices.playback, (prefill && prefill.playback) || a.playback);
      $('wl-sound-hint').textContent = 'The same devices your radio uses for FT8 — on a Flex, DAX RX and DAX TX.';
    });
  }
  $('wl-sound-ok').addEventListener('click', function () {
    var c = $('wl-sound-in').value, p = $('wl-sound-out').value;
    if (!c || !p) { $('wl-sound-hint').textContent = 'Choose both.'; return; }
    window.api.audioSave({ captureLabel: c, playbackLabel: p }).then(function () { $('wl-sound-card').classList.remove('show'); });
  });
  $('wl-sound-cancel').addEventListener('click', function () { $('wl-sound-card').classList.remove('show'); });

  // Resolve the rig's FT8 device NAMES here (only a renderer can), then let
  // main pick and save. Silent when it can tell; a card for what it can't.
  function autoSound() {
    var a = (state && state.audio) || {};
    // Only packet needs a pick now (ARDOP's audio rides POTACAT on every rig).
    if (soundTried || !a.needed || a.ready || currentMode().id !== 'packet') return;
    soundTried = true;
    window.api.audioRig().then(function (rig) {
      var labels = Promise.resolve({});
      if (rig && rig.ok && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        labels = navigator.mediaDevices.enumerateDevices().then(function (devs) {
          var i = devs.find(function (d) { return d.kind === 'audioinput' && d.deviceId === rig.inputId; });
          var o = devs.find(function (d) { return d.kind === 'audiooutput' && d.deviceId === rig.outputId; });
          return { inputLabel: i ? i.label : '', outputLabel: o ? o.label : '' };
        }).catch(function () { return {}; });
      }
      return labels.then(function (l) { return window.api.audioAuto(l); });
    }).then(function (r) {
      if (r && r.ok && !r.auto && r.proposal && !((state.audio || {}).ready)) openSoundCard(r.proposal);
    });
  }

  // ── the radio: power setting, forward power, SWR ──────────────────────────
  var pwrIn = $('wl-pwr'), pwrSel = $('wl-pwr-sel'), pwrTimer = null, pwrEditing = false, pwrLast = null;
  function renderRigPower(p) {
    if (!p) return;
    pwrLast = p;
    var choices = Array.isArray(p.powerChoices) && p.powerChoices.length ? p.powerChoices : null;
    pwrSel.classList.toggle('hidden', !choices);
    pwrIn.classList.toggle('hidden', !!choices);
    if (choices) {
      if (pwrSel.options.length !== choices.length) pwrSel.innerHTML = choices.map(function (w) { return '<option value="' + w + '">' + w + '</option>'; }).join('');
      if (p.known) pwrSel.value = String(p.watts);
      pwrSel.disabled = !p.settable;
    } else {
      pwrIn.min = p.minPower != null ? p.minPower : 1; pwrIn.max = p.maxPower != null ? p.maxPower : 100; pwrIn.step = p.powerStep || 1;
      if (p.known && !pwrEditing) pwrIn.value = p.powerDecimals ? Number(p.watts).toFixed(p.powerDecimals) : String(Math.round(p.watts));
      pwrIn.disabled = !p.settable;
    }
    pwrIn.title = p.settable ? 'The radio\'s RF power setting' : 'This radio does not take a power setting over CAT';
  }
  function sendPower(v) {
    var w = Number(v);
    if (!isFinite(w) || w <= 0) return;
    window.api.rigControl({ action: 'set-tx-power', value: w }).then(function (r) {
      if (r && r.ok === false && r.error) $('wl-text').textContent = r.error;
    });
  }
  pwrIn.addEventListener('focus', function () { pwrEditing = true; });
  pwrIn.addEventListener('blur', function () { pwrEditing = false; if (pwrLast) renderRigPower(pwrLast); });
  pwrIn.addEventListener('input', function () { clearTimeout(pwrTimer); pwrTimer = setTimeout(function () { sendPower(pwrIn.value); }, 400); });
  pwrIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(pwrTimer); sendPower(pwrIn.value); pwrIn.blur(); } });
  pwrSel.addEventListener('change', function () { sendPower(pwrSel.value); });
  window.api.onRigPower(renderRigPower);
  var fwdEl = $('wl-fwd'), swrEl = $('wl-swr'), swrRatioSeen = false;
  window.api.onCatFwdPower(function (v) {
    var w = Number(v) || 0;
    fwdEl.textContent = w > 0 ? 'PWR ' + (w >= 10 ? Math.round(w) : w.toFixed(1)) + ' W' : 'PWR —';
    fwdEl.className = 'wl-meter' + (w > 0 ? ' live' : '');
  });
  function showSwr(r) {
    if (!(r > 0)) { swrEl.textContent = 'SWR —'; swrEl.className = 'wl-meter'; return; }
    swrEl.textContent = 'SWR ' + r.toFixed(1);
    swrEl.className = 'wl-meter ' + (r >= 3 ? 'high' : 'live');
  }
  // cat-swr is the Flex-style 0-255 wire value; cat-swr-ratio the true ratio and wins when it arrives.
  window.api.onCatSwr(function (v) { if (swrRatioSeen) return; var n = Number(v) || 0; showSwr(n > 0 ? 1 + n / 60 : 0); });
  window.api.onCatSwrRatio(function (v) { swrRatioSeen = true; showSwr(Number(v) || 0); });

  // ── wiring ───────────────────────────────────────────────────────────────
  window.api.onState(function (s) { state = s; renderState(); renderSound(); autoSound(); wfSync(); });
  window.api.onSession(function (ss) { if (state) state.session = ss; renderSession(ss); });
  window.api.onMailbox(function (d) {
    if (!d || !lists.hasOwnProperty(d.box)) return;
    lists[d.box] = d.messages || [];
    if (d.box === box) renderList();
  });
  window.api.getState().then(function (s) { state = s; renderState(); renderSound(); autoSound(); wfSync(); });
})();

// Bands this radio is used on (rig editor; main.js rig-bands): the gateway
// band filter offers only those.
(function initRigBandsFilter() {
  var sel = document.getElementById('wl-band');
  if (!sel || !window.RigBands || !window.api || !window.api.rigBandsGet) return;
  function apply(d) {
    window.RigBands.applyToElements(sel, 'option', (d && d.bands) || null);
    if (window.RigBands.fixSelect(sel)) sel.dispatchEvent(new Event('change'));
  }
  window.api.rigBandsGet().then(apply).catch(function () {});
  window.api.onRigBands(apply);
})();
