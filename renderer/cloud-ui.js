/**
 * POTACAT Cloud Sync UI Logic
 *
 * Manages the Cloud settings tab: login/logout, subscription, sync controls,
 * progress display, and status pill updates.
 *
 * Loaded after app.js in index.html.
 */
(function () {
  'use strict';

  // ── DOM Elements ──────────────────────────────────────────────────

  const loginSection = document.getElementById('cloud-login-section');
  const accountSection = document.getElementById('cloud-account-section');
  const googleSignInBtn = document.getElementById('cloud-google-signin');
  const callsignInput = document.getElementById('cloud-callsign');
  const emailInput = document.getElementById('cloud-email');
  const passwordInput = document.getElementById('cloud-password');
  const loginError = document.getElementById('cloud-login-error');
  const emailSignInBtn = document.getElementById('cloud-email-signin');
  const emailRegisterBtn = document.getElementById('cloud-email-register');
  const signOutBtn = document.getElementById('cloud-signout-btn');
  const userCallsignSpan = document.getElementById('cloud-user-callsign');
  const userEmailSpan = document.getElementById('cloud-user-email');
  const subStatusSpan = document.getElementById('cloud-sub-status');
  const subLevelSpan = document.getElementById('cloud-sub-level');
  const trialInfoSpan = document.getElementById('cloud-trial-info');
  const subscribeSection = document.getElementById('cloud-subscribe-section');
  const subscribeBtn = document.getElementById('cloud-subscribe-btn'); // "Prefer Buy Me a Coffee?"
  const verifyBtn = document.getElementById('cloud-verify-btn');
  // Billing (lib/cloud-billing-ui.js decides; this file only draws).
  const billingStrip = document.getElementById('cloud-billing-strip');
  const manageRow = document.getElementById('cloud-manage-row');
  const manageBtn = document.getElementById('cloud-manage-btn');
  const accessThroughSpan = document.getElementById('cloud-access-through');
  const subscribeHeading = document.getElementById('cloud-subscribe-heading');
  const stripeButtons = document.getElementById('cloud-stripe-buttons');
  const subscribeMonthlyBtn = document.getElementById('cloud-subscribe-monthly');
  const subscribeYearlyBtn = document.getElementById('cloud-subscribe-yearly');
  const checkoutWait = document.getElementById('cloud-checkout-wait');
  const checkoutRefresh = document.getElementById('cloud-checkout-refresh');
  const stripeNote = document.getElementById('cloud-stripe-note');
  const bmacVerifyDetails = document.getElementById('cloud-bmac-verify');
  const uploadNudge = document.getElementById('cloud-upload-nudge');
  const uploadNudgeBtn = document.getElementById('cloud-upload-nudge-btn');
  const joinWebLink = document.getElementById('cloud-join-web-link');
  const Billing = window.CloudBillingUi || null;
  let _stripeConfigured = true;      // false after a 503 stripe_not_configured
  let _lastStatus = null;            // the last cloud-get-status payload
  let _lastBilling = null;           // subscription.billing, for the strip's button
  let _autoUploadAfterRegister = false; // set by openCloudSignup({autoUpload})
  const syncEnabledCheck = document.getElementById('cloud-sync-enabled');
  const syncControls = document.getElementById('cloud-sync-controls');
  const deviceNameInput = document.getElementById('cloud-device-name');
  const syncIntervalSelect = document.getElementById('cloud-sync-interval');
  const syncNowBtn = document.getElementById('cloud-sync-now');
  const initialUploadBtn = document.getElementById('cloud-initial-upload');
  const uploadProgress = document.getElementById('cloud-upload-progress');
  const uploadBar = document.getElementById('cloud-upload-bar');
  const uploadText = document.getElementById('cloud-upload-text');
  const qsoCountSpan = document.getElementById('cloud-qso-count');
  const deviceCountSpan = document.getElementById('cloud-device-count');
  const pendingCountSpan = document.getElementById('cloud-pending-count');
  const pendingOthersSpan = document.getElementById('cloud-pending-others');
  const lastSyncSpan = document.getElementById('cloud-last-sync');
  const downloadAdifBtn = document.getElementById('cloud-download-adif');
  const connCloudPill = document.getElementById('conn-cloud');
  const callsignEditLink = document.getElementById('cloud-callsign-edit-link');
  const callsignEditor = document.getElementById('cloud-callsign-editor');
  const callsignEditorText = document.getElementById('cloud-callsign-editor-text');
  const callsignEditInput = document.getElementById('cloud-callsign-input');
  const callsignSaveBtn = document.getElementById('cloud-callsign-save');
  const callsignCancelBtn = document.getElementById('cloud-callsign-cancel');
  const callsignStatus = document.getElementById('cloud-callsign-status');

  // ── State ─────────────────────────────────────────────────────────

  let isLoggedIn = false;
  let currentSyncStatus = 'idle';
  let _refreshingStatus = false;
  let accountCallsign = '';        // callsign on the Cloud account ('' = none set)
  let callsignEditorMode = null;   // 'missing' | 'change' | null (closed)

  // ── UI Helpers ────────────────────────────────────────────────────

  const loginSignout = document.getElementById('cloud-login-signout');
  const loginSignoutLink = document.getElementById('cloud-login-signout-link');
  // Sign Out moved to its own fieldset at the bottom of the Cloud tab — shown
  // only when signed in, hidden (with the login form) otherwise.
  const signOutFieldset = document.getElementById('cloud-signout-fieldset');

  function showLogin(hasStaleTokens) {
    loginSection.classList.remove('hidden');
    accountSection.classList.add('hidden');
    if (signOutFieldset) signOutFieldset.classList.add('hidden');
    isLoggedIn = false;
    accountCallsign = '';
    closeCallsignEditor();
    updateCloudPill('disconnected');
    if (loginSignout) loginSignout.classList.toggle('hidden', !hasStaleTokens);
  }

  function showAccount(user, subscription) {
    loginSection.classList.add('hidden');
    accountSection.classList.remove('hidden');
    if (signOutFieldset) signOutFieldset.classList.remove('hidden');
    isLoggedIn = true;

    accountCallsign = subscription?.callsign || user?.callsign || '';
    userCallsignSpan.textContent = accountCallsign;
    userEmailSpan.textContent = user?.email || 'unknown';
    if (callsignEditLink) callsignEditLink.classList.toggle('hidden', !accountCallsign);
    // No callsign on the account → open the editor unprompted; it's the
    // one fix for the tunnel's no_callsign refusal and the free trial.
    if (!accountCallsign) openCallsignEditor('missing');
    else if (callsignEditorMode === 'missing') closeCallsignEditor();

    renderBilling(subscription);
  }

  /**
   * The status pill, the billing strip, the subscribe section and the
   * manage row — all from one describeBilling() so they cannot disagree.
   * The server writes the sentence (billing.message); we choose where.
   */
  function renderBilling(subscription) {
    const d = Billing ? Billing.describeBilling(subscription, { stripeConfigured: _stripeConfigured }) : null;
    _lastBilling = (subscription && subscription.billing) || null;
    if (!d) {
      // No policy module (should not happen) — the old active/inactive view.
      const active = subscription && subscription.status === 'active';
      subStatusSpan.textContent = subscription?.status || 'inactive';
      subStatusSpan.className = 'status ' + (active ? 'connected' : 'disconnected');
      subscribeSection.style.display = active ? 'none' : '';
      updateCloudPill(active ? 'connected' : 'disconnected');
      return;
    }

    subStatusSpan.textContent = d.pill.text;
    subStatusSpan.className = 'status ' + d.pill.cls;
    subLevelSpan.textContent = (d.access && !d.trial && subscription?.level && d.provider !== 'stripe') ? `(${subscription.level})` : '';
    if (d.trialLine) {
      trialInfoSpan.textContent = d.trialLine.text;
      trialInfoSpan.className = 'cloud-trial-line' + (d.trialLine.urgent ? ' urgent' : '');
    } else {
      trialInfoSpan.className = 'hidden';
      trialInfoSpan.textContent = '';
    }
    updateCloudPill(d.access ? 'connected' : 'disconnected');

    if (billingStrip) {
      if (d.strip) {
        billingStrip.className = 'cloud-billing-strip ' + d.strip.tone;
        billingStrip.querySelector('.cbs-msg').textContent = d.strip.message;
        billingStrip.querySelector('.cbs-action').textContent = d.strip.actionLabel;
      } else {
        billingStrip.className = 'cloud-billing-strip hidden';
      }
    }

    if (manageRow) {
      const show = !!(d.manage || d.accessThrough);
      manageRow.classList.toggle('hidden', !show);
      if (manageBtn) {
        manageBtn.classList.toggle('hidden', !d.manage);
        if (d.manage) manageBtn.textContent = d.manage.label;
      }
      if (accessThroughSpan) accessThroughSpan.textContent = d.accessThrough || '';
    }

    subscribeSection.style.display = d.subscribe.show ? '' : 'none';
    if (subscribeHeading) subscribeHeading.textContent = d.subscribe.heading;
    if (stripeButtons) stripeButtons.classList.toggle('hidden', !d.subscribe.stripe);
    if (stripeNote) {
      stripeNote.classList.toggle('hidden', !d.subscribe.show);
      // With Stripe unavailable the BMAC link is the primary way to pay.
      if (subscribeBtn) subscribeBtn.textContent = d.subscribe.stripe ? 'Prefer Buy Me a Coffee?' : 'Subscribe on Buy Me a Coffee';
    }
    if (bmacVerifyDetails) bmacVerifyDetails.classList.toggle('hidden', !d.verify.show);
  }

  function showError(msg) {
    if (loginError) {
      loginError.textContent = msg;
      loginError.classList.remove('hidden');
      setTimeout(() => loginError.classList.add('hidden'), 8000);
    }
  }

  function updateCloudPill(state) {
    if (!connCloudPill) return;
    connCloudPill.classList.remove('hidden', 'connected', 'syncing');
    if (!isLoggedIn) {
      connCloudPill.classList.add('hidden');
      return;
    }
    if (state === 'syncing') {
      connCloudPill.classList.add('syncing');
    } else if (state === 'connected' || state === 'synced') {
      connCloudPill.classList.add('connected');
    }
    // Default (no class) = red dot / disconnected
  }

  function formatTimestamp(ts) {
    if (!ts) return 'never';
    const d = new Date(ts);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
    return d.toLocaleDateString();
  }

  async function refreshStatus() {
    if (_refreshingStatus) return;
    _refreshingStatus = true;
    try {
      const status = await window.api.cloudGetStatus();
      if (!status.loggedIn) {
        showLogin(!!status.error);
        return;
      }

      // Use subscription endpoint if available, fall back to user object from login
      const sub = status.subscription || {
        status: status.user?.subscriptionStatus || 'inactive',
        trialActive: status.user?.trialExpiresAt ? new Date(status.user.trialExpiresAt) > new Date() : false,
        trialDaysLeft: status.user?.trialExpiresAt ? Math.ceil((new Date(status.user.trialExpiresAt) - new Date()) / 86400000) : 0,
        trialExpiresAt: status.user?.trialExpiresAt,
        callsign: status.user?.callsign,
      };
      if (sub.status === 'inactive' && sub.trialActive) sub.status = 'trial';

      _lastStatus = status;
      showAccount(status.user, sub);
      renderUploadNudge(status, sub);

      if (status.sync) {
        qsoCountSpan.textContent = status.sync.totalQsos ?? '--';
        deviceCountSpan.textContent = status.sync.deviceCount ?? '--';
      } else {
        qsoCountSpan.textContent = '--';
        deviceCountSpan.textContent = '--';
      }
      pendingCountSpan.textContent = status.pendingChanges ?? 0;
      if (pendingOthersSpan) {
        // Another operator's unsent changes on this PC: shown, never sent
        // to this account (lib/sync-journal.js forOwner).
        const o = status.pendingForOthers;
        if (o && o.count > 0) {
          pendingOthersSpan.textContent = '+ ' + o.count + ' waiting for ' + (o.owners.length === 1 ? 'another account' : o.owners.length + ' other accounts');
          pendingOthersSpan.classList.remove('hidden');
        } else {
          pendingOthersSpan.classList.add('hidden');
        }
      }
      lastSyncSpan.textContent = formatTimestamp(status.lastSyncAt || status.lastSyncTimestamp || status.sync?.lastSyncAt);
    } catch (err) {
      console.error('Cloud status error:', err);
    } finally {
      _refreshingStatus = false;
    }
  }

  // ── Event Handlers ────────────────────────────────────────────────

  if (googleSignInBtn) {
    googleSignInBtn.addEventListener('click', async () => {
      googleSignInBtn.disabled = true;
      googleSignInBtn.textContent = 'Signing in...';
      try {
        const result = await window.api.cloudGoogleSignIn();
        if (result.error) {
          alert('Google sign-in failed: ' + result.error);
        } else {
          await refreshStatus();
        }
      } catch (err) {
        alert('Sign-in error: ' + err.message);
      } finally {
        googleSignInBtn.disabled = false;
        googleSignInBtn.textContent = 'Sign in with Google';
      }
    });
  }

  if (emailSignInBtn) {
    emailSignInBtn.addEventListener('click', async () => {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) return showError('Enter email and password');

      emailSignInBtn.disabled = true;
      try {
        const result = await window.api.cloudLogin(email, password);
        if (result.error) {
          showError(result.error);
        } else {
          passwordInput.value = '';
          await refreshStatus();
        }
      } finally {
        emailSignInBtn.disabled = false;
      }
    });
  }

  if (emailRegisterBtn) {
    emailRegisterBtn.addEventListener('click', async () => {
      const callsign = callsignInput ? callsignInput.value.trim().toUpperCase() : '';
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) return showError('Enter email and password');
      if (!callsign) return showError('Enter your callsign');
      if (password.length < 8) return showError('Password must be at least 8 characters');

      emailRegisterBtn.disabled = true;
      try {
        const result = await window.api.cloudRegister(email, password, callsign);
        if (result.error) {
          showError(result.error);
        } else {
          passwordInput.value = '';
          await refreshStatus();
          // From the Cloud prompt: the upload IS the activation event (half
          // of the trials that upload convert; none of the ones that do not),
          // so it runs now rather than waiting to be found as a button.
          if (_autoUploadAfterRegister) {
            _autoUploadAfterRegister = false;
            await runInitialUpload({ confirm: false });
          }
        }
      } finally {
        emailRegisterBtn.disabled = false;
      }
    });
  }

  // Sign-in vs create-account mode. Sign-in (default) only needs email +
  // password; creating an account also needs the callsign. Toggling hides the
  // callsign field in sign-in mode so the form doesn't look like it wants all
  // three at once. K3SBP 2026-06-10.
  const callsignLabel = document.getElementById('cloud-callsign-label');
  const signinActions = document.getElementById('cloud-signin-actions');
  const registerActions = document.getElementById('cloud-register-actions');
  const showRegisterLink = document.getElementById('cloud-show-register');
  const showSigninLink = document.getElementById('cloud-show-signin');
  function setCloudAuthMode(mode) {
    const reg = mode === 'register';
    if (callsignLabel) callsignLabel.classList.toggle('hidden', !reg);
    if (signinActions) signinActions.classList.toggle('hidden', reg);
    if (registerActions) registerActions.classList.toggle('hidden', !reg);
    if (loginError) loginError.classList.add('hidden');
  }
  if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); setCloudAuthMode('register'); });
  if (showSigninLink) showSigninLink.addEventListener('click', (e) => { e.preventDefault(); setCloudAuthMode('signin'); });

  // ── Account callsign (add when missing, or change) ────────────────
  // PUT /v1/auth/callsign via cloud-set-callsign. 'missing' opens by itself
  // from showAccount(); 'change' comes from the "Change callsign" link.

  function setCallsignStatus(msg, color) {
    if (!callsignStatus) return;
    callsignStatus.textContent = msg || '';
    callsignStatus.style.color = color || 'var(--text-secondary)';
    callsignStatus.classList.toggle('hidden', !msg);
  }

  async function openCallsignEditor(mode) {
    if (!callsignEditor || !callsignEditInput) return;
    // Already open in this mode — don't clobber what the user is typing
    // when refreshStatus() re-renders the account.
    if (callsignEditorMode === mode) return;
    callsignEditorMode = mode;
    if (callsignEditorText) {
      callsignEditorText.textContent = mode === 'missing'
        ? 'Your POTACAT Cloud account has no callsign. Add it to use the Cloud Tunnel, embeds, and your free trial.'
        : `Change the callsign on this account (currently ${accountCallsign}). Your Cloud Tunnel address moves with it, and you can change it once every 30 days.`;
    }
    if (callsignCancelBtn) callsignCancelBtn.classList.toggle('hidden', mode === 'missing');
    setCallsignStatus('');
    callsignEditInput.value = mode === 'change' ? accountCallsign : '';
    callsignEditor.classList.remove('hidden');
    if (mode === 'missing') {
      // Suggest the Station callsign — only a suggestion; saving is the
      // user's click (a club station's call may not be the account's).
      try {
        const settings = await window.api.getSettings();
        if (callsignEditorMode === 'missing' && !callsignEditInput.value && settings.myCallsign) {
          callsignEditInput.value = String(settings.myCallsign).toUpperCase();
        }
      } catch {}
    }
  }

  function closeCallsignEditor() {
    callsignEditorMode = null;
    if (callsignEditor) callsignEditor.classList.add('hidden');
    setCallsignStatus('');
  }

  if (callsignEditLink) {
    callsignEditLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (callsignEditorMode === 'change') closeCallsignEditor();
      else openCallsignEditor('change');
    });
  }
  if (callsignCancelBtn) callsignCancelBtn.addEventListener('click', closeCallsignEditor);
  if (callsignEditInput) {
    callsignEditInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && callsignSaveBtn) { e.preventDefault(); callsignSaveBtn.click(); }
    });
  }

  if (callsignSaveBtn) {
    callsignSaveBtn.addEventListener('click', async () => {
      const cs = (callsignEditInput.value || '').trim().toUpperCase();
      if (!cs) return setCallsignStatus('Enter your callsign.', 'var(--accent-red)');
      const previous = accountCallsign;
      if (previous && cs === previous) return closeCallsignEditor();
      if (previous && !confirm(`Change your POTACAT Cloud callsign from ${previous} to ${cs}?\n\nYour Cloud Tunnel address moves to ${cs.toLowerCase()}.potacat.com, so paired phones reconnect through the new address. You can change it again after 30 days.`)) return;

      callsignSaveBtn.disabled = true;
      setCallsignStatus('Saving…');
      try {
        const res = await window.api.cloudSetCallsign(cs);
        if (!res || res.error) {
          let msg = (res && res.error) || 'Could not save the callsign.';
          if (res && res.code === 'callsign_change_limited' && res.nextAllowedAt && !/\d{4}/.test(msg)) {
            msg += ` You can change it again on ${new Date(res.nextAllowedAt).toLocaleDateString()}.`;
          }
          setCallsignStatus(msg, 'var(--accent-red)');
          return;
        }
        closeCallsignEditor();
        await refreshStatus();
        if (res.trialGranted) alert(`Callsign ${cs} saved — your 30-day POTACAT Cloud free trial has started.`);
        // A rename revokes the old tunnel server-side. If this shack had it
        // on, re-provision now so it comes back under the new hostname
        // instead of cloudflared sitting on a dead token.
        if (previous && window.api.cloudTunnelGetState && window.api.cloudTunnelEnable) {
          const st = await window.api.cloudTunnelGetState().catch(() => null);
          if (st && st.enabled) {
            const r = await window.api.cloudTunnelEnable().catch(() => null);
            if (r && r.ok) renderTunnelState(r.state);
            else refreshTunnelState();
          }
        }
      } catch (err) {
        setCallsignStatus('Failed: ' + (err.message || err), 'var(--accent-red)');
      } finally {
        callsignSaveBtn.disabled = false;
      }
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      await window.api.cloudLogout();
      showLogin();
    });
  }

  if (subscribeBtn) {
    // "Prefer Buy Me a Coffee?" — the membership page, as before Stripe.
    subscribeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.cloudOpenSubscribe({ bmac: true });
    });
  }

  const bmacEmailInput = document.getElementById('cloud-bmac-email');
  const saveBmacEmailBtn = document.getElementById('cloud-save-bmac-email');
  if (saveBmacEmailBtn) {
    saveBmacEmailBtn.addEventListener('click', async () => {
      const bmacEmail = bmacEmailInput ? bmacEmailInput.value.trim() : '';
      if (!bmacEmail) return alert('Enter your BuyMeACoffee email');
      saveBmacEmailBtn.disabled = true;
      saveBmacEmailBtn.textContent = 'Verifying...';
      try {
        const result = await window.api.cloudSaveBmacEmail(bmacEmail);
        if (result.error) {
          alert(result.error);
        } else if (result.status === 'active') {
          alert('Membership verified! Cloud sync is now active.');
          await refreshStatus();
        } else {
          alert(result.message || 'No active membership found for that email on BuyMeACoffee.');
        }
      } finally {
        saveBmacEmailBtn.disabled = false;
        saveBmacEmailBtn.textContent = 'Save & Verify';
      }
    });
  }

  if (loginSignoutLink) {
    loginSignoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.api.cloudLogout();
      showLogin(false);
    });
  }

  // ── Embed widgets ──────────────────────────────────────────────────

  const embedBaseUrl = 'https://api.potacat.com/embed';
  const embedCopiedMsg = document.getElementById('cloud-embed-copied');

  async function getCallsignForEmbed() {
    // Try the UI first, then settings
    const fromUI = userCallsignSpan && userCallsignSpan.textContent.trim();
    if (fromUI) return fromUI;
    try {
      const settings = await window.api.getSettings();
      return settings.cloudUser?.callsign || settings.myCallsign || '';
    } catch { return ''; }
  }

  document.querySelectorAll('.cloud-embed-view').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const cs = await getCallsignForEmbed();
      if (!cs) return alert('No callsign found. Sign in to POTACAT Cloud first.');
      const widget = link.dataset.widget;
      const extra = link.dataset.extra || '';
      const url = `${embedBaseUrl}/${widget}/${cs}${extra}`;
      window.api.openExternal(url);
    });
  });

  document.querySelectorAll('.cloud-embed-copy').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const cs = await getCallsignForEmbed();
      if (!cs) return;
      const widget = link.dataset.widget;
      const extra = link.dataset.extra || '';
      const height = link.dataset.height || '150';
      const embedCode = `<iframe src="${embedBaseUrl}/${widget}/${cs}${extra}" style="border:none;width:400px;height:${height}px;" loading="lazy"></iframe>`;

      navigator.clipboard.writeText(embedCode).then(() => {
        if (embedCopiedMsg) {
          embedCopiedMsg.textContent = `Copied ${widget} embed to clipboard!`;
          embedCopiedMsg.classList.remove('hidden');
          setTimeout(() => embedCopiedMsg.classList.add('hidden'), 3000);
        }
      });
    });
  });

  const clearTokensBtn = document.getElementById('cloud-clear-tokens');
  if (clearTokensBtn) {
    clearTokensBtn.addEventListener('click', async () => {
      await window.api.cloudLogout();
      showLogin(false);
    });
  }

  // Signed out, would rather pay than trial: the potacat.com join page
  // (prefilled from the Station callsign) creates the account on payment.
  if (joinWebLink) {
    joinWebLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.cloudOpenJoinPage({ plan: 'monthly' });
    });
  }

  // ── Forgot password (POTACAT Cloud) ──
  // Inline mini-form. Calls public POST /v1/auth/forgot-password via
  // cloud-ipc → CloudSyncClient. Cloud always returns success — UI
  // shows the same "check your inbox" regardless of whether the email
  // is registered (enumeration defense).
  const forgotLink = document.getElementById('cloud-forgot-link');
  const forgotSection = document.getElementById('cloud-forgot-section');
  const forgotEmailInput = document.getElementById('cloud-forgot-email');
  const forgotSendBtn = document.getElementById('cloud-forgot-send');
  const forgotCancelBtn = document.getElementById('cloud-forgot-cancel');
  const forgotStatus = document.getElementById('cloud-forgot-status');
  function _gpForgotReset() {
    if (forgotSection) forgotSection.classList.add('hidden');
    if (forgotStatus) forgotStatus.textContent = '';
    if (forgotSendBtn) forgotSendBtn.disabled = false;
  }
  if (forgotLink && forgotSection) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      const wasHidden = forgotSection.classList.contains('hidden');
      forgotSection.classList.toggle('hidden');
      if (wasHidden && forgotEmailInput) {
        // Pre-fill from the sign-in email field if the user already typed there.
        const signInEmail = document.getElementById('cloud-email');
        if (signInEmail && signInEmail.value && !forgotEmailInput.value) {
          forgotEmailInput.value = signInEmail.value;
        }
        try { forgotEmailInput.focus(); } catch {}
      }
    });
  }
  if (forgotCancelBtn) {
    forgotCancelBtn.addEventListener('click', _gpForgotReset);
  }
  if (forgotSendBtn) {
    forgotSendBtn.addEventListener('click', async () => {
      const email = (forgotEmailInput && forgotEmailInput.value || '').trim();
      if (!email) {
        if (forgotStatus) {
          forgotStatus.textContent = 'Enter an email first.';
          forgotStatus.style.color = 'var(--accent-red)';
        }
        return;
      }
      forgotSendBtn.disabled = true;
      if (forgotStatus) {
        forgotStatus.textContent = 'Sending…';
        forgotStatus.style.color = 'var(--text-secondary)';
      }
      try {
        const res = await window.api.cloudForgotPassword(email);
        if (res && res.error) {
          // Status-coded errors get tailored copy. Cloud added the 404
          // 2026-06-01 so older builds silently returned 200 — a typo no
          // longer looks like a working flow that just doesn't send mail.
          // The old 409 ("sign in with Apple directly") is gone from the
          // server since 2026-08-14: an Apple/Google-only account gets the
          // link too, and completing it SETS a first password — the only
          // way such an account can ever sign in on the desktop (KC3SRV).
          let msg;
          if (res.status === 404) {
            msg = "No POTACAT Cloud account uses that email. Double-check the spelling, or sign up.";
          } else if (res.error === 'network') {
            msg = 'No connection. Check your network and try again.';
          } else {
            msg = res.message || ('Error: ' + res.error);
          }
          if (forgotStatus) {
            forgotStatus.textContent = msg;
            forgotStatus.style.color = 'var(--accent-red)';
          }
          forgotSendBtn.disabled = false;
          return;
        }
        if (forgotStatus) {
          // The server's text says whether the link RESETS a password or
          // SETS a first one for an Apple/Google account; keep it.
          forgotStatus.textContent = (res && res.message) || 'Check your inbox — link valid for 24h.';
          forgotStatus.style.color = 'var(--accent-green)';
        }
        // Re-enable after a beat so re-tries are possible if the email never arrives.
        setTimeout(() => { if (forgotSendBtn) forgotSendBtn.disabled = false; }, 3000);
      } catch (err) {
        if (forgotStatus) {
          forgotStatus.textContent = 'Failed: ' + (err.message || err);
          forgotStatus.style.color = 'var(--accent-red)';
        }
        forgotSendBtn.disabled = false;
      }
    });
  }

  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying...';
      try {
        const result = await window.api.cloudVerifySubscription();
        if (result.error) {
          alert('Verification failed: ' + result.error);
        } else if (result.status === 'active') {
          alert('Subscription verified! Cloud sync is now active.');
          await refreshStatus();
        } else {
          alert(result.message || 'No active subscription found. Make sure you use the same email on BuyMeACoffee.');
        }
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify Subscription';
      }
    });
  }

  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      syncNowBtn.disabled = true;
      syncNowBtn.textContent = 'Syncing...';
      try {
        const result = await window.api.cloudSyncNow();
        await refreshStatus();
        if (result.error) {
          alert('Sync failed: ' + result.error);
        } else {
          // Say what moved, so 'it says synced but my QSOs are not there' is
          // answerable. (Pending changes have their own counter.)
          const parts = [`sent ${result.pushed || 0}`, `received ${result.pulled || 0}`];
          if (result.conflicts) parts.push(`${result.conflicts} replaced by the cloud copy`);
          lastSyncSpan.textContent = `just now: ${parts.join(', ')}`;
        }
      } finally {
        syncNowBtn.disabled = false;
        syncNowBtn.textContent = 'Sync Now';
      }
    });
  }

  /**
   * The first upload of the local log. Shared by the Upload button (asks
   * first), the "not backed up yet" nudge and the Cloud prompt's sign-up
   * (which already promised the upload, so {confirm:false}).
   */
  async function runInitialUpload(opts) {
    const ask = !(opts && opts.confirm === false);
    const buttons = [initialUploadBtn, uploadNudgeBtn].filter(Boolean);
    buttons.forEach(b => { b.disabled = true; });
    if (initialUploadBtn) initialUploadBtn.textContent = 'Scanning log...';
    try {
      const prep = await window.api.cloudBulkPrepare();
      if (prep.error) {
        alert('Error reading log: ' + prep.error);
        return;
      }
      if (prep.qsoCount === 0) {
        if (ask) alert('No QSOs found in your log file.');
        return;
      }
      if (ask) {
        const msg = `Your log has ${prep.qsoCount.toLocaleString()} QSOs.\n\nEstimated upload time: ${prep.estimatedTime}.\n\nUpload to POTACAT Cloud?`;
        if (!confirm(msg)) return;
      }
      uploadProgress.classList.remove('hidden');
      uploadBar.value = 0;
      uploadText.textContent = `Uploading 0 / ${prep.qsoCount.toLocaleString()} QSOs...`;

      const result = await window.api.cloudBulkUpload();
      if (result.error) {
        alert('Upload failed: ' + result.error);
      } else {
        uploadText.textContent = `Done! ${result.imported.toLocaleString()} QSOs uploaded, ${result.duplicates.toLocaleString()} duplicates skipped.`;
        await refreshStatus();
      }
    } catch (err) {
      alert('Upload error: ' + err.message);
    } finally {
      buttons.forEach(b => { b.disabled = false; });
      if (initialUploadBtn) initialUploadBtn.textContent = 'Upload Existing Log';
      setTimeout(() => uploadProgress.classList.add('hidden'), 8000);
    }
  }

  if (initialUploadBtn) initialUploadBtn.addEventListener('click', () => runInitialUpload({ confirm: true }));
  if (uploadNudgeBtn) uploadNudgeBtn.addEventListener('click', () => runInitialUpload({ confirm: true }));

  /** "Your log is not backed up yet" — an account that has never uploaded. */
  function renderUploadNudge(status, sub) {
    if (!uploadNudge) return;
    const d = Billing ? Billing.decideUploadNudge({
      loggedIn: !!(status && status.loggedIn),
      subscription: sub,
      cloudQsos: status && status.sync ? status.sync.totalQsos : null,
      localQsos: status ? status.localQsos : null,
    }) : { show: false };
    uploadNudge.classList.toggle('hidden', !d.show);
    if (d.show) uploadNudge.querySelector('span').textContent = `Your log is not backed up yet: ${d.localQsos.toLocaleString()} QSOs live only on this PC.`;
  }

  if (downloadAdifBtn) {
    downloadAdifBtn.addEventListener('click', async () => {
      downloadAdifBtn.disabled = true;
      downloadAdifBtn.textContent = 'Downloading...';
      try {
        const result = await window.api.cloudDownloadAdif();
        if (result.error) {
          alert('Download failed: ' + result.error);
          // Account deleted / session unrecoverable — drop to the sign-in
          // form (keep the stale-token sign-out link as the escape hatch).
          if (result.needsSignIn) showLogin(true);
        } else if (!result.canceled) {
          alert('Cloud backup saved to: ' + result.filePath);
        }
      } finally {
        downloadAdifBtn.disabled = false;
        downloadAdifBtn.textContent = 'Download Cloud Backup (.adi)';
      }
    });
  }

  // ── IPC Event Listeners ───────────────────────────────────────────

  if (window.api.onCloudSyncStatus) {
    window.api.onCloudSyncStatus((data) => {
      currentSyncStatus = data.status;
      if (data.status === 'syncing') {
        updateCloudPill('syncing');
      } else if (data.status === 'synced') {
        updateCloudPill('connected');
        lastSyncSpan.textContent = 'just now';
      } else if (data.status === 'error') {
        updateCloudPill('error');
        console.error('Cloud sync error:', data.detail);
      }
    });
  }

  if (window.api.onCloudUploadProgress) {
    window.api.onCloudUploadProgress((data) => {
      if (data.phase === 'upload' && data.total > 0) {
        const pct = Math.round((data.current / data.total) * 100);
        uploadBar.value = pct;
        uploadText.textContent = `Uploading... chunk ${data.current} of ${data.total} (${pct}%)`;
      }
    });
  }

  // ── Settings persistence ─────────────────────────────────────────

  async function loadCloudSettings() {
    try {
      const settings = await window.api.getSettings();
      if (deviceNameInput && settings.cloudDeviceName) {
        deviceNameInput.value = settings.cloudDeviceName;
      }
      if (syncEnabledCheck) {
        syncEnabledCheck.checked = !!settings.cloudSyncEnabled;
      }
      if (syncIntervalSelect && settings.cloudSyncInterval) {
        syncIntervalSelect.value = String(settings.cloudSyncInterval);
      }
      if (bmacEmailInput && settings.cloudBmacEmail) {
        bmacEmailInput.value = settings.cloudBmacEmail;
      }
    } catch {}
  }

  // Save cloud-specific settings when the main settings save happens
  // Also save on change for immediate persistence
  if (deviceNameInput) {
    deviceNameInput.addEventListener('change', async () => {
      try {
        const settings = await window.api.getSettings();
        settings.cloudDeviceName = deviceNameInput.value.trim();
        await window.api.saveSettings(settings);
      } catch {}
    });
  }
  if (syncEnabledCheck) {
    syncEnabledCheck.addEventListener('change', async () => {
      try {
        const settings = await window.api.getSettings();
        settings.cloudSyncEnabled = syncEnabledCheck.checked;
        await window.api.saveSettings(settings);
      } catch {}
    });
  }
  if (syncIntervalSelect) {
    syncIntervalSelect.addEventListener('change', async () => {
      try {
        const settings = await window.api.getSettings();
        settings.cloudSyncInterval = parseInt(syncIntervalSelect.value, 10);
        await window.api.saveSettings(settings);
      } catch {}
    });
  }

  // ── Billing: subscribe, manage, the strip's button, the checkout wait ──
  //
  // Every Stripe URL opens from MAIN (lib/cloud-ipc.js) — the renderer's
  // open-external allow-list has no Stripe host and fails closed silently.

  async function startCheckout(plan, btn) {
    const buttons = [subscribeMonthlyBtn, subscribeYearlyBtn].filter(Boolean);
    buttons.forEach(b => { b.disabled = true; });
    const label = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Opening checkout…';
    try {
      const r = await window.api.cloudOpenSubscribe(plan);
      if (r && r.error === 'stripe_not_configured') {
        // Server has no Stripe key: the membership page is the way to pay.
        _stripeConfigured = false;
        if (_lastStatus) renderBilling(_lastStatus.subscription);
        return;
      }
      if (r && r.error === 'auth-required') { showLogin(false); return; }
      if (r && r.error) {
        alert('Could not open checkout: ' + (r.message || r.error) + '\n\nYou can also subscribe on Buy Me a Coffee.');
        return;
      }
      showCheckoutWait(true);
    } finally {
      buttons.forEach(b => { b.disabled = false; });
      if (btn) btn.textContent = label;
    }
  }
  if (subscribeMonthlyBtn) subscribeMonthlyBtn.addEventListener('click', () => startCheckout('monthly', subscribeMonthlyBtn));
  if (subscribeYearlyBtn) subscribeYearlyBtn.addEventListener('click', () => startCheckout('yearly', subscribeYearlyBtn));

  function showCheckoutWait(on) {
    if (checkoutWait) checkoutWait.classList.toggle('hidden', !on);
  }
  // "Refresh" beside the status pill — what the Stripe return page and the
  // welcome email tell a member to click if the card still shows the old
  // status (a payment made on potacat.com has no checkout watch here).
  const refreshLink = document.getElementById('cloud-refresh-link');
  if (refreshLink) {
    refreshLink.addEventListener('click', async (e) => {
      e.preventDefault();
      refreshLink.textContent = 'Checking…';
      try { await window.api.cloudRefreshSubscription(); await refreshStatus(); }
      finally { refreshLink.textContent = 'Refresh'; }
    });
  }
  if (checkoutRefresh) {
    checkoutRefresh.addEventListener('click', async (e) => {
      e.preventDefault();
      checkoutRefresh.textContent = 'Checking…';
      try { await window.api.cloudRefreshSubscription(); await refreshStatus(); }
      finally { checkoutRefresh.textContent = 'Refresh'; }
    });
  }
  // The watch lives in main; it tells us when the payment landed (or not).
  if (window.api.onCloudCheckoutState) {
    window.api.onCloudCheckoutState((st) => {
      if (!st) return;
      if (st.stripeConfigured === false) _stripeConfigured = false;
      showCheckoutWait(st.phase === 'waiting');
      if (st.phase === 'active' || st.phase === 'timeout') refreshStatus();
    });
  }
  // A status fetched anywhere (launch check, checkout watch, the web
  // bridge) repaints the card if it is open.
  if (window.api.onCloudBillingState) {
    window.api.onCloudBillingState((p) => {
      if (!p || !p.subscription || !isLoggedIn) return;
      if (_lastStatus) {
        _lastStatus.subscription = p.subscription;
        if (typeof p.localQsos === 'number') _lastStatus.localQsos = p.localQsos;
      }
      renderBilling(p.subscription);
      if (_lastStatus) renderUploadNudge(_lastStatus, p.subscription);
    });
  }

  if (manageBtn) {
    manageBtn.addEventListener('click', async () => {
      manageBtn.disabled = true;
      try {
        const r = await window.api.cloudOpenManage();
        if (r && r.error) alert('Could not open your billing page: ' + (r.message || r.error));
      } finally { manageBtn.disabled = false; }
    });
  }
  if (billingStrip) {
    billingStrip.querySelector('.cbs-action').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const r = await window.api.cloudOpenBillingAction(_lastBilling || {});
        if (r && r.error) alert('Could not open your billing page: ' + (r.message || r.error));
      } finally { btn.disabled = false; }
    });
  }

  /**
   * Open Settings › Cloud on the create-account form. Used by the Summary
   * card, the pairing panel, the share-rig notice and the Cloud prompt
   * (which also asks for the upload to run right after sign-up).
   */
  window.openCloudSignup = function (opts) {
    const o = opts || {};
    _autoUploadAfterRegister = !!o.autoUpload;
    const dlg = document.getElementById('settings-dialog');
    if (dlg && typeof dlg.showModal === 'function' && !dlg.open) {
      try { dlg.showModal(); } catch {}
    }
    const cloudTabBtn = document.querySelector('.settings-tab[data-tab="cloud"]');
    if (cloudTabBtn) cloudTabBtn.click();
    if (!isLoggedIn) {
      setCloudAuthMode(o.mode === 'signin' ? 'signin' : 'register');
      if (callsignInput && !callsignInput.value) {
        window.api.getSettings().then(s => {
          if (s && s.myCallsign && !callsignInput.value) callsignInput.value = String(s.myCallsign).toUpperCase();
        }).catch(() => {});
      }
      const first = (callsignInput && !callsignInput.value) ? callsignInput : emailInput;
      if (first) { try { first.focus(); } catch {} }
    } else if (subscribeSection && subscribeSection.style.display !== 'none') {
      subscribeSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (loginSection) loginSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Render hooks for a live check over DevTools (the contextBridge api
  // cannot be stubbed from the page). Read-only use; nothing calls them.
  window.__cloudUi = { showAccount, renderBilling, renderUploadNudge, showLogin };

  // ── Init ──────────────────────────────────────────────────────────

  // Load saved settings and refresh status when Cloud tab is shown.
  // Scope the observer narrowly: watching the dialog with subtree:true caused
  // a feedback loop because refreshStatus() mutates class attributes inside
  // the dialog (status pill, sub-status span, etc.), retriggering the observer.
  const cloudFieldsets = document.querySelectorAll('[data-settings-tab="cloud"]');
  const onCloudVisible = () => {
    if (cloudFieldsets.length > 0 && !cloudFieldsets[0].classList.contains('hidden') &&
        cloudFieldsets[0].offsetParent !== null) {
      loadCloudSettings();
      refreshStatus();
    }
  };
  const observer = new MutationObserver(onCloudVisible);

  const settingsDialog = document.getElementById('settings-dialog');
  if (settingsDialog) {
    observer.observe(settingsDialog, { attributes: true, attributeFilter: ['open'] });
  }
  // Observe ONLY the first cloud fieldset's class for the tab-visible toggle.
  // Watching every cloud fieldset re-fired this observer whenever
  // refreshStatus()/showAccount() toggled a `hidden` class on a cloud fieldset
  // (e.g. the Sign Out fieldset), looping refreshStatus and making the
  // "Cloud QSOs" count blink --/225. switchSettingsTab sets `tab-visible` on
  // ALL cloud fieldsets including [0], so [0] alone is a sufficient signal and
  // it's never mutated by refreshStatus. K3SBP 2026-06-10.
  if (cloudFieldsets[0]) {
    observer.observe(cloudFieldsets[0], { attributes: true, attributeFilter: ['class'] });
  }

  // Initial load
  setTimeout(() => { loadCloudSettings(); refreshStatus(); }, 2000);

  // ─────────────────────────────────────────────────────────────────
  // POTACAT Cloud (CF tunnel) — one-tap remote toggle
  // ─────────────────────────────────────────────────────────────────
  //
  // Backend: lib/cloud-tunnel.js (CloudTunnelManager). IPC:
  //   cloudTunnelGetState()  → { enabled, status, cloudHost, lastError, ... }
  //   cloudTunnelEnable()    → { ok, state } | { error: 'entitlement-required' | ... }
  //   cloudTunnelDisable()   → { ok, state } | { error }
  //   onCloudTunnelState(cb) → live 'change' events from the manager
  // The tray indicator (#36) sends 'open-settings-panel' { panel:
  // 'cloud-tunnel' } when the user clicks the tray row — we scroll the
  // fieldset into view here.

  const ctFieldset = document.getElementById('cloud-tunnel-fieldset');
  const ctStatusPill = document.getElementById('cloud-tunnel-status-pill');
  const ctHost = document.getElementById('cloud-tunnel-host');
  const ctEnableBtn = document.getElementById('cloud-tunnel-enable-btn');
  const ctDisableBtn = document.getElementById('cloud-tunnel-disable-btn');
  const ctError = document.getElementById('cloud-tunnel-error');
  const ctDegraded = document.getElementById('cloud-tunnel-degraded');
  const ctDegradedText = document.getElementById('cloud-tunnel-degraded-text');
  const ctOrigin = document.getElementById('cloud-tunnel-origin');
  // Start-at-login offer (§5 of the launch-defaults handoff). A tunnel only
  // comes back after a reboot if POTACAT does; the launcher only helps if it
  // is running. Both are OS login items, so neither is ever added silently —
  // they are OFFERED here, at the one moment they matter, and stay offered
  // (quietly) while the tunnel is on and POTACAT is not set to start at
  // login. "Not now" hides it for this session only.
  const ctStartup = document.getElementById('cloud-tunnel-startup');
  const ctStartupLauncher = document.getElementById('cloud-tunnel-startup-launcher');
  const ctStartupOn = document.getElementById('cloud-tunnel-startup-on');
  const ctStartupNotNow = document.getElementById('cloud-tunnel-startup-not-now');
  const ctStartupDone = document.getElementById('cloud-tunnel-startup-done');
  let startupOfferDismissed = false;
  try { startupOfferDismissed = sessionStorage.getItem('ct-startup-offer-dismissed') === '1'; } catch {}

  /** Show the offer iff the tunnel is on, POTACAT is not a login item, and it was not dismissed this session. */
  async function refreshStartupOffer(state) {
    if (!ctStartup || !window.api || !window.api.getSettings) return;
    if (!state || !state.enabled || startupOfferDismissed) { ctStartup.classList.add('hidden'); return; }
    let s = null;
    try { s = await window.api.getSettings(); } catch {}
    if (!s || s.launchAtStartup === true) { ctStartup.classList.add('hidden'); return; }
    if (ctStartupDone) ctStartupDone.classList.add('hidden');
    ctStartup.classList.remove('hidden');
  }

  if (ctStartupOn) {
    ctStartupOn.addEventListener('click', async () => {
      ctStartupOn.disabled = true;
      try {
        const wantLauncher = !!(ctStartupLauncher && ctStartupLauncher.checked);
        // launchAtStartup is applied live at the OS by main on save.
        await window.api.saveSettings({ launchAtStartup: true });
        let note = 'POTACAT will start when this computer starts.';
        if (wantLauncher && window.api.launcherInstall) {
          const r = await window.api.launcherInstall();
          note += (r && r.ok) ? ' The Remote Launcher is installed too.' : ' (The Remote Launcher could not be installed: ' + ((r && r.error) || 'unknown error') + ')';
        }
        if (ctStartupDone) { ctStartupDone.textContent = note; ctStartupDone.classList.remove('hidden'); }
        setTimeout(() => { if (ctStartup) ctStartup.classList.add('hidden'); }, 4000);
      } finally {
        ctStartupOn.disabled = false;
      }
    });
  }
  if (ctStartupNotNow) {
    ctStartupNotNow.addEventListener('click', () => {
      startupOfferDismissed = true;
      try { sessionStorage.setItem('ct-startup-offer-dismissed', '1'); } catch {}
      if (ctStartup) ctStartup.classList.add('hidden');
    });
  }
  const ctOriginTitle = document.getElementById('cloud-tunnel-origin-title');
  const ctOriginText = document.getElementById('cloud-tunnel-origin-text');

  // ECHOCAT-tab banner mirrors the canonical Cloud-tab state. The
  // Manage button hands off to the existing 'open-settings-panel'
  // path so the Cloud tab is the single source of truth.
  const ctBannerPill = document.getElementById('echocat-cloud-banner-pill');
  const ctBannerHost = document.getElementById('echocat-cloud-banner-host');
  const ctBannerManage = document.getElementById('echocat-cloud-banner-manage');

  function renderTunnelState(state) {
    if (!state) return;
    // Origin self-test (lib/origin-health.js). The cloud vouching for
    // cloudflared is not the same as POTACAT answering behind it: a dead
    // origin used to show green "Live" with a link that 502'd (K5AWJ).
    const originBad = !!(state.enabled && state.origin && state.origin.state !== 'ok' && state.origin.state !== 'pending' && state.origin.state !== 'off');
    const linkable = state.status === 'live' && !originBad;
    let label, pillClass;
    if (!state.enabled) {
      label = 'LAN only'; pillClass = 'status disconnected';
    } else if (originBad && state.status === 'live') {
      label = state.origin.label || 'Cloud up · POTACAT not answering'; pillClass = 'status connecting';
    } else if (state.degraded) {
      // Nominally up but cloudflared can't refresh DNS — amber, not
      // green: the tunnel is failing and the user needs to act.
      label = 'DNS trouble'; pillClass = 'status connecting';
    } else if (state.status === 'live') {
      label = 'Live'; pillClass = 'status connected';
    } else if (state.status === 'error') {
      label = 'Error'; pillClass = 'status disconnected';
    } else {
      label = state.status === 'provisioning' ? 'Provisioning…' : 'Reconnecting…';
      pillClass = 'status connecting';
    }
    const hostText = state.enabled && state.cloudHost ? state.cloudHost : '';
    if (ctStatusPill) { ctStatusPill.textContent = label; ctStatusPill.className = pillClass; }
    if (ctHost) {
      // A live tunnel host is an address a browser can open (ECHOCAT
      // Web signs in at login.potacat.com). data-external routes it
      // to the default browser via app.js's delegation.
      ctHost.textContent = '';
      if (hostText && linkable) {
        const a = document.createElement('a');
        a.href = 'https://' + hostText;
        a.textContent = hostText;
        a.setAttribute('data-external', '1');
        a.title = 'Open in your browser';
        ctHost.appendChild(a);
      } else {
        ctHost.textContent = hostText;
      }
    }
    if (ctBannerPill) { ctBannerPill.textContent = label; ctBannerPill.className = pillClass; }
    if (ctBannerHost) ctBannerHost.textContent = hostText ? 'https://' + hostText : '';
    if (ctEnableBtn) ctEnableBtn.classList.toggle('hidden', !!state.enabled);
    if (ctDisableBtn) ctDisableBtn.classList.toggle('hidden', !state.enabled);
    if (ctOrigin) {
      if (originBad) {
        if (ctOriginTitle) ctOriginTitle.textContent = '⚠ ' + (state.origin.label || 'Cloud up · POTACAT not answering');
        if (ctOriginText) ctOriginText.textContent = ' — ' + (state.origin.reason || 'POTACAT is not answering behind the tunnel.');
        ctOrigin.classList.remove('hidden');
      } else {
        ctOrigin.classList.add('hidden');
      }
    }
    if (ctDegraded) {
      if (state.degraded) {
        if (ctDegradedText) ctDegradedText.textContent = ' — ' + (state.degradedReason || 'The Cloud Tunnel is having DNS trouble.');
        ctDegraded.classList.remove('hidden');
      } else {
        ctDegraded.classList.add('hidden');
      }
    }
    if (ctError) {
      // Suppress the raw red error while the amber degraded notice is
      // showing — the degraded hint is the actionable version.
      if (state.lastError && !state.degraded) {
        ctError.textContent = state.lastError;
        ctError.classList.remove('hidden');
      } else {
        ctError.classList.add('hidden');
      }
    }
    refreshStartupOffer(state).catch(() => {});
  }

  if (ctBannerManage) {
    ctBannerManage.addEventListener('click', () => {
      const cloudTabBtn = document.querySelector('.settings-tab[data-tab="cloud"]');
      if (cloudTabBtn) cloudTabBtn.click();
      if (ctFieldset) ctFieldset.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function refreshTunnelState() {
    if (!window.api || !window.api.cloudTunnelGetState) return;
    try {
      const state = await window.api.cloudTunnelGetState();
      renderTunnelState(state);
    } catch (err) {
      console.error('[cloud-tunnel] getState failed:', err);
    }
  }

  if (ctEnableBtn) {
    ctEnableBtn.addEventListener('click', async () => {
      if (!window.api || !window.api.cloudTunnelEnable) return;
      ctEnableBtn.disabled = true;
      ctEnableBtn.textContent = 'Enabling…';
      try {
        const res = await window.api.cloudTunnelEnable();
        if (res && res.error === 'entitlement-required') {
          // The wall itself: the user just tried to use the thing, so the
          // fix is one click away. The server's sentence says why (a lapsed
          // grant, a failed card); the subscribe buttons sit right above.
          const b = res.billing || _lastBilling;
          if (ctError) {
            ctError.textContent = (b && b.message) || 'POTACAT Cloud subscription required. Subscribe in the section above.';
            ctError.classList.remove('hidden');
          }
          if (b && b.action && b.action.label && b.state !== 'none' && b.state !== 'trial_expired') {
            window.api.cloudOpenBillingAction(b).catch(() => {});
          } else if (subscribeSection) {
            subscribeSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (subscribeMonthlyBtn) { try { subscribeMonthlyBtn.focus(); } catch {} }
          }
        } else if (res && res.code === 'no_callsign') {
          // The tunnel hostname is <callsign>.potacat.com — no callsign on
          // the account, no tunnel. Open the callsign editor (above) rather
          // than leaving the user at a dead end.
          if (ctError) {
            ctError.textContent = res.error;
            ctError.classList.remove('hidden');
          }
          await openCallsignEditor('missing');
          if (callsignEditor) callsignEditor.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (callsignEditInput) { try { callsignEditInput.focus(); } catch {} }
        } else if (res && res.error) {
          if (ctError) {
            ctError.textContent = res.error === 'cloudflared-missing'
              ? 'cloudflared binary missing — reinstall POTACAT.'
              : res.error === 'auth-required'
                ? 'Sign in to POTACAT Cloud above to enable one-tap remote.'
                : res.error;
            ctError.classList.remove('hidden');
          }
        } else if (res && res.ok) {
          renderTunnelState(res.state);
        }
      } catch (err) {
        if (ctError) {
          ctError.textContent = err.message || String(err);
          ctError.classList.remove('hidden');
        }
      } finally {
        ctEnableBtn.disabled = false;
        ctEnableBtn.textContent = 'Enable POTACAT Cloud';
      }
    });
  }

  if (ctDisableBtn) {
    ctDisableBtn.addEventListener('click', async () => {
      if (!window.api || !window.api.cloudTunnelDisable) return;
      if (!confirm('Disable POTACAT Cloud? The tunnel will be revoked; the LAN connection still works.')) return;
      ctDisableBtn.disabled = true;
      ctDisableBtn.textContent = 'Disabling…';
      try {
        const res = await window.api.cloudTunnelDisable();
        if (res && res.ok) renderTunnelState(res.state);
        else if (res && res.error && ctError) {
          ctError.textContent = res.error;
          ctError.classList.remove('hidden');
        }
      } finally {
        ctDisableBtn.disabled = false;
        ctDisableBtn.textContent = 'Disable';
      }
    });
  }

  if (window.api && window.api.onCloudTunnelState) {
    window.api.onCloudTunnelState((state) => renderTunnelState(state));
  }

  if (window.api && window.api.onOpenSettingsPanel) {
    window.api.onOpenSettingsPanel((payload) => {
      if (!payload || payload.panel !== 'cloud-tunnel') return;
      const dlg = document.getElementById('settings-dialog');
      if (dlg && typeof dlg.showModal === 'function' && !dlg.open) {
        try { dlg.showModal(); } catch {}
      }
      // Switch to Cloud tab — app.js uses .settings-tab[data-tab="cloud"]
      // buttons inside #settings-tab-bar; clicking dispatches its own
      // handler which calls switchSettingsTab().
      const cloudTabBtn = document.querySelector('.settings-tab[data-tab="cloud"]');
      if (cloudTabBtn) cloudTabBtn.click();
      if (ctFieldset) ctFieldset.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  setTimeout(refreshTunnelState, 2000);
})();
