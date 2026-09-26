// GitHub release notes -> HTML for the What's New dialog.
//
// A small markdown renderer plus pre-processing for the project's
// release-notes conventions (`**Headline:** …`, signoff, CI-asset footers).
// Everything is HTML-escaped EXCEPT a short allow-list of attribute-free
// inline tags GitHub also renders (<sub>, <sup>, <small>, <kbd>, <br>),
// and markdown backslash escapes (`\*`, `\_`, …) produce the literal
// character: the 1.10.23 notes opened with `**Free beer…!\***` and a
// `<sub>` footnote, and the dialog showed the backslash, the asterisks and
// the tag as text.
//
// Dual-mode: require() in tests, window.ReleaseNotesFormat via <script> in
// the desktop renderer. Tests: test/release-notes-format-test.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReleaseNotesFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALLOWED_INLINE_TAGS = ['sub', 'sup', 'small', 'kbd', 'br'];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatReleaseNotes(md) {
    md = String(md || '').replace(/\r\n?/g, '\n');

    // ── Pre-processing ──────────────────────────────────────────────
    // Trim download / install / checksum / smartscreen tail.
    md = md.replace(/\n---+[\s\S]*?(?:sudo |SmartScreen|`shasum|`sha256sum|Download |latest-(?:mac|linux|win))[\s\S]*/im, '\n---\n').trim();
    md = md.replace(/\n#{1,4} *(Install|Download|Checksum|SHA-?256|SmartScreen|Assets)[\s\S]*/i, '').trim();
    // Strip Claude / Anthropic attribution if it leaked through.
    md = md.replace(/^.*(?:generated with|claude|anthropic).*$/gim, '').trim();
    // Pull the H1 title — rendered as the lead heading at the top.
    let h1 = '';
    md = md.replace(/^# +(.+)$/m, (_m, h) => { h1 = h.trim(); return ''; }).trim();
    // `**Headline:** <prose>` introduces a lead paragraph.
    let lead = '';
    md = md.replace(/^\*\*Headline:\*\*\s*(.+)$/m, (_m, prose) => { lead = prose.trim(); return ''; }).trim();
    // Standalone `73.` signoff on the last line — the chrome renders it.
    md = md.replace(/\n+73\.?\s*$/i, '').trim();
    // Horizontal rules that now bracket empty regions.
    md = md.replace(/(^|\n)---+\s*$/g, '$1').trim();

    // ── Protect code and escapes ────────────────────────────────────
    // Code fences and inline code keep their contents verbatim, so they
    // come out before escape handling and inline transforms.
    const codeBlocks = [];
    md = md.replace(/```([a-z]*)\n([\s\S]*?)```/gi, (_m, _lang, body) => `\u0000C${codeBlocks.push(body.trim()) - 1}\u0000`);
    const inlineCode = [];
    md = md.replace(/`([^`\n]+)`/g, (_m, c) => `\u0000I${inlineCode.push(c) - 1}\u0000`);
    // Backslash escapes: the escaped character is literal text, never markup.
    const literals = [];
    md = md.replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, (_m, ch) => `\u0000L${literals.push(ch) - 1}\u0000`);

    md = esc(md);
    // Re-admit the attribute-free inline tags GitHub renders.
    const tagRe = new RegExp('&lt;(\\/?)(' + ALLOWED_INLINE_TAGS.join('|') + ')\\s*(\\/?)&gt;', 'gi');
    md = md.replace(tagRe, (_m, close, tag, self) => `<${close}${tag.toLowerCase()}${self ? ' /' : ''}>`);

    // Headings (descending so ## doesn't eat ###).
    md = md.replace(/^#### +(.+)$/gm, '<h5 class="rn-h5">$1</h5>');
    md = md.replace(/^### +(.+)$/gm, '<h4 class="rn-h4">$1</h4>');
    md = md.replace(/^## +(.+)$/gm, '<h3 class="rn-h3">$1</h3>');
    md = md.replace(/^---+\s*$/gm, '<hr class="rn-hr">');

    // Bold / italic. Bold first so the asterisk-counting works.
    md = md.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    md = md.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    md = md.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
    // Links: [text](url) — http(s) only.
    md = md.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-external="1">$1</a>');

    // Lists: consecutive `- ` lines become a <ul>.
    md = md.replace(/(^|\n)((?:[ \t]*[-*+] +.+(?:\n|$))+)/g, (_m, pre, block) => {
      const items = block.split(/\n/).filter(Boolean).map((line) =>
        '<li>' + line.replace(/^[ \t]*[-*+] +/, '') + '</li>'
      ).join('');
      return pre + '<ul class="rn-ul">' + items + '</ul>';
    });

    // Paragraphs: split on blank lines, wrap text chunks in <p>.
    const html = md.split(/\n{2,}/).map((b) => {
      const t = b.trim();
      if (!t) return '';
      if (/^<(h\d|ul|pre|hr|blockquote)/.test(t) || /^\u0000C\d+\u0000$/.test(t)) return t;
      return '<p class="rn-p">' + t.replace(/\n/g, '<br>') + '</p>';
    }).join('\n')
      .replace(/\u0000C(\d+)\u0000/g, (_m, i) => '<pre class="rn-pre"><code>' + esc(codeBlocks[+i]) + '</code></pre>')
      .replace(/\u0000I(\d+)\u0000/g, (_m, i) => '<code class="rn-code">' + esc(inlineCode[+i]) + '</code>')
      .replace(/\u0000L(\d+)\u0000/g, (_m, i) => esc(literals[+i]));

    const unescape = (s) => s.replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, '$1');
    const head = (h1 || lead)
      ? '<div class="rn-head">'
        + (h1 ? '<div class="rn-h1">' + esc(unescape(h1)) + '</div>' : '')
        + (lead ? '<div class="rn-lead">' + esc(unescape(lead)) + '</div>' : '')
        + '</div>'
      : '';
    return head + html;
  }

  return { formatReleaseNotes, ALLOWED_INLINE_TAGS };
});
