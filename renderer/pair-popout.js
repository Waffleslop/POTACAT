// Pair Mobile App popout — generates a fresh pairing QR via IPC and shows it
// at a comfortable scanning size. A dedicated window so the user doesn't have
// to wrestle the Settings dialog's scrollbar to point a phone at it.
(function() {
  'use strict';

  if (window.api.platform === 'darwin') {
    var ctrls = document.querySelector('.titlebar-controls');
    if (ctrls) ctrls.style.display = 'none';
  }

  var imgEl = document.getElementById('pp-qr-img');
  var textEl = document.getElementById('pp-qr-text');
  var ttlEl = document.getElementById('pp-qr-ttl');
  var errEl = document.getElementById('pp-error');
  var cardEl = document.getElementById('pp-qr-card');
  var regenBtn = document.getElementById('pp-regen-btn');
  var closeBtnHeader = document.getElementById('tb-close');
  var closeBtnFooter = document.getElementById('pp-close-btn');

  var ttlInterval = null;

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = '';
    cardEl.style.display = 'none';
  }

  function hideError() {
    errEl.style.display = 'none';
    cardEl.style.display = '';
  }

  async function generate() {
    if (ttlInterval) { clearInterval(ttlInterval); ttlInterval = null; }
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generating…';
    try {
      var r = await window.api.echocatCreatePairingQr({});
      if (r && r.error) { showError(r.error); return; }
      hideError();
      imgEl.src = r.dataUrl;
      imgEl.style.opacity = '1';
      textEl.textContent = r.qrText;
      var remaining = r.ttlSeconds || 300;
      ttlEl.classList.remove('expired');
      function tick() {
        if (remaining <= 0) {
          ttlEl.textContent = 'Expired — click Regenerate.';
          ttlEl.classList.add('expired');
          imgEl.style.opacity = '0.3';
          clearInterval(ttlInterval);
          ttlInterval = null;
          return;
        }
        var m = Math.floor(remaining / 60);
        var s = String(remaining % 60).padStart(2, '0');
        ttlEl.textContent = 'Expires in ' + m + ':' + s;
        remaining--;
      }
      tick();
      ttlInterval = setInterval(tick, 1000);
    } catch (err) {
      showError('Pairing QR failed: ' + (err.message || err));
    } finally {
      regenBtn.disabled = false;
      regenBtn.textContent = 'Regenerate';
    }
  }

  regenBtn.addEventListener('click', generate);
  closeBtnHeader.addEventListener('click', function() { window.api.close(); });
  closeBtnFooter.addEventListener('click', function() { window.api.close(); });

  generate();
})();
