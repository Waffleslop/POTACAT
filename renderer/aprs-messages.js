// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window, A1: the Messages view. Conversations, the thread with each
// message's status (Waiting for APRS-IS, Sending try n of 5, Delivered,
// Rejected, No reply), and the compose box: To, the text with its 67-character
// counter, Send over Internet or Radio (A3), Send. Main
// (main.js aprsMessage*, lib/aprs-messenger.js) sends, retries and acks, and
// checks every send again; this shows its state. No pop-ups.
//
// A3: "Send over: Internet | Radio". Radio is enabled only while Listen on my
// radio is on and the radio gate allows it (main's aprs-rf state, the same as
// the radio beacon's button). A radio message's later tries are a press of
// Try again unless the operator turned on automatic retries; messages heard
// on the radio say "heard on radio".
//
// A view of its own (Map | Messages): the window's map, list and beacon hide
// while it shows. window.AprsMessagesView lets other parts (templates, A2)
// fill the compose box and add a button beside the To field.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var M = window.AprsMessage;
  var s = null;          // main's state (preload-aprs-popout.js onMessages)
  var view = 'map';
  var search = '';
  var lastThreadKey = '';
  var RM = window.AprsRfMessage;
  var rf = null;         // main's radio beacon state (preload onRf): the gate's answer for the Radio choice
  var over = 'internet'; // Send over
  try { if (localStorage.getItem('aprsSendOver') === 'radio') over = 'radio'; } catch (e) { /* no storage */ }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function clock(at) { var d = new Date(at); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function when(at) {
    if (!at) return '';
    var d = new Date(at), now = new Date();
    if (d.toDateString() === now.toDateString()) return clock(at);
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    if (now - d < 6 * 86400000) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  // ── the view switch ──────────────────────────────────────────────────────
  function setView(v) {
    view = v === 'messages' ? 'messages' : 'map';
    document.body.classList.toggle('aprs-view-messages', view === 'messages');
    $('aprs-msgs').classList.toggle('hidden', view !== 'messages');
    $('aprs-view-map').setAttribute('aria-pressed', String(view === 'map'));
    $('aprs-view-msgs').setAttribute('aria-pressed', String(view === 'messages'));
    try { localStorage.setItem('aprsView', view); } catch (e) { /* no storage */ }
    if (view === 'map') {
      window.api.messagesView('');
      var mapApi = window.aprsMapApi;
      if (mapApi && mapApi.map) setTimeout(function () { mapApi.map.invalidateSize(); }, 0);
    } else {
      var to = M.checkAddressee($('aprs-msgs-to').value);
      window.api.messagesView(s && s.viewing ? s.viewing : (to.ok ? to.call : ''));
    }
  }

  // ── the conversations ────────────────────────────────────────────────────
  function renderConvos() {
    var box = $('aprs-msgs-convos');
    var list = (s && s.convos) || [];
    var q = search.trim().toUpperCase();
    if (q) list = list.filter(function (c) { return c.call.indexOf(q) >= 0 || String(c.last).toUpperCase().indexOf(q) >= 0; });
    if (!list.length) {
      box.innerHTML = '<div class="aprs-msgs-empty">' + (q ? 'No conversation matches.' : 'No messages yet. Press New to write one.') + '</div>';
      return;
    }
    box.innerHTML = list.map(function (c) {
      var sel = s.viewing === c.call;
      var last = (c.lastDir === 'out' ? 'You: ' : '') + c.last;
      return '<button type="button" class="aprs-convo' + (sel ? ' sel' : '') + (c.unread ? ' aprs-convo-unread' : '') + '" data-call="' + esc(c.call) + '"' + (sel ? ' aria-current="true"' : '') + '>' +
        '<span class="aprs-convo-top"><span>' + esc(c.call) + (c.unread ? ' <span class="aprs-badge">' + c.unread + '</span>' : '') + '</span>' +
        '<span class="aprs-convo-when">' + esc(when(c.updatedAt)) + '</span></span>' +
        '<span class="aprs-convo-last">' + esc(last) + '</span></button>';
    }).join('');
  }

  // ── the thread ───────────────────────────────────────────────────────────
  function stateClass(st) {
    if (st === 'delivered') return 'st-ok';
    if (st === 'rejected' || st === 'failed') return 'st-bad';
    if (st === 'queued' || st === 'sending') return 'st-wait';
    return '';
  }
  function renderThread() {
    var body = $('aprs-msgs-thread');
    var call = s && s.viewing;
    $('aprs-msgs-title').textContent = call || 'New message';
    $('aprs-msgs-delete').classList.toggle('hidden', !call);
    var t = (s && s.thread) || [];
    $('aprs-msgs-sub').textContent = call ? (t.length === 1 ? '1 message' : t.length + ' messages') : 'Type a call in To and your message below.';
    var key = JSON.stringify(t.map(function (m) { return [m.lid, m.status || '']; }));
    if (key === lastThreadKey) return;
    var atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    lastThreadKey = key;
    body.innerHTML = t.map(function (m) {
      var meta;
      if (m.dir === 'in') {
        meta = esc(m.from) + ' · ' + esc(clock(m.at)) + ' · ' + (m.via === 'radio' ? '<span class="aprs-heard-rf">heard on radio</span>' : 'internet');
      } else {
        meta = esc(clock(m.at)) + ' · <span class="' + stateClass(m.state) + '">' + esc(m.status) + '</span>';
        // A3: a radio message between tries: one press, one more try on the radio.
        if (m.over === 'radio' && m.state === 'sending' && !m.radioBusy && m.tries < 5 && (m.waitingPress || !(s.radio && s.radio.autoRetry))) meta += ' <button type="button" data-retry="' + esc(m.lid) + '">Try again</button>';
        if (m.state === 'queued' || m.state === 'sending') meta += ' <button type="button" data-stop="' + esc(m.lid) + '">Stop</button>';
        if (m.state === 'failed' || m.state === 'stopped') meta += ' <button type="button" data-again="' + esc(m.lid) + '">Send again</button>';
      }
      return '<div class="aprs-bubble ' + m.dir + '"><div class="aprs-bubble-text">' + esc(m.text) + '</div>' +
        '<div class="aprs-bubble-meta">' + meta + '</div></div>';
    }).join('');
    if (atEnd || !body.dataset.call || body.dataset.call !== String(call)) body.scrollTop = body.scrollHeight;
    body.dataset.call = String(call || '');
  }

  // ── the compose box ──────────────────────────────────────────────────────
  var note = { text: '', bad: false };
  function renderCompose() {
    var to = M.checkAddressee($('aprs-msgs-to').value);
    var c = M.counter($('aprs-msgs-text').value);
    var count = $('aprs-msgs-count');
    count.textContent = c.label;
    count.classList.toggle('over', c.over);
    var callOk = !!(s && s.call);
    // A2: a template field still in the text (<GROUP>, <TEXT>) is for the operator to replace first.
    var left = window.AprsTemplates ? window.AprsTemplates.unfilled($('aprs-msgs-text').value) : [];
    // A3: Radio only while the gate allows it; when it stops allowing it, the choice goes back to Internet.
    var rc = RM.radioChoice(rf);
    if (over === 'radio' && !rc.enabled) over = 'internet';
    var radioBtn = $('aprs-msgs-over-radio');
    radioBtn.disabled = !rc.enabled;
    radioBtn.title = rc.enabled ? 'Send on your radio' : rc.why;
    radioBtn.setAttribute('aria-checked', String(over === 'radio'));
    $('aprs-msgs-over-net').setAttribute('aria-checked', String(over !== 'radio'));
    $('aprs-msgs-send').textContent = over === 'radio' ? 'Send on radio' : 'Send';
    $('aprs-msgs-send').disabled = !(to.ok && c.n > 0 && !c.over && callOk && s.link !== 'test-build' && !left.length);
    var n = $('aprs-msgs-note');
    var text = note.text;
    var bad = note.bad;
    if (!text) {
      if (!s) text = '';
      else if (!callOk) { text = s.sentence || 'Set your callsign in Settings first.'; bad = true; }
      else if (s.link === 'test-build') { text = 'This test build plays recorded packets and sends nothing to APRS-IS.'; bad = true; }
      else if (c.over) { text = 'The message is ' + c.n + ' characters; APRS takes at most ' + c.max + '.'; bad = true; }
      else if (left.length) { text = 'Replace ' + left.join(' and ') + ' before sending.'; bad = true; }
      else if (over === 'radio') text = radioNote(to);
      else text = 'Goes out over APRS-IS as ' + s.call + '. Retries at 30 s, 1, 2 and 5 min until ' + (to.ok ? to.call : 'the station') + ' acknowledges.' + (rc.enabled ? '' : ' Radio: ' + rc.why);
    }
    n.textContent = text;
    n.classList.toggle('bad', !!bad);
  }

  /** What a radio send does, before the press: band, frequency, the call, and who sends the retries. */
  function radioNote(to) {
    var r = (s && s.radio) || {};
    var who = to.ok ? to.call : 'the station';
    var where = r.bandLabel ? ' on ' + r.bandLabel + (r.mhz ? ', ' + r.mhz + ' MHz' : '') : '';
    var as = r.call ? ' as ' + r.call : '';
    var retries = r.autoRetry
      ? 'Tries again by itself at 30 s, 1, 2 and 5 min until ' + who + ' acknowledges.'
      : 'Each press sends it once. If ' + who + ' does not acknowledge, press Try again.';
    return 'Goes out on your radio' + where + as + '. ' + retries;
  }

  function setOver(v) {
    over = v === 'radio' ? 'radio' : 'internet';
    try { localStorage.setItem('aprsSendOver', over); } catch (e) { /* no storage */ }
    note = { text: '', bad: false };
    renderCompose();
  }

  function render() {
    var badge = $('aprs-msgs-badge');
    var u = s ? s.unread : 0;
    badge.textContent = u ? String(u) : '';
    badge.classList.toggle('hidden', !u);
    $('aprs-view-msgs').setAttribute('aria-label', 'Messages' + (u ? ', ' + u + ' unread' : ''));
    if (s && s.viewing && !$('aprs-msgs-to').value) $('aprs-msgs-to').value = s.viewing; // the open conversation is who you answer
    renderConvos();
    renderThread();
    renderCompose();
  }

  function send() {
    var to = $('aprs-msgs-to').value, text = $('aprs-msgs-text').value;
    $('aprs-msgs-send').disabled = true;
    window.api.messageSend(to, text, over).then(function (r) {
      if (r && r.ok) { $('aprs-msgs-text').value = ''; note = { text: '', bad: false }; }
      else note = { text: (r && r.sentence) || 'Not sent.', bad: true };
      renderCompose();
    }, function () { note = { text: 'Not sent.', bad: true }; renderCompose(); });
  }

  // ── events ───────────────────────────────────────────────────────────────
  $('aprs-view-map').addEventListener('click', function () { setView('map'); });
  $('aprs-view-msgs').addEventListener('click', function () { setView('messages'); });
  $('aprs-msgs-search').addEventListener('input', function (e) { search = e.target.value; renderConvos(); });
  $('aprs-msgs-new').addEventListener('click', function () {
    window.api.messagesView('');
    $('aprs-msgs-to').value = '';
    $('aprs-msgs-text').value = '';
    note = { text: '', bad: false };
    $('aprs-msgs-to').focus();
    renderCompose();
  });
  $('aprs-msgs-convos').addEventListener('click', function (e) {
    var b = e.target.closest('[data-call]');
    if (!b) return;
    $('aprs-msgs-to').value = b.getAttribute('data-call');
    note = { text: '', bad: false };
    window.api.messagesView(b.getAttribute('data-call'));
    $('aprs-msgs-text').focus();
  });
  $('aprs-msgs-thread').addEventListener('click', function (e) {
    var stop = e.target.closest('[data-stop]');
    if (stop) { window.api.messageStop(stop.getAttribute('data-stop')); return; }
    var retry = e.target.closest('[data-retry]');
    if (retry) {
      retry.disabled = true;
      window.api.messageRetry(retry.getAttribute('data-retry')).then(function (r) {
        if (!r || !r.ok) { note = { text: (r && r.sentence) || 'Not sent.', bad: true }; retry.disabled = false; renderCompose(); }
      }, function () { note = { text: 'Not sent.', bad: true }; retry.disabled = false; renderCompose(); });
      return;
    }
    var again = e.target.closest('[data-again]');
    if (again && s) {
      var m = (s.thread || []).filter(function (x) { return x.lid === again.getAttribute('data-again'); })[0];
      if (m) { $('aprs-msgs-to').value = m.to; $('aprs-msgs-text').value = m.text; note = { text: '', bad: false }; renderCompose(); $('aprs-msgs-text').focus(); }
    }
  });
  $('aprs-msgs-delete').addEventListener('click', function () { if (s && s.viewing) window.api.messagesDelete(s.viewing); });
  $('aprs-msgs-to').addEventListener('input', function () {
    note = { text: '', bad: false };
    var to = M.checkAddressee($('aprs-msgs-to').value);
    if (to.ok && s && s.convos.some(function (c) { return c.call === to.call; })) window.api.messagesView(to.call);
    renderCompose();
  });
  $('aprs-msgs-text').addEventListener('input', function () { note = { text: '', bad: false }; renderCompose(); });
  $('aprs-msgs-compose').addEventListener('submit', function (e) { e.preventDefault(); if (!$('aprs-msgs-send').disabled) send(); });

  window.api.onMessages(function (st) { s = st; render(); });
  $('aprs-msgs-over-net').addEventListener('click', function () { setOver('internet'); });
  $('aprs-msgs-over-radio').addEventListener('click', function () { if (RM.radioChoice(rf).enabled) setOver('radio'); });
  window.api.onRf(function (d) { rf = d; if (s) renderCompose(); });

  // A3: the two radio message settings in APRS settings (both off by default).
  window.api.onBeacon(function (d) {
    var st = d && d.settings;
    if (!st) return;
    $('aprs-rfmsg-retry').checked = st.radioMsgAutoRetry === true;
    $('aprs-rfmsg-ack').checked = st.radioMsgAutoAck === true;
  });
  $('aprs-rfmsg-retry').addEventListener('change', function (e) { window.api.beaconSet({ radioMsgAutoRetry: e.target.checked }); });
  $('aprs-rfmsg-ack').addEventListener('change', function (e) { window.api.beaconSet({ radioMsgAutoAck: e.target.checked }); });

  // For A2 (templates) and anything else that fills the box. Nothing here sends.
  window.AprsMessagesView = {
    setCompose: function (to, text, hint) {
      if (to != null) $('aprs-msgs-to').value = String(to).toUpperCase().slice(0, 9);
      if (text != null) $('aprs-msgs-text').value = String(text);
      note = { text: hint ? String(hint) : '', bad: false }; // A2: the template's one-line hint, until the first keystroke
      if (view !== 'messages') setView('messages');
      // The thread follows To: its conversation if there is one, else a new message.
      var a = M.checkAddressee($('aprs-msgs-to').value);
      var known = a.ok && s && s.convos.some(function (c) { return c.call === a.call; });
      window.api.messagesView(known ? a.call : '');
      renderCompose();
    },
    getCompose: function () { return { to: $('aprs-msgs-to').value, text: $('aprs-msgs-text').value }; },
    toolsSlot: function () { return $('aprs-msgs-tools-slot'); },
    rerender: function () { renderCompose(); },
    show: function () { setView('messages'); },
  };

  var saved = 'map';
  try { saved = localStorage.getItem('aprsView') || 'map'; } catch (e) { /* no storage */ }
  setView(saved);
  window.api.messagesGet();
})();
