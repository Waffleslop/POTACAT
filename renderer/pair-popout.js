// Pair Mobile App popout — generates a fresh pairing QR via IPC and shows it
// at a comfortable scanning size, with the same data also exposed as
// copyable fields above the QR. The fields are the source of truth: the QR
// is just a convenience layered on top, so a broken QR rendering doesn't
// block pairing. (KD2TJU on Linux Mint 22.3 v1.5.14 hit this — broken-image
// icon and no other path forward.)
(function() {
  'use strict';

  if (window.api.platform === 'darwin') {
    var ctrls = document.querySelector('.titlebar-controls');
    if (ctrls) ctrls.style.display = 'none';
  }

  var imgEl = document.getElementById('pp-qr-img');
  var svgEl = document.getElementById('pp-qr-svg');
  var fallbackNoteEl = document.getElementById('pp-qr-fallback-note');
  var ttlEl = document.getElementById('pp-ttl');
  var errEl = document.getElementById('pp-error');
  var cardEl = document.getElementById('pp-qr-card');
  var regenBtn = document.getElementById('pp-regen-btn');
  var closeBtnHeader = document.getElementById('tb-close');
  var closeBtnFooter = document.getElementById('pp-close-btn');

  var manualHostEl = document.getElementById('pp-manual-host');
  var manualTokenEl = document.getElementById('pp-manual-token');
  var manualFpEl = document.getElementById('pp-manual-fp');
  var manualUrlEl = document.getElementById('pp-manual-url');

  var ttlInterval = null;

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = '';
  }
  function hideError() {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  function showFallbackNote() {
    cardEl.style.display = 'none';
    fallbackNoteEl.style.display = '';
  }
  function hideFallbackNote() {
    cardEl.style.display = '';
    fallbackNoteEl.style.display = 'none';
  }

  async function generate() {
    if (ttlInterval) { clearInterval(ttlInterval); ttlInterval = null; }
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generating…';
    try {
      var r = await window.api.echocatCreatePairingQr({});
      if (r && r.error) {
        showError(r.error);
        // Empty out manual fields so the user doesn't paste a stale value.
        manualUrlEl.value = manualHostEl.value = manualTokenEl.value = manualFpEl.value = '';
        return;
      }
      hideError();

      // Always populate the manual-pair fields first, regardless of QR
      // outcome. These are the source of truth.
      manualUrlEl.value = r.qrText || '';
      manualHostEl.value = r.host || '';
      manualTokenEl.value = r.pairingToken || '';
      manualFpEl.value = r.fingerprint || '';

      // Best-effort QR render. Try SVG first (no PNG codec, no data: URL),
      // verify it actually mounted, fall through to PNG dataUrl, fall
      // through to a "use the fields above" note. Pairing works regardless.
      hideFallbackNote();
      var qrShown = false;
      if (r.svg) {
        try {
          svgEl.innerHTML = r.svg;
          if (svgEl.querySelector('svg')) {
            svgEl.style.display = '';
            imgEl.style.display = 'none';
            qrShown = true;
          }
        } catch (svgErr) {
          // Fall through to PNG / fallback below.
          console.warn('[pair-popout] SVG inject failed:', svgErr.message);
        }
      }
      if (!qrShown && r.dataUrl) {
        // Wire onerror so a failing PNG decode collapses to fallback note.
        imgEl.onload = function() { /* nothing — visible by class */ };
        imgEl.onerror = function() {
          imgEl.onerror = null;
          imgEl.onload = null;
          showFallbackNote();
        };
        imgEl.src = r.dataUrl;
        imgEl.style.display = '';
        svgEl.style.display = 'none';
        qrShown = true; // optimistic; onerror flips to fallback if it fails
      }
      if (!qrShown) {
        showFallbackNote();
      }

      imgEl.style.opacity = '1';
      svgEl.style.opacity = '1';

      var remaining = r.ttlSeconds || 300;
      ttlEl.classList.remove('expired');
      function tick() {
        if (remaining <= 0) {
          ttlEl.textContent = 'Token expired — click Regenerate.';
          ttlEl.classList.add('expired');
          imgEl.style.opacity = '0.3';
          svgEl.style.opacity = '0.3';
          // Clear the per-token fields so the user can't paste a stale
          // value. Host + fingerprint stay (those don't expire).
          manualTokenEl.value = '';
          manualUrlEl.value = '';
          clearInterval(ttlInterval);
          ttlInterval = null;
          return;
        }
        var m = Math.floor(remaining / 60);
        var s = String(remaining % 60).padStart(2, '0');
        ttlEl.textContent = 'Token expires in ' + m + ':' + s;
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

  // Tap-to-copy. Uses navigator.clipboard with a hidden-textarea fallback
  // for older Electron builds that don't expose the modern API.
  function copyText(text, btn) {
    function done() {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function() { btn.textContent = prev; }, 1200);
    }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  document.querySelectorAll('button[data-copy]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = document.getElementById(btn.dataset.copy);
      if (target && target.value) copyText(target.value, btn);
    });
  });

  regenBtn.addEventListener('click', generate);
  closeBtnHeader.addEventListener('click', function() { window.api.close(); });
  closeBtnFooter.addEventListener('click', function() { window.api.close(); });

  generate();
})();
