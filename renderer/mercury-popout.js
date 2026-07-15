// Mercury HF-data chat/file popout renderer. No Node here — every command goes
// to main (which owns the MercuryClient) and every update arrives as an event.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var theirEl = $('mq-their');
  var connectBtn = $('mq-connect');
  var disconnectBtn = $('mq-disconnect');
  var abortBtn = $('mq-abort');
  var listenCb = $('mq-listen');
  var bwSel = $('mq-bw');
  var sendFileBtn = $('mq-sendfile');
  var stateEl = $('mq-state');
  var pttEl = $('mq-ptt');
  var busyEl = $('mq-busy');
  var snEl = $('mq-sn');
  var bitrateEl = $('mq-bitrate');
  var transcriptEl = $('mq-transcript');
  var txEl = $('mq-tx');
  var sendBtn = $('mq-send');
  var progressEl = $('mq-progress');
  var connNote = $('mq-conn-note');
  var myCallEl = $('mq-mycall');

  var TRANSCRIPT_CAP = 5000;
  var tncConnected = false;   // control socket up (modem reachable)
  var arqConnected = false;   // in an ARQ session
  var listening = false;

  // ---- window controls ----
  $('mq-min').addEventListener('click', function () { window.api.minimize(); });
  $('mq-max').addEventListener('click', function () { window.api.maximize(); });
  $('mq-close').addEventListener('click', function () { window.api.close(); });

  // ---- transcript ----
  function addLine(cls, who, text) {
    var div = document.createElement('div');
    div.className = 'mq-line ' + cls;
    if (who) {
      var w = document.createElement('span');
      w.className = 'mq-who';
      w.textContent = who + ': ';
      div.appendChild(w);
    }
    div.appendChild(document.createTextNode(text));
    transcriptEl.appendChild(div);
    while (transcriptEl.textContent.length > TRANSCRIPT_CAP && transcriptEl.firstChild && transcriptEl.firstChild !== div) {
      transcriptEl.removeChild(transcriptEl.firstChild);
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  function sys(text) { addLine('sys', '', text); }

  // ---- enable/disable by state ----
  function refreshControls() {
    connectBtn.disabled = !tncConnected || arqConnected;
    disconnectBtn.disabled = !arqConnected;
    abortBtn.disabled = !arqConnected;
    sendFileBtn.disabled = !arqConnected;
    txEl.disabled = !arqConnected;
    sendBtn.disabled = !arqConnected;
    theirEl.disabled = arqConnected;
    listenCb.disabled = !tncConnected || arqConnected;
    bwSel.disabled = !tncConnected;
  }

  function setState(name) {
    stateEl.textContent = name;
    stateEl.className = 'mq-state ' + name;
  }
  function deriveState() {
    if (!tncConnected) return setState('offline');
    if (arqConnected) return setState('connected');
    if (listening) return setState('listening');
    setState('idle');
  }

  // ---- commands ----
  connectBtn.addEventListener('click', function () {
    var their = (theirEl.value || '').trim().toUpperCase();
    if (!their) { theirEl.focus(); return; }
    setState('connecting');
    sys('Calling ' + their + '…');
    window.api.mercuryConnect(their);
  });
  disconnectBtn.addEventListener('click', function () { window.api.mercuryDisconnect(); sys('Disconnecting…'); });
  abortBtn.addEventListener('click', function () { window.api.mercuryAbort(); sys('Aborting link.'); });
  listenCb.addEventListener('change', function () { window.api.mercuryListen(listenCb.checked); });
  bwSel.addEventListener('change', function () { window.api.mercurySetBw(parseInt(bwSel.value, 10)); });

  function doSend() {
    var text = txEl.value.replace(/\s+$/, '');
    if (!text || !arqConnected) return;
    window.api.mercurySendText(text);
    txEl.value = '';
  }
  sendBtn.addEventListener('click', doSend);
  txEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  sendFileBtn.addEventListener('click', function () {
    window.api.mercurySendFile().then(function (res) {
      if (res && res.started) { addLine('file', '', '→ sending file "' + res.name + '" (' + res.size + ' bytes)'); }
    }).catch(function () {});
  });

  // ---- events from main ----
  window.api.onMercuryStatus(function (s) {
    tncConnected = !!(s && s.connected);
    connNote.textContent = tncConnected ? ('modem ready · ' + (s.host || '') + ':' + (s.port || '')) : (s && s.error ? s.error : 'modem not running');
    if (!tncConnected) { arqConnected = false; listening = false; listenCb.checked = false; }
    deriveState();
    refreshControls();
  });

  window.api.onMercurySession(function (d) {
    if (d.state === 'connected') {
      arqConnected = true;
      addLine('sys', '', '● Connected: ' + (d.source || '?') + ' ⇄ ' + (d.dest || '?') + ' @ BW' + (d.bandwidth || '?'));
    } else {
      arqConnected = false;
      addLine('sys', '', '○ Link ended.');
    }
    deriveState();
    refreshControls();
  });

  window.api.onMercuryLink(function (d) {
    if (d.ptt !== undefined) { pttEl.textContent = d.ptt ? 'TX' : 'RX'; pttEl.className = 'mq-ptt' + (d.ptt ? ' on' : ''); }
    if (d.busy !== undefined) { busyEl.textContent = d.busy ? 'CH busy' : 'CH clear'; busyEl.className = 'mq-busy' + (d.busy ? ' on' : ''); }
    if (d.sn !== undefined && d.sn !== null) snEl.textContent = d.sn + ' dB';
    if (d.bitrate !== undefined && d.bitrate !== null) bitrateEl.textContent = d.bitrate + ' bps';
    if (d.listening !== undefined) { listening = d.listening; listenCb.checked = d.listening; deriveState(); refreshControls(); }
  });

  window.api.onMercuryChat(function (d) {
    if (!d || d.text == null) return;
    addLine(d.dir === 'tx' ? 'tx' : 'rx', d.who || (d.dir === 'tx' ? 'me' : 'them'), d.text);
  });

  window.api.onMercuryFile(function (d) {
    if (!d) return;
    if (d.dir === 'rx' && d.done) {
      addLine('file', '', '← received "' + d.name + '" (' + d.size + ' bytes) → ' + (d.path || 'downloads'));
    } else if (d.progress != null) {
      progressEl.textContent = (d.dir === 'tx' ? 'sending ' : 'receiving ') + d.name + ': ' + d.progress + '%';
      if (d.done) setTimeout(function () { progressEl.textContent = ''; }, 2500);
    }
  });

  window.api.onPopoutTheme(function () { /* stylesheet vars already themed via boot script */ });

  // Double-click a callsign in the transcript to capture it as "their call".
  transcriptEl.addEventListener('dblclick', function () {
    var w = String(window.getSelection() || '').trim().toUpperCase();
    if (/^[A-Z0-9/]{3,15}$/.test(w) && /\d/.test(w) && /[A-Z]/.test(w) && !arqConnected) theirEl.value = w;
  });

  // ---- init ----
  window.api.getSettings().then(function (s) {
    myCallEl.textContent = (s.myCallsign || 'NOCALL').toUpperCase();
    if (s.mercuryBw) bwSel.value = String(s.mercuryBw);
    listenCb.checked = !!s.mercuryListen;
    listening = !!s.mercuryListen;
    deriveState();
    refreshControls();
  });
})();
