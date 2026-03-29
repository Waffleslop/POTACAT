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
  const subscribeBtn = document.getElementById('cloud-subscribe-btn');
  const verifyBtn = document.getElementById('cloud-verify-btn');
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
  const lastSyncSpan = document.getElementById('cloud-last-sync');
  const downloadAdifBtn = document.getElementById('cloud-download-adif');
  const connCloudPill = document.getElementById('conn-cloud');

  // ── State ─────────────────────────────────────────────────────────

  let isLoggedIn = false;
  let currentSyncStatus = 'idle';

  // ── UI Helpers ────────────────────────────────────────────────────

  const loginSignout = document.getElementById('cloud-login-signout');
  const loginSignoutLink = document.getElementById('cloud-login-signout-link');

  function showLogin(hasStaleTokens) {
    loginSection.classList.remove('hidden');
    accountSection.classList.add('hidden');
    isLoggedIn = false;
    updateCloudPill('disconnected');
    if (loginSignout) loginSignout.classList.toggle('hidden', !hasStaleTokens);
  }

  function showAccount(user, subscription) {
    loginSection.classList.add('hidden');
    accountSection.classList.remove('hidden');
    isLoggedIn = true;

    userCallsignSpan.textContent = subscription?.callsign || user?.callsign || '';
    userEmailSpan.textContent = user?.email || 'unknown';

    if (subscription && subscription.status === 'active') {
      subStatusSpan.textContent = 'active';
      subStatusSpan.className = 'status connected';
      subLevelSpan.textContent = subscription.level ? `(${subscription.level})` : '';
      trialInfoSpan.classList.add('hidden');
      subscribeSection.style.display = 'none';
      updateCloudPill('connected');
    } else if (subscription && subscription.status === 'trial') {
      const days = subscription.trialDaysLeft || 0;
      subStatusSpan.textContent = 'trial';
      subStatusSpan.className = 'status connected';
      subLevelSpan.textContent = '';
      trialInfoSpan.textContent = `${days} day${days !== 1 ? 's' : ''} remaining`;
      trialInfoSpan.classList.remove('hidden');
      subscribeSection.style.display = '';
      updateCloudPill('connected');
    } else {
      const trialExpired = subscription?.trialActive === false && subscription?.trialExpiresAt;
      subStatusSpan.textContent = trialExpired ? 'trial expired' : (subscription?.status || 'inactive');
      subStatusSpan.className = 'status disconnected';
      subLevelSpan.textContent = '';
      trialInfoSpan.classList.add('hidden');
      subscribeSection.style.display = '';
      updateCloudPill('disconnected');
    }
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

      showAccount(status.user, sub);

      if (status.sync) {
        qsoCountSpan.textContent = status.sync.totalQsos ?? '--';
        deviceCountSpan.textContent = status.sync.deviceCount ?? '--';
      } else {
        qsoCountSpan.textContent = '--';
        deviceCountSpan.textContent = '--';
      }
      pendingCountSpan.textContent = status.pendingChanges ?? 0;
      lastSyncSpan.textContent = formatTimestamp(status.lastSyncTimestamp || status.sync?.lastSyncAt);
    } catch (err) {
      console.error('Cloud status error:', err);
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
        }
      } finally {
        emailRegisterBtn.disabled = false;
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
    subscribeBtn.addEventListener('click', () => {
      window.api.cloudOpenSubscribe();
    });
  }

  if (loginSignoutLink) {
    loginSignoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.api.cloudLogout();
      showLogin(false);
    });
  }

  const clearTokensBtn = document.getElementById('cloud-clear-tokens');
  if (clearTokensBtn) {
    clearTokensBtn.addEventListener('click', async () => {
      await window.api.cloudLogout();
      showLogin(false);
    });
  }

  const supporterLink = document.getElementById('cloud-supporter-link');
  if (supporterLink) {
    supporterLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.cloudOpenSubscribe();
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
        if (result.error) {
          alert('Sync failed: ' + result.error);
        } else {
          lastSyncSpan.textContent = 'just now';
        }
        await refreshStatus();
      } finally {
        syncNowBtn.disabled = false;
        syncNowBtn.textContent = 'Sync Now';
      }
    });
  }

  if (initialUploadBtn) {
    initialUploadBtn.addEventListener('click', async () => {
      if (!confirm('This will upload your entire local log to the cloud. This may take a few minutes for large logs. Continue?')) return;

      initialUploadBtn.disabled = true;
      uploadProgress.classList.remove('hidden');
      uploadBar.value = 0;
      uploadText.textContent = 'Preparing...';

      try {
        const result = await window.api.cloudBulkUpload();
        if (result.error) {
          alert('Upload failed: ' + result.error);
        } else {
          uploadText.textContent = `Done! ${result.imported} QSOs uploaded, ${result.duplicates} duplicates skipped.`;
          await refreshStatus();
        }
      } catch (err) {
        alert('Upload error: ' + err.message);
      } finally {
        initialUploadBtn.disabled = false;
        setTimeout(() => uploadProgress.classList.add('hidden'), 5000);
      }
    });
  }

  if (downloadAdifBtn) {
    downloadAdifBtn.addEventListener('click', async () => {
      downloadAdifBtn.disabled = true;
      downloadAdifBtn.textContent = 'Downloading...';
      try {
        const result = await window.api.cloudDownloadAdif();
        if (result.error) {
          alert('Download failed: ' + result.error);
        } else if (!result.canceled) {
          alert('Cloud log saved to: ' + result.filePath);
        }
      } finally {
        downloadAdifBtn.disabled = false;
        downloadAdifBtn.textContent = 'Download Cloud Log (ADIF)';
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
        uploadText.textContent = `Uploading... ${data.current} / ${data.total} (${pct}%)`;
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

  // ── Init ──────────────────────────────────────────────────────────

  // Load saved settings and refresh status when Cloud tab is shown
  const observer = new MutationObserver(() => {
    const cloudFieldsets = document.querySelectorAll('[data-settings-tab="cloud"]');
    if (cloudFieldsets.length > 0 && !cloudFieldsets[0].classList.contains('hidden') &&
        cloudFieldsets[0].offsetParent !== null) {
      loadCloudSettings();
      refreshStatus();
    }
  });

  const settingsDialog = document.getElementById('settings-dialog');
  if (settingsDialog) {
    observer.observe(settingsDialog, { attributes: true, subtree: true, attributeFilter: ['class', 'open'] });
  }

  // Initial load
  setTimeout(() => { loadCloudSettings(); refreshStatus(); }, 2000);
})();
