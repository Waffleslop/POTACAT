// POTA.app Profile — Settings tab UI.
//
// Reduced from the old "auto-sync the parks-worked CSV" feature to just
// signing in and displaying the user's pota.app activator/hunter counts.
// The actual worked-parks list is now built from the local QSO log
// (lib/pota-sync.js comment for the long story). No scheduler, no
// auto-pull, no error nag — just a sign-in + Refresh.
(function () {
  'use strict';

  const connectBtn = document.getElementById('pota-sync-connect');
  if (!connectBtn) return; // settings tab isn't in the DOM — nothing to wire

  const disconnectBtn = document.getElementById('pota-sync-disconnect');
  const refreshBtn = document.getElementById('pota-sync-now');
  const disconnectedBlock = document.getElementById('pota-sync-disconnected');
  const connectedBlock = document.getElementById('pota-sync-connected');
  const userSpan = document.getElementById('pota-sync-user');
  const lastSpan = document.getElementById('pota-sync-last');
  const errSpan = document.getElementById('pota-sync-error');
  const gateMsg = document.getElementById('pota-sync-gate-msg');
  const pill = document.getElementById('conn-pota');

  // Profile-stat fields
  const hunterParksEl = document.getElementById('pota-sync-hunter-parks');
  const hunterQsosEl  = document.getElementById('pota-sync-hunter-qsos');
  const actParksEl    = document.getElementById('pota-sync-act-parks');
  const actQsosEl     = document.getElementById('pota-sync-act-qsos');
  const actRunsEl     = document.getElementById('pota-sync-act-runs');
  const awardsEl      = document.getElementById('pota-sync-awards');
  const endorsementsEl = document.getElementById('pota-sync-endorsements');

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fmtAgo(ts) {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
    return Math.floor(diff / 86_400_000) + 'd ago';
  }

  function setVal(el, v) {
    if (!el) return;
    el.textContent = (v == null) ? '—' : (typeof v === 'number' ? v.toLocaleString() : String(v));
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render(st) {
    if (!st) return;

    if (st.connected) {
      disconnectedBlock.classList.add('hidden');
      connectedBlock.classList.remove('hidden');
      userSpan.textContent = st.connectedAs || 'POTA.app user';
      lastSpan.textContent = fmtAgo(st.lastRefreshAt);

      const p = st.profile || {};
      const h = p.hunter || {};
      const a = p.activator || {};
      setVal(hunterParksEl, h.parks);
      setVal(hunterQsosEl, h.qsos);
      setVal(actParksEl, a.parks);
      setVal(actQsosEl, a.qsos);
      setVal(actRunsEl, a.activations);
      setVal(awardsEl, p.awards);
      setVal(endorsementsEl, p.endorsements);

      if (st.lastError) {
        // Soft error — yellow-ish accent (set in CSS), not red. Worked-parks
        // detection from the local log keeps working regardless.
        errSpan.textContent = st.lastError;
        errSpan.classList.remove('hidden');
      } else {
        errSpan.classList.add('hidden');
      }
    } else {
      disconnectedBlock.classList.remove('hidden');
      connectedBlock.classList.add('hidden');
      gateMsg.classList.add('hidden');
    }

    // Status-bar pill — only show when connected; tooltip shows last-refresh.
    if (!pill) return;
    if (st.connected) {
      pill.classList.remove('hidden');
      pill.classList.toggle('syncing', !!st.syncing);
      pill.classList.add('connected');
      pill.classList.remove('disconnected');
      pill.title = 'POTA.app: ' + (st.connectedAs || 'connected') +
        ' (refreshed ' + fmtAgo(st.lastRefreshAt) + ')';
    } else {
      pill.classList.add('hidden');
    }
  }

  async function refresh() {
    try {
      const st = await window.api.potaSyncStatus();
      render(st);
    } catch (err) {
      console.warn('[pota-sync-ui] potaSyncStatus failed:', err);
    }
  }

  // ── Event wiring ─────────────────────────────────────────────────────────
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    const orig = connectBtn.textContent;
    connectBtn.textContent = 'Signing in…';
    try {
      if (!window.api.potaSyncConnect) {
        alert('POTA.app sign-in is unavailable: the desktop IPC method is missing. Please restart POTACAT.');
        return;
      }
      const res = await window.api.potaSyncConnect();
      if (!res || !res.ok) {
        alert('Could not sign in to POTA.app: ' + ((res && res.error) || 'sign-in not completed'));
      }
      // We deliberately don't show an alert if profile fetch fails — the
      // worked-parks list comes from the local log either way, and the
      // soft error in the panel is enough.
    } catch (err) {
      console.error('[pota-sync-ui] Connect threw:', err);
      alert('POTA.app sign-in failed: ' + (err && err.message ? err.message : String(err)));
    } finally {
      connectBtn.textContent = orig;
      connectBtn.disabled = false;
      await refresh();
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    if (!confirm('Sign out of POTA.app?')) return;
    await window.api.potaSyncDisconnect();
    await refresh();
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    const orig = refreshBtn.textContent;
    refreshBtn.textContent = 'Refreshing…';
    try {
      // Don't alert on failure — error is shown softly in the panel.
      // pota.app being briefly unreachable shouldn't yank a modal in
      // front of the user.
      await window.api.potaSyncNow();
    } finally {
      refreshBtn.textContent = orig;
      refreshBtn.disabled = false;
      await refresh();
    }
  });

  // Push updates from main — re-render panel + pill on every status change
  if (window.api.onPotaSyncStatus) {
    window.api.onPotaSyncStatus((st) => render(st));
  }

  // Refresh when the Cloud settings tab becomes visible. Watch the
  // fieldsets only (not document.body) — observing the body fired
  // thousands of class-change events at startup and produced lag.
  const cloudFieldsets = document.querySelectorAll('[data-settings-tab="cloud"]');
  if (cloudFieldsets.length > 0) {
    const obs = new MutationObserver(() => {
      if (!cloudFieldsets[0].classList.contains('hidden')) refresh();
    });
    for (const fs of cloudFieldsets) {
      obs.observe(fs, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Initial paint
  refresh();
})();
