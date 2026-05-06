// Pair Mobile App popout — generates a fresh pairing QR via IPC and shows it
// at a comfortable scanning size, with the same data also exposed as
// copyable fields above the QR. The fields are the source of truth: the QR
// is just a convenience layered on top, so a broken QR rendering doesn't
// block pairing. (KD2TJU on Linux Mint 22.3 v1.5.14 hit this — broken-image
// icon and no other path forward.)
(function() {
  'use strict';

  // Defensive: if the preload script failed to load (e.g. omitted from
  // the .asar bundle as in v1.5.14), window.api is undefined and every
  // subsequent line silently crashes. Show a visible error instead so
  // packaging regressions don't look like "QR is just broken".
  // (DavidWest 2026-05-05 hit this — preload-pair-popout.js was missing
  // from the v1.5.14 installer's app.asar. Fixed in package.json files
  // list, but this guard stays so the next missing preload is loud.)
  if (!window.api) {
    var errBanner = document.getElementById('pp-error');
    if (errBanner) {
      errBanner.style.display = '';
      errBanner.innerHTML = '';
      var m = document.createElement('div');
      m.textContent = 'Pairing window failed to initialize (preload script not loaded).';
      errBanner.appendChild(m);
      var h = document.createElement('div');
      h.className = 'pp-error-hint';
      h.textContent = 'This is a packaging bug — please update to the latest POTACAT release. If you\'re already on the latest, file a bug report at github.com/Waffleslop/POTACAT/issues with your version.';
      errBanner.appendChild(h);
    }
    return;
  }

  if (window.api.platform === 'darwin') {
    var ctrls = document.querySelector('.titlebar-controls');
    if (ctrls) ctrls.style.display = 'none';
  }

  var imgEl = document.getElementById('pp-qr-img');
  var svgEl = document.getElementById('pp-qr-svg');
  var fallbackNoteEl = document.getElementById('pp-qr-fallback-note');
  var ttlEl = document.getElementById('pp-ttl');
  var errEl = document.getElementById('pp-error');
  var progressEl = document.getElementById('pp-progress');
  var cardEl = document.getElementById('pp-qr-card');
  var regenBtn = document.getElementById('pp-regen-btn');
  var closeBtnHeader = document.getElementById('tb-close');
  var closeBtnFooter = document.getElementById('pp-close-btn');

  // Progress events fire from main during the cert-setup phase of
  // pair-QR generation (issuing Tailscale cert, restarting ECHOCAT).
  // The user sees live status instead of a stalled "Generating…".
  if (window.api.onPairQrProgress) {
    window.api.onPairQrProgress(function(msg) {
      if (!progressEl) return;
      progressEl.style.display = '';
      progressEl.textContent = msg;
    });
  }
  function hideProgress() {
    if (progressEl) { progressEl.style.display = 'none'; progressEl.textContent = ''; }
  }

  var manualHostEl = document.getElementById('pp-manual-host');
  var manualTokenEl = document.getElementById('pp-manual-token');
  var manualFpEl = document.getElementById('pp-manual-fp');
  var manualUrlEl = document.getElementById('pp-manual-url');

  var ttlInterval = null;

  // Show a hard error: big banner + hint line, fields blanked, QR card
  // hidden so the user doesn't see an empty broken-image icon next to
  // a useless empty form. The hint is built per error so the user
  // knows exactly what to do (enable ECHOCAT, restart, etc.).
  function showError(msg, hint) {
    // Paranoid: if the HTML somehow didn't include the error banner
    // (shouldn't happen, but if pp-error is missing the popout would
    // silently swallow every error message), at minimum log AND alert
    // so the user gets SOMETHING. Better to be noisy than silent.
    if (!errEl) {
      console.error('[pair-popout] errEl missing, falling back to alert:', msg, hint || '');
      try { alert(msg + (hint ? '\n\n' + hint : '')); } catch {}
      return;
    }
    errEl.innerHTML = '';
    var main = document.createElement('div');
    main.textContent = msg;
    errEl.appendChild(main);
    if (hint) {
      var h = document.createElement('div');
      h.className = 'pp-error-hint';
      h.textContent = hint;
      errEl.appendChild(h);
    }
    errEl.style.display = '';
    if (cardEl) cardEl.style.display = 'none';
  }
  function hideError() {
    errEl.style.display = 'none';
    errEl.innerHTML = '';
  }

  function showFallbackNote() {
    cardEl.style.display = '';
    imgEl.style.display = 'none';
    svgEl.style.display = 'none';
    fallbackNoteEl.style.display = '';
  }
  function hideFallbackNote() {
    fallbackNoteEl.style.display = 'none';
  }

  async function generate() {
    if (ttlInterval) { clearInterval(ttlInterval); ttlInterval = null; }
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generating…';
    try {
      var r = await window.api.echocatCreatePairingQr({});
      // Diagnostic: log the response shape so a user with DevTools open
      // can see exactly what came back. (K3SBP 2026-05-05: users were
      // reporting blank fields with no error banner; this surfaces the
      // raw IPC response so the failure mode is visible without a
      // stack-trace.)
      console.log('[pair-popout] IPC returned:', r ? {
        hasError: !!r.error,
        errorText: r.error || null,
        hasQrText: !!r.qrText,
        hasHost: !!r.host,
        hasToken: !!r.pairingToken,
        hasFingerprint: !!r.fingerprint,
        hasSvg: !!r.svg,
        hasDataUrl: !!r.dataUrl,
        qrError: r.qrError || null,
      } : 'null/undefined');
      // Defense: if IPC came back with nothing usable (no error, no
      // pairing data), surface that specifically so the user isn't
      // stranded with empty fields.
      if (!r || (!r.error && !r.qrText && !r.pairingToken && !r.host)) {
        showError(
          'Pairing data came back empty — desktop returned no token or URL.',
          'Restart POTACAT, make sure ECHOCAT is enabled in Settings, then try again. If this persists, open DevTools (Ctrl+Shift+I) → Console and send me what appears after "[pair-popout] IPC returned:".',
        );
        manualUrlEl.value = manualHostEl.value = manualTokenEl.value = manualFpEl.value = '';
        return;
      }
      // Hard error from main (server not running, qrcode module missing,
      // etc.) — show the message and clear stale fields so the user can't
      // paste expired values. Pick the most actionable hint from the
      // error text so users know exactly what to do.
      if (r && r.error) {
        var hint = '';
        if (/server is not running|enable it in settings/i.test(r.error)) {
          hint = 'Open Settings → ECHOCAT → check "Enable ECHOCAT remote access" (the box at the top), then come back here and tap Regenerate.';
        } else if (/qrcode module/i.test(r.error)) {
          hint = 'If you installed via .dmg / .exe / .AppImage, please file a bug report — this should never happen on a packaged build.';
        }
        showError(r.error, hint);
        manualUrlEl.value = manualHostEl.value = manualTokenEl.value = manualFpEl.value = '';
        return;
      }
      hideError();
      cardEl.style.display = '';

      // Cert setup finished (or wasn't needed); hide the progress
      // banner. Soft warnings (e.g. "Tailscale not detected") show
      // a non-blocking banner above the QR so the user still gets
      // the pair fields and can try anyway (browser pairing might
      // still work).
      hideProgress();
      if (r.warn && errEl) {
        errEl.innerHTML = '';
        var wmain = document.createElement('div');
        wmain.textContent = r.warn;
        errEl.appendChild(wmain);
        errEl.style.display = '';
      }

      // Populate the manual-pair fields FIRST, before any rendering work.
      // These are the source of truth: even if both QR formats fail to
      // render on this platform, the user can still copy these values.
      manualUrlEl.value = r.qrText || '';
      manualHostEl.value = r.host || '';
      manualTokenEl.value = r.pairingToken || '';
      manualFpEl.value = r.fingerprint || '';

      // Soft QR error (PNG + SVG both failed). Show a banner above the
      // QR area but DON'T touch the fields — the user can still pair.
      if (r.qrError) {
        showError('QR rendering failed on this build (' + r.qrError +
          '). Use the fields above to pair manually.');
      }

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
