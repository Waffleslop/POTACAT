// The one-time "Rate ECHOCAT" card. Main decides when (lib/review-ask.js:
// a phone paired a week ago, seen on three days, a calm moment); this only
// draws it and reports the answer. Plain words, the same buttons for
// everyone, no incentives — the store rules the phone lives under, applied
// here by choice (potacat-meta work/open/echocat-store-review-ask-desktop.md).
(function () {
  'use strict';
  const card = document.getElementById('echocat-review-card');
  if (!card || !window.api || !window.api.onEchocatReviewAsk) return;
  const textEl = document.getElementById('er-text');
  const buttonsEl = document.getElementById('er-buttons');

  const STORE_NAME = { ios: 'the App Store', android: 'Google Play' };
  const BUTTON = { ios: 'Rate on the App Store', android: 'Rate on Google Play' };

  function close() { card.classList.add('hidden'); }

  function answer(action, store) {
    window.api.echocatReviewAction({ action, store });
    close();
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function show(stores) {
    const where = stores.map(s => STORE_NAME[s]).join(' or ');
    textEl.textContent = `A quick review on ${where} helps other hams find it. ECHOCAT is built by one person, and reviews make a real difference.`;
    buttonsEl.innerHTML = '';
    for (const s of stores) buttonsEl.appendChild(button(BUTTON[s], 'ss-btn ss-btn-primary', () => answer('rate', s)));
    buttonsEl.appendChild(button('Not now', 'ss-btn', () => answer('later')));
    buttonsEl.appendChild(button('Don\'t ask again', 'ss-link', () => answer('never')));
    card.classList.remove('hidden');
    window.api.echocatReviewShown();
  }

  document.getElementById('er-close').addEventListener('click', () => answer('later'));

  window.api.onEchocatReviewAsk(({ stores } = {}) => {
    const list = (stores || []).filter(s => STORE_NAME[s]);
    if (!list.length) return;
    // Never stack on another notice or a dialog the operator is using;
    // main asks again at its next check.
    const busy = !document.getElementById('station-setup-card').classList.contains('hidden')
      || !!document.querySelector('dialog[open]');
    if (busy) { window.api.echocatReviewDeferred(); return; }
    show(list);
  });
})();
