// Pair-request approval popout. Receives the pending request from
// main.js via window.api.onPairRequest, shows a 60s countdown, and
// reports the user's Approve/Deny click back via window.api.
'use strict';

(function () {
  const nameEl = document.getElementById('device-name');
  const metaEl = document.getElementById('device-meta');
  const iconEl = document.getElementById('device-icon');
  const fillEl = document.getElementById('countdown-fill');
  const labelEl = document.getElementById('countdown-label');
  const fpToggle = document.getElementById('fp-toggle');
  const fpEl = document.getElementById('fingerprint');
  const actionsEl = document.getElementById('actions');
  const approveBtn = document.getElementById('approve-btn');
  const denyBtn = document.getElementById('deny-btn');
  const okEl = document.getElementById('resolved-ok');
  const denyResolvedEl = document.getElementById('resolved-deny');

  let currentRequestId = null;
  let expiresAtMs = 0;
  let tickInterval = null;

  function platformIcon(p) {
    const s = String(p || '').toLowerCase();
    if (s.includes('ios') || s.includes('iphone') || s.includes('ipad')) return '📱';
    if (s.includes('android')) return '🤖';
    if (s.includes('mac') || s.includes('darwin')) return '💻';
    if (s.includes('win')) return '🖥️';
    return '📡';
  }

  function setExpired() {
    fillEl.style.width = '0%';
    labelEl.textContent = 'Expired';
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  }

  function tick() {
    const remainingMs = Math.max(0, expiresAtMs - Date.now());
    const pct = Math.max(0, Math.min(100, (remainingMs / 60000) * 100));
    fillEl.style.width = pct + '%';
    const secs = Math.ceil(remainingMs / 1000);
    labelEl.textContent = remainingMs <= 0 ? 'Expired' : ('Expires in ' + secs + ' s');
    if (remainingMs <= 0) setExpired();
  }

  if (window.api && window.api.onPairRequest) {
    window.api.onPairRequest((req) => {
      currentRequestId = req.requestId;
      expiresAtMs = req.expiresAt || (Date.now() + 60000);
      nameEl.textContent = req.deviceName || 'Unknown device';
      const platBits = [];
      if (req.devicePlatform) platBits.push(req.devicePlatform);
      if (req.addr) platBits.push('from ' + req.addr);
      metaEl.textContent = platBits.join(' · ');
      iconEl.textContent = platformIcon(req.devicePlatform);
      if (req.fingerprint) fpEl.textContent = req.fingerprint;
      actionsEl.classList.remove('hidden');
      okEl.classList.add('hidden');
      denyResolvedEl.classList.add('hidden');
      approveBtn.disabled = false;
      denyBtn.disabled = false;
      if (tickInterval) clearInterval(tickInterval);
      tick();
      tickInterval = setInterval(tick, 1000);
    });
  }

  if (window.api && window.api.onPairRequestExpired) {
    window.api.onPairRequestExpired((reason) => {
      setExpired();
      actionsEl.classList.add('hidden');
      if (reason === 'cancelled') {
        denyResolvedEl.textContent = 'The device cancelled the request.';
      } else {
        denyResolvedEl.textContent = 'Request expired. No action was taken.';
      }
      denyResolvedEl.classList.remove('hidden');
    });
  }

  fpToggle.addEventListener('click', () => {
    if (fpEl.classList.contains('hidden')) {
      fpEl.classList.remove('hidden');
      fpToggle.textContent = 'Hide cert fingerprint';
    } else {
      fpEl.classList.add('hidden');
      fpToggle.textContent = 'Show this station’s cert fingerprint';
    }
  });

  approveBtn.addEventListener('click', () => {
    if (!currentRequestId || approveBtn.disabled) return;
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    window.api.pairRequestApprove(currentRequestId);
    actionsEl.classList.add('hidden');
    okEl.classList.remove('hidden');
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    setTimeout(() => window.api.pairRequestCloseWindow(), 1200);
  });

  denyBtn.addEventListener('click', () => {
    if (!currentRequestId || denyBtn.disabled) return;
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    window.api.pairRequestDeny(currentRequestId);
    actionsEl.classList.add('hidden');
    denyResolvedEl.classList.remove('hidden');
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    setTimeout(() => window.api.pairRequestCloseWindow(), 1000);
  });
})();
