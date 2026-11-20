// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window, A2: message templates in the Messages view. A "Templates"
// button beside the To field opens the list (grouped as lib/aprs-templates.js
// BUILT_IN, then My templates); picking one fills To and Text and shows a
// one-line hint. Nothing sends until Send. Fields like <PARK> <FREQ> <MODE>
// come filled from the running activation and the radio (main.js
// aprsTemplatesContext); any other <FIELD> stays for the operator, and Send
// waits until it is replaced. "Save current message as a template" keeps the
// compose box in the profile's settings. No pop-ups.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var T = window.AprsTemplates;
  var V = window.AprsMessagesView;
  if (!T || !V) return;
  var st = { context: {}, mine: [], running: false };
  var open = false;
  var saving = false;
  var saveNote = { text: '', bad: false };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // The button beside To.
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'aprs-btn-quiet';
  btn.id = 'aprs-tpl-open';
  btn.textContent = 'Templates';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'aprs-tpl-panel');
  V.toolsSlot().appendChild(btn);

  // The list takes the thread's place while it is open.
  var panel = document.createElement('section');
  panel.id = 'aprs-tpl-panel';
  panel.className = 'aprs-tpl hidden';
  panel.setAttribute('aria-label', 'Templates');
  var body = $('aprs-msgs-thread');
  body.parentNode.insertBefore(panel, body);

  function item(t, mine) {
    return '<div class="aprs-tpl-row">' +
      '<button type="button" class="aprs-tpl-item" data-tpl="' + esc(t.id) + '" data-mine="' + (mine ? '1' : '') + '">' +
      '<span class="aprs-tpl-name">' + esc(t.name) + '</span>' +
      '<span class="aprs-tpl-to">to ' + esc(t.to) + '</span>' +
      '<code class="aprs-tpl-fmt">' + esc(t.text) + '</code></button>' +
      (mine ? '<button type="button" class="aprs-tpl-del" data-del="' + esc(t.id) + '" aria-label="Delete the template ' + esc(t.name) + '">Delete</button>' : '') +
      '</div>';
  }

  function render() {
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
    panel.classList.toggle('hidden', !open);
    body.classList.toggle('hidden', open);
    if (!open) return;
    var html = '<div class="aprs-tpl-head"><h3>Templates</h3><span>Fills To and Text. Nothing sends until you press Send.</span>' +
      '<span class="aprs-spacer"></span><button type="button" class="aprs-btn-quiet" id="aprs-tpl-close">Close</button></div>';
    T.BUILT_IN.forEach(function (g) {
      html += '<div class="aprs-tpl-group">' + esc(g.group) + '</div>' + g.items.map(function (t) { return item(t, false); }).join('');
    });
    html += '<div class="aprs-tpl-group">My templates</div>';
    html += st.mine.length ? st.mine.map(function (t) { return item(t, true); }).join('')
      : '<div class="aprs-tpl-empty">None yet. Write a message, then save it here. Fields like &lt;PARK&gt; &lt;FREQ&gt; &lt;MODE&gt; &lt;CALL&gt; fill in each time.</div>';
    var c = V.getCompose();
    html += '<div class="aprs-tpl-save">';
    if (saving) {
      html += '<label for="aprs-tpl-name">Name</label><input type="text" id="aprs-tpl-name" maxlength="' + T.MAX_NAME + '" spellcheck="false">' +
        '<button type="button" class="aprs-btn" id="aprs-tpl-save-ok">Save</button><button type="button" class="aprs-btn-quiet" id="aprs-tpl-save-cancel">Cancel</button>';
    } else {
      html += '<button type="button" class="aprs-btn-quiet" id="aprs-tpl-save"' + (c.to.trim() && c.text.trim() ? '' : ' disabled') + '>Save current message as a template</button>';
    }
    html += '<span class="aprs-tpl-note' + (saveNote.bad ? ' bad' : '') + '" aria-live="polite">' + esc(saveNote.text) + '</span></div>';
    panel.innerHTML = html;
    if (saving) { var n = $('aprs-tpl-name'); n.value = suggestName(c); n.focus(); n.select(); }
  }

  function suggestName(c) {
    var to = String(c.to || '').toUpperCase().trim();
    var words = String(c.text || '').trim().split(/\s+/).slice(0, 3).join(' ');
    return (to + (words ? ' ' + words : '')).slice(0, T.MAX_NAME);
  }

  function pick(id, mine) {
    var t = null;
    if (mine) t = st.mine.filter(function (m) { return m.id === id; })[0];
    else t = T.findBuiltIn(id);
    if (!t) return;
    var f = T.fill(t, st.context);
    var hint = [T.filledWords(f.filled, st.running), t.hint || ''].filter(Boolean).join('. ');
    if (!f.fits) hint = 'The filled message is ' + f.length + ' characters; APRS takes at most ' + T.MAX_TEXT + '. Shorten it before sending.';
    open = false;
    saving = false;
    render();
    V.setCompose(f.to, f.text, hint);
    var input = $('aprs-msgs-text');
    input.focus();
    if (f.left.length) {
      var i = f.text.indexOf(f.left[0]);
      input.setSelectionRange(i, i + f.left[0].length); // type over the first field
    } else input.setSelectionRange(f.text.length, f.text.length);
  }

  btn.addEventListener('click', function () {
    open = !open;
    saving = false;
    saveNote = { text: '', bad: false };
    if (open) window.api.templatesGet();
    render();
  });
  panel.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'aprs-tpl-close') { open = false; render(); return; }
    if (b.hasAttribute('data-tpl')) { pick(b.getAttribute('data-tpl'), b.getAttribute('data-mine') === '1'); return; }
    if (b.hasAttribute('data-del')) { window.api.templatesDelete(b.getAttribute('data-del')); return; }
    if (b.id === 'aprs-tpl-save') { saving = true; saveNote = { text: '', bad: false }; render(); return; }
    if (b.id === 'aprs-tpl-save-cancel') { saving = false; render(); return; }
    if (b.id === 'aprs-tpl-save-ok') save();
  });
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'aprs-tpl-name') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { open = false; render(); btn.focus(); }
  });

  function save() {
    var c = V.getCompose();
    var name = $('aprs-tpl-name') ? $('aprs-tpl-name').value : '';
    window.api.templatesSave({ name: name, to: c.to, text: c.text }).then(function (r) {
      if (r && r.ok) { saving = false; saveNote = { text: 'Saved as "' + r.tpl.name + '".', bad: false }; }
      else saveNote = { text: (r && r.sentence) || 'Not saved.', bad: true };
      render();
    });
  }

  window.api.onTemplates(function (s) {
    st = { context: (s && s.context) || {}, mine: (s && s.mine) || [], running: !!(s && s.context && s.context.running) };
    if (open && !saving) render();
  });
  window.api.templatesGet();
})();
