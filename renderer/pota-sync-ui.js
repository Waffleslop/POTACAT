// POTA.app Sync — Settings tab UI + status-bar pill.
//
// Mirrors the Cloud-Sync UI pattern (settings persisted via IPC; status pushed
// from main on every pull/toggle). Gated on an active POTACAT Cloud
// subscription — the Connect button disables with an explanatory message when
// the user isn't subscribed.
(function () {
  'use strict';

  const connectBtn = document.getElementById('pota-sync-connect');
  if (!connectBtn) return; // settings tab isn't in the DOM — nothing to wire

  const disconnectBtn = document.getElementById('pota-sync-disconnect');
  const enabledCheck = document.getElementById('pota-sync-enabled');
  const intervalSel = document.getElementById('pota-sync-interval');
  const syncNowBtn = document.getElementById('pota-sync-now');
  const disconnectedBlock = document.getElementById('pota-sync-disconnected');
  const connectedBlock = document.getElementById('pota-sync-connected');
  const controlsBlock = document.getElementById('pota-sync-controls');
  const userSpan = document.getElementById('pota-sync-user');
  const lastSpan = document.getElementById('pota-sync-last');
  const countSpan = document.getElementById('pota-sync-count');
  const errSpan = document.getElementById('pota-sync-error');
  const gateMsg = document.getElementById('pota-sync-gate-msg');
  const pill = document.getElementById('conn-pota');
  const pillDot = pill ? pill.querySelector('.conn-dot') : null;

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Returns: 'active' | 'trial' | 'inactive' | 'unknown' (cloud not reachable).
  // We fail-open on 'unknown' so users can connect even when the cloud module
  // isn't available (open-source builds) or the user isn't signed in yet.
  async function getSubState() {
    try {
      if (!window.api.cloudGetStatus) return 'unknown';
      const st = await window.api.cloudGetStatus();
      const sub = st && st.subscription;
      if (!sub) return 'unknown';
      if (sub.status === 'active' || sub.status === 'trial') return sub.status;
      return 'inactive';
    } catch { return 'unknown'; }
  }

  function fmtAgo(ts) {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
    return Math.floor(diff / 86_400_000) + 'd ago';
  }

  // ── Render ───────────────────────────────────────────────────────────────
  let subState = 'unknown'; // 'active' | 'trial' | 'inactive' | 'unknown'

  function render(st) {
    if (!st) return;

    if (st.connected) {
      disconnectedBlock.classList.add('hidden');
      connectedBlock.classList.remove('hidden');
      userSpan.textContent = st.connectedAs || 'POTA.app user';
      enabledCheck.checked = !!st.enabled;
      controlsBlock.classList.toggle('hidden', !st.enabled);
      intervalSel.value = String(st.intervalMin || 60);
      lastSpan.textContent = fmtAgo(st.lastPullAt);
      countSpan.textContent = st.lastCount || '—';
      if (st.lastError) {
        errSpan.textContent = st.lastError;
        errSpan.classList.remove('hidden');
      } else {
        errSpan.classList.add('hidden');
      }
    } else {
      disconnectedBlock.classList.remove('hidden');
      connectedBlock.classList.add('hidden');
      // Fail-open: button is only hard-disabled when we got a definite
      // 'inactive' response. 'unknown' leaves it enabled and shows a warning.
      const hardBlock = subState === 'inactive';
      connectBtn.disabled = hardBlock;
      if (hardBlock) {
        gateMsg.textContent = 'Requires an active POTACAT Cloud subscription.';
        gateMsg.classList.remove('hidden');
      } else if (subState === 'unknown') {
        gateMsg.textContent = 'Cloud subscription could not be verified — you can still try.';
        gateMsg.classList.remove('hidden');
      } else {
        gateMsg.classList.add('hidden');
      }
    }

    // Status-bar pill
    if (!pill) return;
    if (st.connected && st.enabled) {
      pill.classList.remove('hidden');
      pill.classList.toggle('syncing', !!st.syncing);
      if (st.lastError) {
        pill.classList.remove('connected');
        pill.classList.add('disconnected');
        pill.title = 'POTA.app: ' + st.lastError;
      } else {
        pill.classList.add('connected');
        pill.classList.remove('disconnected');
        pill.title = 'POTA.app synced ' + fmtAgo(st.lastPullAt) +
          (st.lastCount ? ' (' + st.lastCount + ' parks)' : '');
      }
    } else {
      pill.classList.add('hidden');
    }
  }

  async function refresh() {
    subState = await getSubState();
    try {
      const st = await window.api.potaSyncStatus();
      render(st);
    } catch (err) {
      console.warn('[pota-sync-ui] potaSyncStatus failed:', err);
    }
  }

  // ── Event wiring ─────────────────────────────────────────────────────────
  connectBtn.addEventListener('click', async () => {
    console.log('[pota-sync-ui] Connect clicked; subState =', subState);
    if (subState === 'inactive') {
      alert('POTA.app Sync requires an active POTACAT Cloud subscription.');
      return;
    }
    connectBtn.disabled = true;
    const orig = connectBtn.textContent;
    connectBtn.textContent = 'Signing in…';
    try {
      if (!window.api.potaSyncConnect) {
        alert('POTA.app Sync is unavailable: the desktop IPC method is missing. Please restart POTACAT.');
        return;
      }
      console.log('[pota-sync-ui] Invoking pota-sync-connect …');
      const res = await window.api.potaSyncConnect();
      console.log('[pota-sync-ui] Connect returned:', res);
      if (!res || !res.ok) {
        alert('Could not connect to POTA.app: ' + ((res && res.error) || 'sign-in not completed'));
      } else if (!res.pullOk) {
        alert('Connected, but initial sync failed: ' + (res.pullError || 'unknown') + '\n\nTry clicking Sync Now after confirming you are signed in.');
      }
    } catch (err) {
      console.error('[pota-sync-ui] Connect threw:', err);
      alert('POTA.app connect failed: ' + (err && err.message ? err.message : String(err)));
    } finally {
      connectBtn.textContent = orig;
      connectBtn.disabled = false;
      await refresh();
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    if (!confirm('Disconnect POTA.app? You will need to sign in again to resume syncing.')) return;
    await window.api.potaSyncDisconnect();
    await refresh();
  });

  enabledCheck.addEventListener('change', async () => {
    await window.api.potaSyncSetEnabled(enabledCheck.checked);
    await refresh();
  });

  intervalSel.addEventListener('change', async () => {
    await window.api.potaSyncSetInterval(parseInt(intervalSel.value, 10));
    await refresh();
  });

  syncNowBtn.addEventListener('click', async () => {
    syncNowBtn.disabled = true;
    const orig = syncNowBtn.textContent;
    syncNowBtn.textContent = 'Syncing…';
    try {
      const res = await window.api.potaSyncNow();
      if (!res || !res.ok) alert('Sync failed: ' + ((res && res.error) || 'unknown'));
    } finally {
      syncNowBtn.textContent = orig;
      syncNowBtn.disabled = false;
      await refresh();
    }
  });

  // Push updates from main — recompute pill + panel instantly on every pull
  if (window.api.onPotaSyncStatus) {
    window.api.onPotaSyncStatus((st) => render(st));
  }

  // Refresh subscription gate + status whenever the Cloud settings tab becomes
  // visible (same pattern cloud-ui.js uses for its own refresh).
  const obs = new MutationObserver(() => {
    const cloudFieldsets = document.querySelectorAll('[data-settings-tab="cloud"]');
    if (cloudFieldsets.length > 0 && !cloudFieldsets[0].classList.contains('hidden')) {
      refresh();
    }
  });
  obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  // Initial load (and paint the pill if already enabled + connected)
  refresh();
})();
