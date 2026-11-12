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
    if (window.applyPopoutTheme) window.applyPopoutTheme(t);
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
    refreshFavMarks(); // re-stars the list only when the favorites changed
    if (historyOpen) renderHistory();
    refreshAddressBits();
  }

  function currentMode() {
    var id = $('wl-mode').value;
    return ((state && state.modes) || []).find(function (m) { return m.id === id; }) || { id: 'telnet', available: true };
  }

  // #188: the compose body hint follows the session mode (NA4DQ: packet said HF).
  function composeHint(id) {
    if (id === 'packet') return 'Plain text. Keep it short over VHF packet.';
    if (id === 'varafm') return 'Plain text. Keep it short over VARA FM.';
    if (id === 'ardop' || id === 'vara' || id === 'mercury') return 'Plain text. Keep it short over HF.';
    return 'Plain text.';
  }

  function renderModeNote() {
    var m = currentMode();
    $('wl-c-body').placeholder = composeHint(m.id);
    var radio = m.id !== 'telnet';
    $('wl-radio-pick').classList.toggle('show', radio);
    var note = '';
    if (m.id === 'mercury') note = 'Experimental: few gateways run Mercury yet.';
    if (m.id === 'vara' || m.id === 'varafm') note = 'Your own ' + (m.id === 'varafm' ? 'VARA FM' : 'VARA HF') + ', with its PTT set to VOX — POTACAT starts it if needed and keys the radio.';
    if (m.note) note = m.note;   // a radio mode that runs with a caveat: no CAT control, the operator sets the dial (NA4DQ)
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
    renderFavBtn();
    renderDial();
  }

  function renderSession(ss) {
    var st = ss.state || 'idle';
    var el = $('wl-state');
    el.className = 'wl-state ' + st;
    // How it ended comes from the shack in one piece (session.outcome,
    // lib/winlink-outcome.js): "Link dropped", "No answer", "Stopped". A link
    // that had connected never reads "Failed" (#425).
    var ended = st === 'done' || st === 'error';
    el.textContent = (ended && ss.outcome && ss.outcome.word) || STATE_WORDS[st] || st;
    // A finished session's sentence is read in full: it wraps, it is not cut.
    document.querySelector('.wl-session').classList.toggle('final', ended);
    var active = ['starting', 'connecting', 'connected', 'disconnecting'].indexOf(st) >= 0;
    $('wl-connect').disabled = active || !(state && state.patReady);
    $('wl-abort').disabled = !active;
    $('wl-mode').disabled = active;
    renderDoneCard(ss);
    renderDial();
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
    // While the card is up with the whole sentence, the bar keeps to its first
    // part; with the card closed the bar says all of it.
    var cardUp = $('wl-done-card').classList.contains('show') && $('wl-done-card').classList.contains('bad');
    $('wl-text').textContent = cardUp && ss.outcome && ss.outcome.title ? ss.outcome.title : text;
    $('wl-text').title = ended ? text : '';
    $('wl-text').style.color = st === 'error' ? 'var(--accent-red-text, var(--accent-red, #e94560))' : st === 'done' ? 'var(--accent-green, #4ecca3)' : '';
    $('wl-text').style.fontWeight = (st === 'done' || st === 'error') ? '700' : '';
    $('wl-remaining').textContent = active && ss.remainingSec != null ? Math.floor(ss.remainingSec / 60) + ':' + String(ss.remainingSec % 60).padStart(2, '0') + ' left' : '';

    var p = ss.prompt;
    var pr = $('wl-prompt');
    // "Keep waiting" is remembered per prompt: the session is pushed twice a
    // second, and the bar used to come straight back (#296).
    pr.classList.toggle('show', !!p && !(p.kind === 'busy-channel' && p.id === keptWaitingFor));
    if (p) {
      if (p.kind === 'busy-channel') {
        $('wl-prompt-text').textContent = busyPromptText(p);
        $('wl-prompt-yes').textContent = 'Keep waiting';
        $('wl-prompt-no').textContent = 'Give up';
        $('wl-prompt-yes').onclick = function () { keptWaitingFor = p.id; pr.classList.remove('show'); };
        $('wl-prompt-go').textContent = 'Call anyway';
        $('wl-prompt-go').style.display = '';
        $('wl-prompt-go').onclick = function () { window.api.answerPrompt(p.id, 'continue'); };
        $('wl-prompt-no').onclick = function () { window.api.answerPrompt(p.id, 'abort'); };
      } else {
        $('wl-prompt-go').style.display = 'none';
        $('wl-prompt-text').textContent = p.message || 'Winlink asks for a decision';
        $('wl-prompt-yes').textContent = 'Accept';
        $('wl-prompt-no').textContent = 'Decline';
        $('wl-prompt-yes').onclick = function () { window.api.answerPrompt(p.id, 'accept'); };
        $('wl-prompt-no').onclick = function () { window.api.answerPrompt(p.id, 'decline'); };
      }
    }
  }

  var keptWaitingFor = null; // the busy-channel prompt the operator chose to keep waiting on
  /** "The frequency is busy. Waited 0:42 of 5:00; ..." (the same words on ECHOCAT Web, remote.js). */
  function busyPromptText(p) {
    var mmss = function (s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    var t = 'The frequency is busy.';
    if (p.limitSec && p.waitedSec != null) t += ' Waited ' + mmss(Math.min(p.waitedSec, p.limitSec)) + ' of ' + mmss(p.limitSec) + '; the call starts by itself when it clears and is dropped at ' + mmss(p.limitSec) + '.';
    return t + ' Call anyway only if you have listened and it is clear.';
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
      if (historyOpen) closeHistory();
      box = f.getAttribute('data-box');
      Array.prototype.forEach.call(document.querySelectorAll('.wl-folder'), function (x) { x.classList.toggle('active', x === f); });
      openMid = null;
      showReader('<div class="wl-empty">Pick a message.</div>');
      renderList();
      window.api.list(box);
    });
  });

  function showReader(html) {
    if (chipFields && chipFields.to) hideForms();
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
        + '<button class="wl-btn" id="wl-forward">Forward</button>'
        + (m.from && !contactFor(m.from) && WC.normalizeAddress(m.from) ? '<button class="wl-btn" id="wl-addbook">Add to address book</button>' : '')
        + '<span class="wl-spacer"></span><button class="wl-btn danger" id="wl-del">Delete</button></div>'
        + '<div class="wl-hdr"><b>' + esc(m.subject || '(no subject)') + '</b><br>From <b>' + esc(m.from) + '</b> · ' + esc(new Date(m.date).toLocaleString()) + '<br>To ' + esc((m.to || []).join(', '))
        + (m.cc && m.cc.length ? '<br>Cc ' + esc(m.cc.join(', ')) : '') + '</div>'
        + '<div class="wl-body">' + esc(m.body || '') + '</div>'
        + (m.attachments && m.attachments.length ? '<div class="wl-attach">' + m.attachments.map(function (a) {
          return '<button class="wl-btn wl-att" data-name="' + esc(a.name) + '">Save ' + esc(a.name) + ' (' + fmtSize(a.size) + ')</button>';
        }).join('') + '</div>' : '');
      showReader(html);
      var rp = $('wl-reply'); if (rp) rp.onclick = function () { compose({ to: m.from, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, body: '\n\n--- ' + m.from + ' wrote:\n' + (m.body || '').split('\n').map(function (l) { return '> ' + l; }).join('\n') }); };
      // #wl-forward, not #wl-fwd: that id is the PWR meter, which took the click.
      var ab = $('wl-addbook'); if (ab) ab.onclick = function () { openBook({ address: m.from }); };
      $('wl-forward').onclick = function () { compose({ subject: 'Fwd: ' + m.subject, body: '\n\n--- Forwarded from ' + m.from + ':\n' + (m.body || '') }); };
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

  // tplEdit: null for a message; { id } while writing or editing a template
  // (the same form, with a Name and Save template instead of Put in Outbox).
  var tplEdit = null;
  function setTemplateMode(t) {
    tplEdit = t;
    $('wl-c-name-row').hidden = !t;
    $('wl-c-attach').hidden = !!t;                // templates carry no attachments
    $('wl-c-files').hidden = !!t;
    $('wl-c-save-tpl').hidden = !!t;
    $('wl-c-send').textContent = t ? 'Save template' : 'Put in Outbox';
  }
  function compose(pre) {
    // A template is the operator's own text: no notice needed until it is sent.
    var go = function () {
      pre = pre || {};
      hideForms();
      $('wl-reader').style.display = 'none';
      $('wl-compose').classList.add('show');
      setTemplateMode(pre.template ? { id: pre.id || null } : null);
      $('wl-c-name').value = pre.name || '';
      setChips('to', pre.to || '');
      setChips('cc', pre.cc || '');
      $('wl-c-subj').value = pre.subject || '';
      $('wl-c-body').value = pre.body || '';
      pendingFiles = [];
      renderFiles();
      $('wl-c-err').textContent = '';
      // A template's instructions go in their own panel above the body.
      $('wl-c-hint').textContent = pre.note || '';
      $('wl-c-hint').hidden = !pre.note;
      (pre.template ? $('wl-c-name') : pre.to ? $('wl-c-body') : chipFields.to.input).focus();
    };
    if (pre && pre.template) go(); else requireNotice(go);
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
    if (tplEdit) { saveTemplate(); return; }
    $('wl-c-send').disabled = true;
    window.api.send({ to: chipValue('to'), cc: chipValue('cc'), subject: $('wl-c-subj').value, body: $('wl-c-body').value, attachments: pendingFiles }).then(function (r) {
      $('wl-c-send').disabled = false;
      if (!r || !r.ok) { $('wl-c-err').textContent = (r && r.error) || 'Could not queue it'; return; }
      showReader('<div class="wl-empty">In the Outbox. It goes out on the next Send / Receive.</div>');
    });
  });

  $('wl-settings').addEventListener('click', function () { window.api.openSettings(); });
  // POTA spot: a message to spot@pota.tdod.org, one line per park; the
  // operator reads and edits it before it goes in the Outbox.
  // The POTA spot opens its form (Casey 2026-11-11: fields, not a line to edit by hand).
  function composeSpot(t) {
    if (!t || !t.to) return;
    openSpotForm(t);
  }

  if (window.api.onComposePrefill) window.api.onComposePrefill(composeSpot);

  // ── Templates (Casey 2026-11-11): one button instead of a column of them ──
  // Built in: Position report, POTA spot. Then the operator's own (saved in
  // the profile, winlink-state.templates), then Add new template.
  function templates() { return (state && Array.isArray(state.templates)) ? state.templates : []; }
  var tplMenuOpen = false, tplDelArmed = null;
  function renderTemplateMenu() {
    var own = templates();
    var html = '<div class="wl-tpl-head">Built in</div>'
      + '<button class="wl-tpl-item" role="menuitem" data-tpl="pos"><span class="wl-tpl-main">Position report<span class="wl-tpl-sub">From your grid square, straight to the Outbox</span></span></button>'
      + '<button class="wl-tpl-item" role="menuitem" data-tpl="pota"><span class="wl-tpl-main">POTA spot<span class="wl-tpl-sub">Your park, frequency and mode</span></span></button>';
    if (own.length) {
      html += '<div class="wl-tpl-sep"></div><div class="wl-tpl-head">Yours</div>' + own.map(function (t) {
        var armed = tplDelArmed === t.id;
        return '<div class="wl-tpl-item" role="menuitem" tabindex="0" data-own="' + esc(t.id) + '"><span class="wl-tpl-main">' + esc(t.name)
          + '<span class="wl-tpl-sub">' + esc([t.to, t.subject].filter(Boolean).join(' · ') || 'No address or subject yet') + '</span></span>'
          + '<button class="wl-tpl-del" data-edit="' + esc(t.id) + '" aria-label="Edit ' + esc(t.name) + '" title="Edit">Edit</button>'
          + '<button class="wl-tpl-del" data-del="' + esc(t.id) + '" aria-label="Delete ' + esc(t.name) + '" title="Delete">' + (armed ? 'Delete?' : '&#10005;') + '</button></div>';
      }).join('');
    }
    html += '<div class="wl-tpl-sep"></div><button class="wl-tpl-item wl-tpl-add" role="menuitem" data-tpl="add">+ Add new template</button>';
    $('wl-tpl-menu').innerHTML = html;
  }
  function openTemplateMenu() {
    var btn = $('wl-tpl-btn'), menu = $('wl-tpl-menu'), main = $('wl-main');
    tplDelArmed = null;
    renderTemplateMenu();
    menu.hidden = false;
    tplMenuOpen = true;
    btn.setAttribute('aria-expanded', 'true');
    var b = btn.getBoundingClientRect(), m = main.getBoundingClientRect();
    menu.style.left = Math.round(b.right - m.left + 6) + 'px';
    // Beside the button, kept inside the mail area.
    var top = b.top - m.top;
    menu.style.top = Math.max(8, Math.min(top, m.height - menu.offsetHeight - 8)) + 'px';
    var first = menu.querySelector('.wl-tpl-item'); if (first) first.focus();
  }
  function closeTemplateMenu() {
    $('wl-tpl-menu').hidden = true;
    tplMenuOpen = false;
    $('wl-tpl-btn').setAttribute('aria-expanded', 'false');
  }
  $('wl-tpl-btn').addEventListener('click', function (e) { e.stopPropagation(); if (tplMenuOpen) closeTemplateMenu(); else openTemplateMenu(); });
  document.addEventListener('click', function (e) { if (tplMenuOpen && !e.target.closest('#wl-tpl-menu')) closeTemplateMenu(); });
  document.addEventListener('keydown', function (e) { if (tplMenuOpen && e.key === 'Escape') { closeTemplateMenu(); $('wl-tpl-btn').focus(); } });
  $('wl-tpl-menu').addEventListener('click', function (e) {
    e.stopPropagation();
    var del = e.target.closest('[data-del]');
    if (del) {
      var id = del.getAttribute('data-del');
      if (tplDelArmed !== id) { tplDelArmed = id; renderTemplateMenu(); return; }   // a second click deletes
      tplDelArmed = null;
      window.api.template('delete', { id: id });
      return;
    }
    var edit = e.target.closest('[data-edit]');
    if (edit) {
      var te = templates().find(function (x) { return x.id === edit.getAttribute('data-edit'); });
      closeTemplateMenu();
      if (te) compose({ template: true, id: te.id, name: te.name, to: te.to, cc: te.cc, subject: te.subject, body: te.body });
      return;
    }
    var own = e.target.closest('[data-own]');
    if (own) {
      var t = templates().find(function (x) { return x.id === own.getAttribute('data-own'); });
      closeTemplateMenu();
      if (t) compose({ to: t.to, cc: t.cc, subject: t.subject, body: t.body });
      return;
    }
    var b = e.target.closest('[data-tpl]');
    if (!b) return;
    var k = b.getAttribute('data-tpl');
    closeTemplateMenu();
    if (k === 'pos') openPositionForm();
    else if (k === 'pota') window.api.potaSpotTemplate({}).then(composeSpot);
    else if (k === 'add') compose({ template: true });
  });
  $('wl-tpl-menu').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('[data-own]')) e.target.click();
  });
  function saveTemplate() {
    var t = { id: tplEdit && tplEdit.id, name: $('wl-c-name').value, to: chipValue('to'), cc: chipValue('cc'), subject: $('wl-c-subj').value, body: $('wl-c-body').value };
    if (!String(t.name).trim()) { $('wl-c-err').textContent = 'Give the template a name, the one the Templates menu shows.'; $('wl-c-name').focus(); return; }
    $('wl-c-send').disabled = true;
    window.api.template('save', t).then(function (r) {
      $('wl-c-send').disabled = false;
      if (!r || !r.ok) { $('wl-c-err').textContent = (r && r.error) || 'Could not save the template'; return; }
      setTemplateMode(null);
      showReader('<div class="wl-empty">Template "' + esc(String(t.name).trim()) + '" saved. It is in the Templates menu.</div>');
    });
  }
  // A message being written becomes a template: same fields, add a name.
  $('wl-c-save-tpl').addEventListener('click', function () {
    setTemplateMode({ id: null });
    $('wl-c-err').textContent = '';
    $('wl-c-name').focus();
  });

  // ── waterfall: is the gateway frequency in use? ──────────────────────────
  // 0–3000 Hz of the receiver's passband, from main's direct-audio frames
  // (Flex Direct / Icom Network) or, on a sound-device rig, the rig's own
  // input captured here. Shown while a radio mode is selected.
  var WF_BINS = 256;                       // 0..3000 Hz at 11.7 Hz
  var WF_N = 2048;                         // FFT window at 24 kHz (85 ms)
  var WF_HOP = 512;                        // a new line every 21 ms (~47/s) before averaging
  var wf = null, wfMode = 'none', wfAcc = new Float32Array(WF_N), wfAccLen = 0, wfRate = 24000;
  var wfSpeed = 60, wfShown = true, wfHidden = false;
  // Waterfall colours: the machine's palette (lib/waterfall-palettes.js).
  var wlWfPal = { id: 'auto', o: {} };
  if (window.WaterfallPalettes) {
    WaterfallPalettes.follow(window.api, function (id, o) {
      wlWfPal = { id: id, o: o };
      if (wf && wf.supported) wf.setPalette(id, o);
    });
  }
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
        try { wf = new Waterfall($('wl-wf-canvas'), { bins: WF_BINS, historyRows: 256, gamma: 0.6, crop: true, palette: wlWfPal.id, paletteOpts: wlWfPal.o }); } catch (e) { wf = null; }
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
    var g = pickedGateway();
    renderDial();
    renderFavBtn();
    if (g && g.dialKhz) qsyTo(g.dialKhz);
  });
  $('wl-gw-refresh').addEventListener('click', function () { loadGateways(true); });

  function qsyTo(khz) {
    window.api.qsy({ dialKhz: khz, mode: currentMode().id }).then(function (r) {
      if (r && !r.ok && r.error) { $('wl-text').textContent = r.error; }
    });
  }

  // ── favorite gateways (#254; Casey 2026-11-11: starred in the gateway list,
  // in its propagation order, no strip of their own) ──────────────────────────
  function favs() { return (state && Array.isArray(state.favourites)) ? state.favourites : []; }
  function sameGw(a, b) { return !!a && !!b && String(a.call).toUpperCase() === String(b.call).toUpperCase() && Math.abs(Number(a.khz != null ? a.khz : a.dialKhz) - Number(b.khz != null ? b.khz : b.dialKhz)) < 0.05; }
  function isFav(g, mode) { return favs().some(function (f) { return f.mode === (mode || currentMode().id) && sameGw(f, g); }); }
  // A frequency the way the VFO writes it: 7.100.50 (MHz, kHz, tens of Hz),
  // dots, never a comma (Casey 2026-11-11). Input in kHz.
  // lib/freq-dots.js, the one formatter
  function fmtDial(khz) { return FreqDots.fromKhz(khz); }
  var MODE_SHORT = { ardop: 'ARDOP', vara: 'VARA HF', varafm: 'VARA FM', packet: 'Packet', mercury: 'Mercury' };
  function fmtDay(ms) {
    if (!(ms > 0)) return '';
    var d = new Date(ms);
    return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  }
  function fmtUtc(ms) {
    if (!(ms > 0)) return '';
    var d = new Date(ms);
    return fmtDay(ms) + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + 'Z';
  }
  var STAR = '<svg class="wl-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"></path></svg>';
  var STAR_EMPTY = STAR.replace('class="wl-star"', 'class="wl-star empty"');

  // The star beside the gateway list: filled when the picked gateway is a
  // favorite; one click adds or removes it, like a bookmark.
  function renderFavBtn() {
    var b = $('wl-fav');
    var g = pickedGateway();
    var m = currentMode().id;
    var ok = !!(g && g.call && g.dialKhz && m !== 'telnet');
    var on = ok && isFav(g, m);
    b.disabled = !ok;
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = on ? STAR : STAR_EMPTY;
    var t = !ok ? 'Pick a gateway to add it to your favorites' : on ? g.call + ' is a favorite (click to remove it)' : 'Add ' + g.call + ' to your favorites';
    b.title = t;
    b.setAttribute('aria-label', t);
  }
  $('wl-fav').addEventListener('click', function () {
    var g = pickedGateway();
    var m = currentMode().id;
    if (!g || m === 'telnet') return;
    window.api.favourite(isFav(g, m) ? 'remove' : 'add', { call: g.call, mode: m, dialKhz: g.dialKhz, url: g.url || '' });
  });
  // Favorites changed (a winlink-state push): re-star the list in place,
  // keeping the pick; Pat is not asked again.
  var favSig = '';
  function refreshFavMarks() {
    var sig = JSON.stringify(favs().map(function (f) { return f.call + '|' + f.mode + '|' + f.khz; }));
    if (sig === favSig) { renderFavBtn(); return; }
    favSig = sig;
    if (lastList) { var keep = pickedGateway(); buildGatewayOptions(lastList, keep ? { call: keep.call, khz: keep.dialKhz } : null); }
    else renderFavBtn();
  }

  // One gateway (a favorite or a History row) → mode, band, gateway and dial
  // set together, and the radio tuned there.
  var pendingPick = null;
  function useGateway(g) {
    if (!g) return;
    var khz = Number(g.khz != null ? g.khz : g.dialKhz);
    var modeSel = $('wl-mode');
    var avail = ((state && state.modes) || []).find(function (m) { return m.id === g.mode && m.available; });
    if (!avail) { $('wl-text').textContent = (MODE_SHORT[g.mode] || g.mode) + ' is not available on this station right now'; return; }
    if (modeSel.disabled) { $('wl-text').textContent = 'A session is running: Abort it first'; return; }
    pendingPick = { call: String(g.call).toUpperCase(), khz: khz, mode: g.mode, url: g.url || '' };
    var modeChanged = modeSel.value !== g.mode;
    if (modeChanged) { modeSel.value = g.mode; window.api.setMode(g.mode); renderModeNote(); wfSync(); }
    var bandSel = $('wl-band');
    var bandOpt = g.band && Array.prototype.find.call(bandSel.options, function (o) { return (o.value || o.textContent) === g.band && !o.hidden && !o.disabled; });
    bandSel.value = bandOpt ? g.band : '';
    if (historyOpen) closeHistory();
    loadGateways(false);
    qsyTo(khz);
  }

  // One line per gateway, the prediction as a word first: what the operator
  // decides on is whether the path is open, not a percentage. A favorite
  // carries a star and keeps its place in the ranking.
  function gatewayLabel(g) {
    var parts = [(isFav(g) ? '\u2605 ' : '') + g.call];
    if (g.dialKhz) parts.push(fmtDial(g.dialKhz) + ' MHz');
    if (g.qualityWord) parts.push(g.qualityWord + (g.quality != null ? ' ' + g.quality + '%' : ''));
    if (g.distKm != null) parts.push(g.distKm + ' km');
    if (g.mercury) parts.push('(Mercury)');
    return parts.join('  ');
  }

  // Rows the gateway list holds besides Pat's: favorites Pat did not list
  // this time, and a History row picked from outside the list.
  var favRows = [];
  function pickedGateway() {
    var v = $('wl-gateway').value;
    if (/^f:\d+$/.test(v)) return favRows[parseInt(v.slice(2), 10)] || null;
    return gateways[parseInt(v, 10)] || null;
  }

  // Predicting: how long it has run, and about how long the last one took.
  var predictTimer = null;
  function predictStart(modeId) {
    var t0 = Date.now();
    var expect = Number(((state && state.predictMs) || {})[modeId]) || 0;
    var box = $('wl-predict');
    box.hidden = false;
    var tick = function () {
      var s = Math.round((Date.now() - t0) / 1000);
      var left = expect ? Math.max(1, Math.round((expect - (Date.now() - t0)) / 1000)) : 0;
      // Short enough to sit right of Abort; the full sentence is the tooltip.
      $('wl-predict-text').textContent = 'Predicting ' + s + (expect && Date.now() - t0 < expect ? '/' + Math.round(expect / 1000) : '') + ' s';
      box.title = 'Predicting propagation for every gateway: ' + s + ' s so far' + (expect ? ', about ' + Math.round(expect / 1000) + ' s last time' : '; the first ranking can take a minute or two');
      var frac = expect ? Math.min(0.95, (Date.now() - t0) / expect) : Math.min(0.95, (Date.now() - t0) / 90000);
      $('wl-predict-fill').style.width = Math.round(frac * 100) + '%';
    };
    tick();
    clearInterval(predictTimer);
    predictTimer = setInterval(tick, 1000);
  }
  function predictStop() { clearInterval(predictTimer); predictTimer = null; $('wl-predict').hidden = true; }

  function favOption(f, i, selected) {
    return '<option value="f:' + i + '"' + (selected ? ' selected' : '') + '>' + esc('\u2605 ' + f.call + '  ' + fmtDial(f.dialKhz) + ' MHz' + (f.band ? '  ' + f.band : '')) + '</option>';
  }

  // The list from one Pat answer: Pat's ranking with favorites starred in
  // place, then any favorite Pat did not list, then the left-out line.
  var lastList = null;
  function buildGatewayOptions(r, keep) {
    var sel = $('wl-gateway');
    var m = currentMode().id;
    var band = $('wl-band').value;
    favRows = favs().filter(function (f) { return f.mode === m && (!band || f.band === band) && !gateways.some(function (g) { return sameGw(g, f); }); })
      .map(function (f) { return { call: f.call, dialKhz: f.khz, band: f.band, url: f.url || '', saved: true }; });
    var last = state && state.lastGateway;
    var want = pendingPick || keep || (last && { call: last.call, khz: last.dialKhz });
    var picked = false;
    var rows = gateways.slice(0, 120).map(function (g, i) {
      var hit = !picked && want && sameGw(want, g);
      if (hit) picked = true;
      return '<option value="' + i + '"' + (hit ? ' selected' : '') + '>' + esc(gatewayLabel(g)) + '</option>';
    }).join('');
    if (!gateways.length) rows = '<option value="" disabled>No gateways for that band</option>';
    var extra = favRows.length ? '<optgroup label="Favorites not in this list">' + favRows.map(function (f, i) {
      var hit = !picked && want && sameGw(want, f);
      if (hit) picked = true;
      return favOption(f, i, hit);
    }).join('') + '</optgroup>' : '';
    var more = r.leftOut ? '<option value="" disabled>' + esc(r.leftOut + ' more this radio cannot call (outside the amateur bands, or bands not set up in Settings > My Rigs > Bands)') + '</option>' : '';
    sel.innerHTML = '<optgroup label="' + (r.predicted ? 'Best path now' : 'Nearest first') + '">' + rows + '</optgroup>' + extra + more;
    if (pendingPick && !picked) {
      // A History row not in today's list is still callable: a row of its own at the top.
      favRows.push({ call: pendingPick.call, dialKhz: pendingPick.khz, band: '', url: pendingPick.url || '' });
      var opt = document.createElement('option');
      opt.value = 'f:' + (favRows.length - 1);
      opt.textContent = pendingPick.call + '  ' + fmtDial(pendingPick.khz) + ' MHz  (from History)';
      sel.insertBefore(opt, sel.firstChild);
      sel.value = opt.value;
    }
    pendingPick = null;
    renderDial();
    renderFavBtn();
  }

  var loadSeq = 0;
  function loadGateways() {
    var m = currentMode();
    if (m.id === 'telnet' || !m.available) return;
    var sel = $('wl-gateway');
    var note = $('wl-gw-note');
    var hf = m.id !== 'packet' && m.id !== 'varafm';
    var band = $('wl-band').value;
    var seq = ++loadSeq;
    lastList = null;
    // Favorites are usable at once, while the list and its prediction load.
    favRows = favs().filter(function (f) { return f.mode === m.id && (!band || f.band === band); })
      .map(function (f) { return { call: f.call, dialKhz: f.khz, band: f.band, url: f.url || '', saved: true }; });
    var favHtml = favRows.length ? '<optgroup label="Favorites">' + favRows.map(function (f, i) { return favOption(f, i, pendingPick && sameGw(pendingPick, f)); }).join('') + '</optgroup>' : '';
    sel.innerHTML = favHtml + '<option value=""' + (favHtml && pendingPick ? '' : ' selected') + '>Loading gateways…</option>';
    if (note) note.textContent = '';
    if (hf && state && state.predictionOn) predictStart(m.id); else predictStop();
    renderDial();
    renderFavBtn();
    window.api.gateways(m.id, band).then(function (r) {
      if (seq !== loadSeq) return;
      predictStop();
      if (!r || !r.ok) { sel.innerHTML = favHtml + '<option value="">' + esc((r && r.error) || 'No list') + '</option>'; pendingPick = null; renderDial(); renderFavBtn(); return; }
      gateways = r.list || [];
      // The ranking is said on hover, not as a sentence beside the list (#254).
      sel.title = r.note || 'Gateways';
      // Keep what was picked while the list loaded (a favorite), if anything.
      var during = pickedGateway();
      lastList = r;
      buildGatewayOptions(r, during ? { call: during.call, khz: during.dialKhz } : null);
    });
  }

  // ── the radio's own dial (#254, like JTCAT): is it on the gateway? ─────────
  var dialHz = 0;
  function renderDial() {
    var num = $('wl-dial'), match = $('wl-dial-match'), btn = $('wl-retune');
    num.textContent = dialHz > 0 ? fmtDial(dialHz / 1000) : '\u2014';
    var g = pickedGateway();
    if (!g || !g.dialKhz || currentMode().id === 'telnet') { match.textContent = ''; btn.hidden = true; return; }
    var on = dialHz > 0 && Math.abs(dialHz / 1000 - Number(g.dialKhz)) < 0.05;
    match.className = 'wl-dial-match' + (on ? '' : ' off');
    match.textContent = on ? '\u2713 on ' + g.call : (dialHz > 0 ? g.call + ' is on ' + fmtDial(g.dialKhz) : '');
    var busy = $('wl-mode').disabled;
    btn.hidden = on || busy || !(dialHz > 0);
  }
  $('wl-retune').addEventListener('click', function () { var g = pickedGateway(); if (g && g.dialKhz) qsyTo(g.dialKhz); });
  if (window.api.onCatFrequency) window.api.onCatFrequency(function (hz) { dialHz = Number(hz) || 0; renderDial(); });

  // ── a good session ends with a card: save the gateway (#254) ──────────────
  // A radio session that did not finish gets the same card (#425): what
  // happened, what moved, what to do next, and Try again on the same gateway.
  // Every word on it is the shack's (session.outcome); nothing is worded here.
  var doneDismissed = '';
  function renderDoneCard(ss) {
    var card = $('wl-done-card');
    var r = ss && ss.state === 'done' ? ss.result : null;
    var bad = ss && ss.state === 'error' && ss.outcome && ss.outcome.retry && ss.mode !== 'telnet' && ss.gateway ? ss.outcome : null;
    var key = r ? r.call + '|' + r.dialKhz + '|' + (ss.startedAt || '') : bad ? 'ended|' + (ss.startedAt || '') : '';
    if ((!r && !bad) || key === doneDismissed || historyOpen) { card.classList.remove('show'); return; }
    card.classList.toggle('bad', !!bad);
    $('wl-done-retry').hidden = !bad;
    if (bad) {
      $('wl-done-title').textContent = bad.title;
      $('wl-done-sub').textContent = [bad.detail, bad.next].filter(Boolean).join(' ');
      $('wl-done-save').hidden = true;
      $('wl-done-saved').hidden = true;
      $('wl-done-close').textContent = 'OK';
      $('wl-done-close').onclick = function () { doneDismissed = key; card.classList.remove('show'); renderSession(ss); };
      $('wl-done-retry').onclick = function () {
        doneDismissed = key; card.classList.remove('show');
        requireNotice(function () {
          window.api.connect({ mode: ss.mode, gateway: ss.gateway, dialKhz: ss.dialKhz, url: ss.url || '' }).then(function (x) {
            if (x && !x.ok) { $('wl-text').textContent = x.error || 'Could not start'; $('wl-text').style.color = '#e94560'; }
          });
        });
      };
      card.classList.add('show');
      return;
    }
    $('wl-done-title').textContent = 'Mail exchanged with ' + r.call;
    $('wl-done-sub').textContent = [r.band, fmtDial(r.dialKhz) + ' MHz', MODE_SHORT[r.mode] || r.mode, r.sent + ' sent', r.received + ' received'].filter(Boolean).join(' \u00b7 ');
    $('wl-done-save').hidden = !!r.saved;
    $('wl-done-saved').hidden = !r.saved;
    $('wl-done-close').textContent = r.saved ? 'OK' : 'Not now';
    $('wl-done-close').onclick = function () { doneDismissed = key; card.classList.remove('show'); };
    $('wl-done-save').onclick = function () {
      $('wl-done-save').disabled = true;
      window.api.favourite('add', { call: r.call, mode: r.mode, dialKhz: r.dialKhz, url: r.url }).then(function (x) {
        $('wl-done-save').disabled = false;
        if (x && !x.ok && x.error) $('wl-done-sub').textContent = x.error;
      });
    };
    card.classList.add('show');
  }

  // ── gateway history (#254) ────────────────────────────────────────────────
  var historyOpen = false, histRows = [], histFilter = 'all';
  function openHistory() {
    historyOpen = true;
    $('wl-history-btn').classList.add('on');
    Array.prototype.forEach.call(document.querySelectorAll('.wl-folder'), function (x) { x.classList.remove('active'); });
    $('wl-list').style.display = 'none';
    document.querySelector('.wl-pane').style.display = 'none';
    $('wl-history').classList.add('show');
    $('wl-done-card').classList.remove('show');
    if (state && state.session) renderSession(state.session); // the bar says the whole sentence while the card is away
    $('wl-hist-body').innerHTML = '<div class="wl-empty">Reading the history…</div>';
    loadHistory();
  }
  function closeHistory() {
    historyOpen = false;
    $('wl-history-btn').classList.remove('on');
    $('wl-history').classList.remove('show');
    $('wl-list').style.display = '';
    document.querySelector('.wl-pane').style.display = '';
    Array.prototype.forEach.call(document.querySelectorAll('.wl-folder'), function (x) { x.classList.toggle('active', x.getAttribute('data-box') === box); });
    if (state && state.session) renderSession(state.session);
  }
  function loadHistory() {
    window.api.history().then(function (r) {
      if (!historyOpen) return;
      if (!r || !r.ok) { $('wl-hist-body').innerHTML = '<div class="wl-empty">' + esc((r && r.error) || 'Could not read the history') + '</div>'; return; }
      histRows = r.gateways || [];
      renderHistory();
    });
  }
  function renderHistory() {
    var find = $('wl-hist-find').value.trim().toUpperCase();
    var rows = histRows.filter(function (g) {
      if (histFilter === 'ok' && !g.good) return false;
      if (histFilter === 'no' && g.good) return false;
      return !find || String(g.call).indexOf(find) >= 0;
    });
    var hdr = '<div class="wl-hist-row hdr"><span></span><span>Gateway</span><span>Band, dial</span><span>Mode</span><span>Last tried</span><span>Connected</span><span>Last result</span></div>';
    if (!histRows.length) { $('wl-hist-body').innerHTML = '<div class="wl-empty">No gateway called yet. Every radio Send / Receive shows up here.</div>'; return; }
    if (!rows.length) { $('wl-hist-body').innerHTML = hdr + '<div class="wl-empty">Nothing matches.</div>'; return; }
    $('wl-hist-body').innerHTML = hdr + rows.map(function (g) {
      var i = histRows.indexOf(g);
      var saved = isFav(g, g.mode);
      return '<div class="wl-hist-row item" role="button" tabindex="0" data-h="' + i + '" title="Set band, gateway and dial to ' + esc(g.call) + '">'
        + '<button class="wl-hist-star" data-star="' + i + '" aria-label="' + (saved ? 'Remove ' + esc(g.call) + ' from your favorites' : 'Add ' + esc(g.call) + ' to your favorites') + '" title="' + (saved ? 'A favorite (click to remove it)' : 'Add to your favorites') + '">' + (saved ? STAR : STAR_EMPTY) + '</button>'
        + '<span class="call">' + esc(g.call) + '</span>'
        + '<span><span class="dim">' + esc(g.band || '') + '</span> <span class="mono">' + esc(fmtDial(g.dialKhz)) + '</span></span>'
        + '<span>' + esc(MODE_SHORT[g.mode] || g.mode) + '</span>'
        + '<span class="mono" style="font-size:13px">' + esc(fmtUtc(g.lastAt)) + '</span>'
        + '<span class="' + (g.good ? 'good' : 'dim') + '">' + g.good + ' of ' + g.tries + '</span>'
        + '<span class="res" title="' + esc(g.lastResult) + '">' + esc(g.lastResult) + '</span></div>';
    }).join('');
  }
  $('wl-history-btn').addEventListener('click', function () { if (historyOpen) closeHistory(); else openHistory(); });
  Array.prototype.forEach.call(document.querySelectorAll('.wl-pill[data-hf]'), function (p) {
    p.addEventListener('click', function () {
      histFilter = p.getAttribute('data-hf');
      Array.prototype.forEach.call(document.querySelectorAll('.wl-pill[data-hf]'), function (x) { x.classList.toggle('on', x === p); });
      renderHistory();
    });
  });
  $('wl-hist-find').addEventListener('input', renderHistory);
  $('wl-hist-body').addEventListener('click', function (e) {
    var star = e.target.closest('.wl-hist-star');
    if (star) {
      e.stopPropagation();
      var g = histRows[parseInt(star.getAttribute('data-star'), 10)];
      if (g) window.api.favourite(isFav(g, g.mode) ? 'remove' : 'add', { call: g.call, mode: g.mode, dialKhz: g.dialKhz, url: g.url });
      return;
    }
    var row = e.target.closest('.wl-hist-row.item');
    if (row) useGateway(histRows[parseInt(row.getAttribute('data-h'), 10)]);
  });
  $('wl-hist-body').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.closest('.wl-hist-star')) return;
    var row = e.target.closest('.wl-hist-row.item');
    if (row) useGateway(histRows[parseInt(row.getAttribute('data-h'), 10)]);
  });

  $('wl-connect').addEventListener('click', function () {
    requireNotice(function () {
      var m = currentMode();
      var o = { mode: m.id };
      if (m.id !== 'telnet') {
        var g = pickedGateway();
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
    // Said only when there is something to do (Casey 2026-11-11: "Radio sound:
    // via POTACAT" on every visit told the operator nothing). Working audio is
    // silent; a device to choose or an audio fault is said, with its action.
    if (currentMode().id === 'packet' && a.packet && a.packet.needed && !a.packet.ready) {
      el.innerHTML = 'Radio sound not set · <a id="wl-sound-change">Choose</a>';
      var ch = $('wl-sound-change');
      if (ch) ch.onclick = function () { openSoundCard(null); };
      return;
    }
    // Everything else rides POTACAT: the Flex Direct / Icom Network stream, or
    // the audio bridge on the radio's own sound card (the devices FT8 uses).
    var b = a.bridge || null;
    if (b && b.state === 'error') { el.innerHTML = '<span style="color:var(--accent-red-text, var(--accent-red, #e94560))">Radio sound: ' + esc(b.error) + '</span>'; return; }
    el.textContent = '';
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

  // ── address book, chip fields and the two forms (Casey 2026-11-11) ───────
  var WC = window.WinlinkContacts;
  var PES = window.PotaEmailSpot;
  function contacts() { return (state && Array.isArray(state.contacts)) ? state.contacts : []; }
  function groups() { return (state && Array.isArray(state.contactGroups)) ? state.contactGroups : []; }
  function contactFor(addr) { var a = WC.normalizeAddress(addr); return contacts().find(function (c) { return c.address === a; }) || null; }
  var KIND_WORD = { winlink: 'Winlink', email: 'Email' };

  // One chip field per box: To, Cc, Also email to (addresses) and Parks (POTA references).
  var chipFields = {};
  function initChips(field, hiddenId, kind) {
    var box = document.querySelector('.wl-chips[data-field="' + field + '"]');
    var f = { field: field, box: box, list: box.querySelector('.wl-chip-list'), input: box.querySelector('.wl-chip-in'), hidden: $(hiddenId), kind: kind, items: [] };
    chipFields[field] = f;
    box.addEventListener('mousedown', function (e) { if (e.target === box || e.target === f.list) { e.preventDefault(); f.input.focus(); } });
    f.input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (sug.field === field && sug.rows.length) { e.preventDefault(); moveSuggest(e.key === 'ArrowDown' ? 1 : -1); } return; }
      if (e.key === 'Escape') { if (sug.field === field) { e.preventDefault(); hideSuggest(); } return; }
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
        if (sug.field === field && sug.on >= 0 && sug.rows[sug.on]) { e.preventDefault(); pickSuggest(sug.rows[sug.on]); return; }
        if (f.input.value.trim()) { if (e.key !== 'Tab') e.preventDefault(); commitTyped(field); }
        else if (e.key === 'Enter' && f.kind === 'park') e.preventDefault();
        return;
      }
      if (e.key === 'Backspace' && !f.input.value && f.items.length) { f.items.pop(); renderChips(field); showSuggest(field); }
    });
    f.input.addEventListener('input', function () {
      if (/[,;]/.test(f.input.value)) { commitTyped(field); return; }
      showSuggest(field);
    });
    f.input.addEventListener('focus', function () { showSuggest(field); });
    f.input.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== f.input) { commitTyped(field); if (sug.field === field) hideSuggest(); } }, 150); });
    f.list.addEventListener('click', function (e) {
      var x = e.target.closest('.wl-chip-x');
      if (!x) return;
      f.items.splice(parseInt(x.getAttribute('data-i'), 10), 1);
      renderChips(field);
      f.input.focus();
    });
  }
  function itemOk(f, it) { return f.kind === 'park' ? !!PES.parkRef(it) : !!WC.normalizeAddress(it); }
  function normItem(f, it) { return f.kind === 'park' ? (PES.parkRef(it) || String(it).toUpperCase().trim()) : (WC.normalizeAddress(it) || String(it).trim()); }
  function renderChips(field) {
    var f = chipFields[field];
    f.list.innerHTML = f.items.map(function (it, i) {
      var ok = itemOk(f, it);
      var c = f.kind === 'park' ? null : contactFor(it);
      var label = c && c.name ? c.name : it;
      var tip = f.kind === 'park' ? (ok ? it : it + ': not a POTA park reference (like US-1234)') : (ok ? it + (c && c.name ? ' (' + c.name + ')' : '') + ' · ' + KIND_WORD[WC.kindOf(it)] : it + ': not a callsign or an email address');
      return '<span class="wl-chip' + (ok ? '' : ' bad') + '" title="' + esc(tip) + '"><span class="wl-chip-name">' + esc(label) + '</span><button type="button" class="wl-chip-x" data-i="' + i + '" aria-label="Remove ' + esc(label) + '">&#10005;</button></span>';
    }).join('');
    f.hidden.value = f.kind === 'park' ? f.items.join(' ') : f.items.join(', ');
    if (f.onChange) f.onChange();
  }
  function addItems(field, list) {
    var f = chipFields[field];
    list.forEach(function (it) { var n = normItem(f, it); if (n && f.items.indexOf(n) < 0) f.items.push(n); });
    renderChips(field);
  }
  function commitTyped(field) {
    var f = chipFields[field];
    var parts = f.input.value.split(/[,;\s]+/).filter(Boolean);
    f.input.value = '';
    if (parts.length) addItems(field, parts);
  }
  function setChips(field, s) {
    var f = chipFields[field];
    f.items = [];
    f.input.value = '';
    addItems(field, String(s || '').split(/[,;\s]+/).filter(Boolean));
  }
  function chipValue(field) { commitTyped(field); return chipFields[field].hidden.value; }

  // Suggestions under an address field: saved contacts and groups first, then
  // everyone seen in the Inbox and Sent, best match first.
  var sug = { field: null, rows: [], on: -1 };
  function showSuggest(field) {
    var f = chipFields[field];
    if (f.kind !== 'address') return;
    var rows = WC.suggest(f.input.value, { contacts: contacts(), groups: groups(), lists: lists, mycall: state && state.mycall, exclude: f.items, limit: 8 });
    var el = $('wl-suggest');
    if (!rows.length || (!f.input.value.trim() && document.activeElement !== f.input)) { hideSuggest(); return; }
    sug = { field: field, rows: rows, on: f.input.value.trim() ? 0 : -1 };
    el.innerHTML = rows.map(function (r, i) {
      if (r.type === 'group') return '<button type="button" class="wl-sug" role="option" data-i="' + i + '"><span class="wl-sug-name">' + esc(r.name) + '</span><span class="wl-sug-addr">group of ' + r.members.length + '</span></button>';
      return '<button type="button" class="wl-sug" role="option" data-i="' + i + '">' + (r.name ? '<span class="wl-sug-name">' + esc(r.name) + '</span>' : '') + '<span class="wl-sug-addr">' + esc(r.address) + '</span><span class="wl-spacer"></span><span class="wl-kind">' + esc(KIND_WORD[r.kind] || '') + '</span></button>';
    }).join('');
    var pane = document.querySelector('.wl-pane').getBoundingClientRect(), b = f.box.getBoundingClientRect();
    el.style.left = Math.round(b.left - pane.left) + 'px';
    el.style.top = Math.round(b.bottom - pane.top + 4) + 'px';
    el.style.width = Math.round(Math.max(280, Math.min(420, b.width))) + 'px';
    el.hidden = false;
    paintSuggest();
  }
  function paintSuggest() {
    Array.prototype.forEach.call($('wl-suggest').querySelectorAll('.wl-sug'), function (b, i) { b.classList.toggle('on', i === sug.on); b.setAttribute('aria-selected', String(i === sug.on)); });
  }
  function moveSuggest(d) { sug.on = (sug.on + d + sug.rows.length) % sug.rows.length; paintSuggest(); }
  function hideSuggest() { $('wl-suggest').hidden = true; sug = { field: null, rows: [], on: -1 }; }
  function pickSuggest(r) {
    var field = sug.field;
    if (!field) return;
    chipFields[field].input.value = '';
    addItems(field, r.type === 'group' ? r.members : [r.address]);
    hideSuggest();
    chipFields[field].input.focus();
  }
  $('wl-suggest').addEventListener('mousedown', function (e) {
    var b = e.target.closest('.wl-sug');
    if (!b) return;
    e.preventDefault();
    pickSuggest(sug.rows[parseInt(b.getAttribute('data-i'), 10)]);
  });

  initChips('to', 'wl-c-to', 'address');
  initChips('cc', 'wl-c-cc', 'address');
  initChips('posalso', 'wl-pos-also', 'address');
  initChips('parks', 'wl-spot-parks', 'park');

  // ── the address book panel ──────────────────────────────────────────────
  var bookDelArmed = null;
  function openBook(edit) {
    hideSuggest();
    $('wl-book').hidden = false;
    $('wl-book-find').value = '';
    bookDelArmed = null;
    renderBook();
    if (edit) editContact(edit); else { $('wl-book-edit').hidden = true; $('wl-book-find').focus(); }
  }
  function closeBook() { $('wl-book').hidden = true; $('wl-book-edit').hidden = true; }
  function composeOpen() { return $('wl-compose').classList.contains('show'); }
  function renderBook() {
    var q = $('wl-book-find').value.trim().toLowerCase();
    var hit = function (s) { return !q || String(s || '').toLowerCase().indexOf(q) >= 0; };
    var cs = contacts().filter(function (c) { return hit(c.name) || hit(c.address) || hit(c.note); })
      .sort(function (a, b) { return (a.name || a.address).localeCompare(b.name || b.address); });
    var gs = groups().filter(function (g) { return hit(g.name) || g.members.some(hit); });
    var saved = {};
    contacts().forEach(function (c) { saved[c.address] = true; });
    var seen = WC.seenAddresses(lists, state && state.mycall).filter(function (s) { return !saved[s.address] && hit(s.address); })
      .sort(function (a, b) { return b.lastAt - a.lastAt; }).slice(0, 30);
    var addBtns = function (attr, val) {
      return composeOpen() ? '<button type="button" class="wl-btn" data-' + attr + '-to="' + esc(val) + '">To</button><button type="button" class="wl-btn" data-' + attr + '-cc="' + esc(val) + '">Cc</button>' : '';
    };
    var html = '';
    if (cs.length) {
      html += '<div class="wl-book-sec">Contacts</div>' + cs.map(function (c) {
        var armed = bookDelArmed === c.id;
        return '<div class="wl-book-row"><div class="wl-book-who"><span class="wl-sug-name">' + esc(c.name || c.address) + '</span><span class="wl-sug-addr">' + esc(c.address) + (c.note ? ' · ' + esc(c.note) : '') + '</span></div><span class="wl-kind">' + esc(KIND_WORD[c.kind]) + '</span>'
          + addBtns('addr', c.address)
          + '<button type="button" class="wl-btn" data-edit="' + esc(c.id) + '">Edit</button><button type="button" class="wl-btn" data-del="' + esc(c.id) + '" aria-label="Delete ' + esc(c.name || c.address) + '">' + (armed ? 'Delete?' : '&#10005;') + '</button></div>';
      }).join('');
    }
    if (gs.length) {
      html += '<div class="wl-book-sec">Groups</div>' + gs.map(function (g) {
        var armed = bookDelArmed === g.id;
        return '<div class="wl-book-row"><div class="wl-book-who"><span class="wl-sug-name">' + esc(g.name) + '</span><span class="wl-sug-addr">' + esc(g.members.join(', ')) + '</span></div>'
          + addBtns('group', g.id)
          + '<button type="button" class="wl-btn" data-gedit="' + esc(g.id) + '">Edit</button><button type="button" class="wl-btn" data-gdel="' + esc(g.id) + '" aria-label="Delete ' + esc(g.name) + '">' + (armed ? 'Delete?' : '&#10005;') + '</button></div>';
      }).join('');
    }
    if (seen.length) {
      html += '<div class="wl-book-sec">From your mail, not saved yet</div>' + seen.map(function (s) {
        return '<div class="wl-book-row"><div class="wl-book-who"><span class="wl-sug-addr">' + esc(s.address) + '</span></div><span class="wl-kind">' + esc(KIND_WORD[WC.kindOf(s.address)]) + '</span>'
          + addBtns('addr', s.address)
          + '<button type="button" class="wl-btn" data-save="' + esc(s.address) + '">Save</button></div>';
      }).join('');
    }
    $('wl-book-list').innerHTML = html || '<div class="wl-book-empty">' + (q ? 'Nothing matches.' : 'No contacts yet. Save someone with + New contact, or from a message you received with Add to address book.') + '</div>';
  }
  function editContact(c) {
    c = c || {};
    var box = $('wl-book-edit');
    box.hidden = false;
    box.innerHTML = '<form class="wl-form-grid" id="wl-ce-form"><label for="wl-ce-name">Name</label><input type="text" id="wl-ce-name" maxlength="60" placeholder="for example Mom, or W1AW ARES net control">'
      + '<label for="wl-ce-addr">Address</label><input type="text" id="wl-ce-addr" maxlength="120" placeholder="a callsign (Winlink) or an email address" spellcheck="false">'
      + '<label for="wl-ce-note">Note</label><input type="text" id="wl-ce-note" maxlength="200" placeholder="optional">'
      + '<span></span><span class="wl-form-inline"><button type="submit" class="wl-btn primary">Save contact</button><button type="button" class="wl-btn" id="wl-ce-cancel">Cancel</button><span class="wl-c-err" id="wl-ce-err"></span></span></form>';
    $('wl-ce-name').value = c.name || '';
    $('wl-ce-addr').value = c.address || '';
    $('wl-ce-note').value = c.note || '';
    $('wl-ce-cancel').onclick = function () { box.hidden = true; };
    $('wl-ce-form').onsubmit = function (e) {
      e.preventDefault();
      window.api.contact('save', { id: c.id || undefined, name: $('wl-ce-name').value, address: $('wl-ce-addr').value, note: $('wl-ce-note').value }).then(function (r) {
        if (!r || !r.ok) { $('wl-ce-err').textContent = (r && r.error) || 'Could not save it'; return; }
        box.hidden = true;
      });
    };
    (c.address ? $('wl-ce-name') : $('wl-ce-addr')).focus();
  }
  function editGroup(g) {
    g = g || {};
    var box = $('wl-book-edit');
    box.hidden = false;
    box.innerHTML = '<form class="wl-form-grid" id="wl-ge-form"><label for="wl-ge-name">Group name</label><input type="text" id="wl-ge-name" maxlength="60" placeholder="for example ARES net, or Family">'
      + '<label for="wl-ge-members">Addresses</label><input type="text" id="wl-ge-members" placeholder="callsigns and emails, separated by commas" spellcheck="false">'
      + '<span></span><span class="wl-form-inline"><button type="submit" class="wl-btn primary">Save group</button><button type="button" class="wl-btn" id="wl-ge-cancel">Cancel</button><span class="wl-c-err" id="wl-ge-err"></span></span></form>';
    $('wl-ge-name').value = g.name || '';
    $('wl-ge-members').value = (g.members || []).join(', ');
    $('wl-ge-cancel').onclick = function () { box.hidden = true; };
    $('wl-ge-form').onsubmit = function (e) {
      e.preventDefault();
      window.api.contactGroup('save', { id: g.id || undefined, name: $('wl-ge-name').value, members: WC.splitAddresses($('wl-ge-members').value) }).then(function (r) {
        if (!r || !r.ok) { $('wl-ge-err').textContent = (r && r.error) || 'Could not save it'; return; }
        box.hidden = true;
      });
    };
    $('wl-ge-name').focus();
  }
  $('wl-c-book').addEventListener('click', function () { openBook(null); });
  $('wl-book-close').addEventListener('click', closeBook);
  $('wl-book-find').addEventListener('input', renderBook);
  $('wl-book-new').addEventListener('click', function () { editContact({}); });
  $('wl-book-newgroup').addEventListener('click', function () { editGroup({}); });
  $('wl-book-list').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var a;
    if ((a = b.getAttribute('data-addr-to'))) { addItems('to', [a]); return; }
    if ((a = b.getAttribute('data-addr-cc'))) { addItems('cc', [a]); return; }
    if ((a = b.getAttribute('data-group-to')) || (a = b.getAttribute('data-group-cc'))) {
      var g = groups().find(function (x) { return x.id === a; });
      if (g) addItems(b.hasAttribute('data-group-to') ? 'to' : 'cc', g.members);
      return;
    }
    if ((a = b.getAttribute('data-save'))) { editContact({ address: a }); return; }
    if ((a = b.getAttribute('data-edit'))) { editContact(contacts().find(function (c) { return c.id === a; })); return; }
    if ((a = b.getAttribute('data-gedit'))) { editGroup(groups().find(function (g) { return g.id === a; })); return; }
    if ((a = b.getAttribute('data-del'))) {
      if (bookDelArmed !== a) { bookDelArmed = a; renderBook(); return; }
      bookDelArmed = null; window.api.contact('delete', { id: a }); return;
    }
    if ((a = b.getAttribute('data-gdel'))) {
      if (bookDelArmed !== a) { bookDelArmed = a; renderBook(); return; }
      bookDelArmed = null; window.api.contactGroup('delete', { id: a });
    }
  });

  // ── the forms share the reading pane with the reader and compose ────────
  function hideForms() {
    $('wl-form-pos').hidden = true;
    $('wl-form-spot').hidden = true;
    closeBook();
    hideSuggest();
  }
  function showForm(id) {
    hideForms();
    $('wl-reader').style.display = 'none';
    $('wl-compose').classList.remove('show');
    $(id).hidden = false;
  }

  // Position report: where it goes said plainly, the position editable, and
  // the same position as ordinary mail to whoever should know.
  function openPositionForm() {
    requireNotice(function () {
      showForm('wl-form-pos');
      var p = state && state.position;
      $('wl-pos-lat').value = p ? String(p.lat) : '';
      $('wl-pos-lon').value = p ? String(p.lon) : '';
      $('wl-pos-from').textContent = p
        ? 'Starting point: the center of grid square ' + p.grid + ', accurate to about ' + p.km + ' km. Type your exact position for a better fix.'
        : 'No grid square is set (Settings > Station). Type your position.';
      $('wl-pos-comment').value = '';
      setChips('posalso', '');
      $('wl-pos-err').textContent = '';
      $('wl-pos-lat').focus();
    });
  }
  $('wl-pos-cancel').addEventListener('click', function () { showReader('<div class="wl-empty">Pick a message.</div>'); });
  $('wl-form-pos').addEventListener('submit', function (e) {
    e.preventDefault();
    var lat = Number(String($('wl-pos-lat').value).trim()), lon = Number(String($('wl-pos-lon').value).trim());
    if (!isFinite(lat) || lat < -90 || lat > 90 || String($('wl-pos-lat').value).trim() === '') { $('wl-pos-err').textContent = 'Latitude is a number from -90 to 90, like 40.7291'; $('wl-pos-lat').focus(); return; }
    if (!isFinite(lon) || lon < -180 || lon > 180 || String($('wl-pos-lon').value).trim() === '') { $('wl-pos-err').textContent = 'Longitude is a number from -180 to 180, like -74.0416'; $('wl-pos-lon').focus(); return; }
    var comment = $('wl-pos-comment').value.trim();
    var also = chipValue('posalso');
    var bad = chipFields.posalso.items.filter(function (it) { return !WC.normalizeAddress(it); });
    if (bad.length) { $('wl-pos-err').textContent = bad[0] + ' is not a callsign or an email address'; return; }
    $('wl-pos-send').disabled = true;
    window.api.posreport({ lat: lat, lon: lon, comment: comment }).then(function (r) {
      if (!r || !r.ok) { $('wl-pos-send').disabled = false; $('wl-pos-err').textContent = (r && r.error) || 'Could not queue it'; return null; }
      if (!also) return { ok: true, n: 0 };
      var p = state && state.position;
      var body = 'My position: ' + lat.toFixed(4) + ', ' + lon.toFixed(4) + (p && p.grid ? ' (grid ' + p.grid + ')' : '') + '\n' + (comment ? comment + '\n' : '');
      return window.api.send({ to: also, cc: '', subject: 'Position report from ' + ((state && state.mycall) || ''), body: body, attachments: [] }).then(function (s) { return s && s.ok ? { ok: true, n: WC.splitAddresses(also).length } : s; });
    }).then(function (r) {
      $('wl-pos-send').disabled = false;
      if (!r) return;
      if (!r.ok) { $('wl-pos-err').textContent = 'The position report is in the Outbox, but the email could not be queued: ' + (r.error || 'unknown reason'); return; }
      showReader('<div class="wl-empty">Position report in the Outbox' + (r.n ? ', and an email with the same position to ' + r.n + (r.n === 1 ? ' address' : ' addresses') : '') + '. It goes out on the next Send / Receive.</div>');
    });
  });

  // POTA spot: fields in, the exact lines POTA receives shown before it goes.
  (function fillModes() {
    $('wl-spot-mode').innerHTML = PES.FORM_MODES.map(function (m) { return '<option>' + m + '</option>'; }).join('');
  })();
  function spotLines() {
    var call = String((state && state.mycall) || '').toUpperCase();
    var mhz = Number(String($('wl-spot-freq').value).trim());
    var mode = $('wl-spot-mode').value;
    var comment = $('wl-spot-comment').value.trim();
    return chipFields.parks.items.filter(function (r) { return !!PES.parkRef(r); }).map(function (ref) {
      return PES.spotLine({ call: call, ref: ref, freqKhz: mhz > 0 ? mhz * 1000 : 0, mode: mode, comment: comment });
    });
  }
  // Examples instead of a how-to (Casey 2026-11-11), in the operator's own
  // call: one park, then a 2-fer, which is one line per park.
  function renderSpotExamples() {
    var call = String((state && state.mycall) || 'K1ABC').toUpperCase();
    $('wl-spot-examples').textContent =
      'One park, CW on 40 m:\n'
      + '!' + call + ' POTA US-1449 7.025 CW\n\n'
      + 'A 2-fer, SSB on 20 m: one line per park\n'
      + '!' + call + ' POTA CA-0035 14.285 SSB\n'
      + '!' + call + ' POTA CA-0110 14.285 SSB';
  }
  function renderSpotPreview() {
    renderSpotExamples();
    var lines = spotLines();
    $('wl-spot-preview').textContent = lines.length ? lines.join('\n') : 'Add a park to see the spot line.';
    var bad = chipFields.parks.items.filter(function (r) { return !PES.parkRef(r); });
    $('wl-spot-err').textContent = bad.length
      ? bad.join(', ') + (bad.length === 1 ? ' is' : ' are') + ' not a POTA park reference, so ' + (bad.length === 1 ? 'it is' : 'they are') + ' left out. They look like US-1234.'
      : '';
  }
  chipFields.parks.onChange = renderSpotPreview;
  ['wl-spot-freq', 'wl-spot-comment'].forEach(function (id) { $(id).addEventListener('input', renderSpotPreview); });
  $('wl-spot-mode').addEventListener('change', renderSpotPreview);
  function openSpotForm(t) {
    t = t || {};
    requireNotice(function () {
      showForm('wl-form-spot');
      setChips('parks', (t.refs || []).join(' '));
      $('wl-spot-freq').value = t.freqKhz > 0 ? PES.formatFreqMhz(t.freqKhz) : '';
      $('wl-spot-freq-from').textContent = t.freqKhz > 0 ? 'where you are activating' : 'type the frequency you are on';
      var mode = String(t.mode || '').toUpperCase();
      if (mode && PES.FORM_MODES.indexOf(mode) < 0) $('wl-spot-mode').insertAdjacentHTML('beforeend', '<option>' + esc(mode) + '</option>');
      $('wl-spot-mode').value = mode || 'SSB';
      $('wl-spot-comment').value = t.comment || '';
      $('wl-spot-err').textContent = '';
      renderSpotPreview();
      (chipFields.parks.items.length ? $('wl-spot-freq') : chipFields.parks.input).focus();
    });
  }
  $('wl-spot-cancel').addEventListener('click', function () { showReader('<div class="wl-empty">Pick a message.</div>'); });
  $('wl-form-spot').addEventListener('submit', function (e) {
    e.preventDefault();
    commitTyped('parks');
    var items = chipFields.parks.items;
    var bad = items.filter(function (r) { return !PES.parkRef(r); });
    if (!items.length) { $('wl-spot-err').textContent = 'Add the park you are activating, like US-1234'; chipFields.parks.input.focus(); return; }
    if (bad.length) { $('wl-spot-err').textContent = bad[0] + ' is not a POTA park reference. They look like US-1234.'; return; }
    if (!(Number(String($('wl-spot-freq').value).trim()) > 0)) { $('wl-spot-err').textContent = 'The frequency is in MHz, like 14.074'; $('wl-spot-freq').focus(); return; }
    if (!(state && state.mycall)) { $('wl-spot-err').textContent = 'Set your callsign in Settings > Station first'; return; }
    var lines = spotLines();
    $('wl-spot-send').disabled = true;
    window.api.send({ to: PES.SPOT_ADDRESS, cc: '', subject: 'POTA spot', body: lines.join('\n'), attachments: [] }).then(function (r) {
      $('wl-spot-send').disabled = false;
      if (!r || !r.ok) { $('wl-spot-err').textContent = (r && r.error) || 'Could not queue it'; return; }
      showReader('<div class="wl-empty">' + (lines.length === 1 ? 'The POTA spot is' : lines.length + ' POTA spots are') + ' in the Outbox. ' + (lines.length === 1 ? 'It posts' : 'They post') + ' when the next Send / Receive delivers ' + (lines.length === 1 ? 'it' : 'them') + '.</div>');
    });
  });

  function refreshAddressBits() {
    if (!chipFields || !chipFields.to) return;
    if (!$('wl-book').hidden) renderBook();
    ['to', 'cc', 'posalso'].forEach(function (f) { renderChips(f); });
  }

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
