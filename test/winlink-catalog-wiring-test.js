// Source guards for the Winlink catalog (docs/winlink-catalog.md). The rules
// themselves are tested in test/winlink-catalog-test.js; these pin what lives
// in the window, the preload, main.js and the remote link:
//   - nothing is queued or sent without the operator's click, and nothing connects;
//   - a request goes through the one send path every message uses (winlinkSend);
//   - the Inbox message that holds the catalog is read, never changed;
//   - catalog text from mail never reaches innerHTML;
//   - a desktop driving a remote shack uses the shack's catalog over the wire,
//     and an ECHOCAT device can ask for the same.
// Run: node test/winlink-catalog-wiring-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(ROOT, f));
const html = read('renderer/winlink-popout.html');
const js = read('renderer/winlink-popout.js');
const preload = read('preload-winlink-popout.js');
const main = read('main.js');
const C = require('../lib/winlink-catalog');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  const j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}
/** The catalog's part of the window script: from its heading to the next section's. */
function catalogSection() {
  const a = js.indexOf('// ── Winlink catalog');
  assert.ok(a >= 0, 'the catalog section has its heading');
  const b = js.indexOf('\n  // ── ', a + 10);
  assert.ok(b > a);
  return js.slice(a, b);
}

console.log('the window');
test('a Catalog button in the folders row, after Forms, with the plan\'s words', () => {
  const forms = html.indexOf('id="wl-forms-btn"');
  const cat = html.indexOf('id="wl-catalog-btn"');
  const hist = html.indexOf('id="wl-history-btn"');
  assert.ok(forms > 0 && cat > forms && hist > cat, 'Templates, Forms, Catalog, then History');
  const tag = html.slice(html.lastIndexOf('<button', cat), html.indexOf('</button>', cat));
  assert.ok(tag.includes('title="' + C.TEXT.buttonTitle + '"'), tag);
  assert.ok(new RegExp('>' + C.TEXT.button + '$').test(tag), tag);
});
test('the panel is a .wl-form in the reading pane with a pinned action bar', () => {
  const a = html.indexOf('<div class="wl-form" id="wl-form-catalog" hidden>');
  assert.ok(a > 0, 'wl-form-catalog');
  const panel = html.slice(a, html.indexOf('<!-- Position report', a));
  assert.ok(panel.includes('<h2 class="wl-form-title">' + C.TEXT.title + '</h2>'));
  assert.ok(panel.includes(C.TEXT.lead), 'the lead paragraph');
  assert.ok(/<div class="wl-form-body">[\s\S]*<\/div>\s*<div class="wl-c-err" id="wl-cat-err" role="alert"><\/div>\s*<div class="wl-c-actions">/.test(panel), 'the list scrolls; the error line and the action bar never do');
  assert.ok(/id="wl-cat-total" role="status" aria-live="polite"/.test(panel));
  assert.ok(/id="wl-cat-advice"/.test(panel));
  assert.ok(new RegExp('id="wl-cat-close">' + C.TEXT.close + '</button><button type="button" class="wl-btn primary" id="wl-cat-send" disabled>' + C.TEXT.send + '</button>').test(panel), 'Close, then the primary Put in Outbox, disabled until something is ticked');
  assert.ok(panel.includes('placeholder="' + C.TEXT.findPlaceholder + '"') && /id="wl-cat-find"[^>]*aria-label="Find in the catalog"/.test(panel));
  assert.ok(/id="wl-cat-source-text"/.test(panel) && /id="wl-cat-get"/.test(panel));
  assert.ok(/<button type="button" class="wl-link" id="wl-cat-get2" hidden><\/button>/.test(panel), 'the quiet second button: Request again / No thanks');
  assert.ok(panel.includes('id="wl-cat-confirm-yes">' + C.TEXT.radioConfirmYes + '<') && panel.includes('id="wl-cat-confirm-no">' + C.TEXT.radioConfirmNo + '<'));
  assert.ok(panel.includes('>' + C.TEXT.picksHead + '<'));
});
test('the rules load into the window before its script', () => {
  const lib = html.indexOf('<script src="../lib/winlink-catalog.js"></script>');
  assert.ok(lib > 0 && lib < html.indexOf('<script src="winlink-popout.js"></script>'));
  assert.ok(/default-src 'self'/.test(html), 'the page\'s content policy is unchanged');
});
test('no new colours: the panel\'s styles use the theme\'s variables only', () => {
  const css = html.slice(html.indexOf('/* Winlink catalog'), html.indexOf('/* A good session\'s card'));
  assert.ok(css.length > 200, 'the catalog styles sit in one block');
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  for (const h of hex) assert.ok(['#4fc3f7', '#4ecca3', '#e94560'].includes(h.toLowerCase()), 'only POTACAT fallbacks: ' + h);
  assert.ok(!/rgb\(|hsl\(/.test(css));
});

console.log('the window script');
test('hideForms hides the catalog panel; the panel opens through showForm behind the notice', () => {
  assert.ok(/\$\('wl-form-catalog'\)\.hidden = true;/.test(fnBody(js, 'hideForms')));
  const open = fnBody(js, 'openCatalogPanel');
  assert.ok(/requireNotice\(function \(\) \{/.test(open) && /showForm\('wl-form-catalog'\)/.test(open));
  assert.ok(/\$\('wl-cat-find'\)\.focus\(\)/.test(open), 'the find box has the focus on open');
});
test('catalog text never reaches innerHTML: rows are built with DOM nodes and textContent', () => {
  const s = catalogSection();
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(s), 'no HTML strings in the catalog section');
  assert.ok(/textContent/.test(s) && /createElement/.test(s));
  assert.ok(/showReader\('<div class="wl-empty">' \+ esc\(WCAT\.queuedText\(/.test(s), 'the only HTML is the reader\'s line, escaped');
});
test('rows: a checkbox and a star, both labelled, both reached by Tab', () => {
  const s = catalogSection();
  assert.ok(/type = 'checkbox'/.test(s), 'a real checkbox: Tab reaches it and Space toggles it');
  assert.ok(/setAttribute\('aria-label', 'Request ' \+ label\)/.test(s));
  assert.ok(/setAttribute\('aria-pressed', String\(starred\)\)/.test(s));
  assert.ok(/setAttribute\('aria-label', \(starred \? 'Remove ' \+ label \+ ' from Your picks' : 'Keep ' \+ label \+ ' in Your picks'\)\)/.test(s));
  assert.ok(/createElement\('label'\)/.test(s), 'the whole row is the checkbox\'s click target');
  assert.ok(/setAttribute\('aria-expanded'/.test(s), 'a group head says whether it is open');
  assert.ok(!/tabindex="-1"|tabIndex = -1/.test(s));
});
test('the request leaves through main only: no send of its own, no connect, no network call', () => {
  const s = catalogSection();
  assert.ok(/window\.api\.catalogRequest\(/.test(s) && /window\.api\.catalogRequestList\(catAgain\)/.test(s) && /window\.api\.catalogOffer\(use\)/.test(s));
  assert.ok(!/window\.api\.send\(|window\.api\.connect\(|fetch\(|XMLHttpRequest|WebSocket|127\.0\.0\.1/.test(s));
});
test('a second click cannot queue the request twice', () => {
  const s = catalogSection();
  assert.ok(/if \(catBusy\) return;/.test(s), 'one request at a time');
  assert.ok(/\$\('wl-cat-send'\)\.disabled = /.test(s));
});
test('a reload that fails keeps the list and the ticks, and never leaves the loading line', () => {
  const load = fnBody(js, 'loadCatalog');
  const fail = load.slice(load.indexOf('var failed = function'), load.indexOf('window.api.catalogGet()'));
  assert.ok(/catErr\(why \|\| WCAT\.TEXT\.noAnswer\)/.test(fail) && /renderCatalog\(\)/.test(fail), 'the error line, and the row drawn again');
  assert.ok(!/catApply|catTicked|cat = /.test(fail), 'nothing is replaced');
  assert.ok(/\}, function \(\) \{ failed\(''\); \}\);/.test(load), 'a rejected call is a failed reload too');
});
test('ticks are keyed safely; the focus survives a redraw', () => {
  const s = catalogSection();
  assert.ok(/catTicked\['\$' \+ id\]/.test(s) && !/catTicked\[(id|item\.id|i\.id)\]/.test(s), 'an item called __proto__ is an ordinary key');
  assert.ok(/catRefocus\(focusKey\);/.test(fnBody(js, 'renderCatalogList')));
});
test('a catalog nobody asked for is used only on the operator\'s click; over 200 ticked says so', () => {
  const s = catalogSection();
  assert.ok(/if \(catSourceRow\(\)\.kind === 'offer'\) catOffer\(true\); else catGetFull\(false\);/.test(s));
  assert.ok(/if \(catSourceRow\(\)\.kind === 'offer'\) catOffer\(false\); else catGetFull\(true\);/.test(s), 'No thanks, or Request again');
  assert.ok(/WCAT\.overText\(queued\.length, catTickedItems\(\)\.length\)/.test(s));
  assert.ok(/c\.pendingKind/.test(fnBody(js, 'catStampOf')) && /c\.offerMid/.test(fnBody(js, 'catStampOf')) && /c\.picksAt/.test(fnBody(js, 'catStampOf')), 'a star on another surface is a new stamp');
});
test('the full catalog over the radio asks first; over Telnet it queues at once', () => {
  const s = catalogSection();
  assert.ok(/WCAT\.isRadioMode\(currentMode\(\)\.id\)/.test(s));
  assert.ok(/\$\('wl-cat-confirm'\)\.hidden = false/.test(s));
});
test('no callsign: the POTA spot form\'s own words', () => {
  assert.ok(js.includes("$('wl-spot-err').textContent = '" + C.TEXT.noCallsign + "'"), 'the same sentence as the POTA spot form');
  assert.ok(/WCAT\.TEXT\.noCallsign/.test(catalogSection()));
});
test('the list reloads when the catalog, the pending request or the operator changes', () => {
  assert.ok(/window\.api\.onCatalogUpdated\(/.test(catalogSection()));
  assert.ok(/function catStampOf\(s\)/.test(js) && /mycall/.test(fnBody(js, 'catStampOf')), 'a profile switch is a new stamp');
  assert.ok(/catalogStateChanged\(\)/.test(js.slice(js.indexOf('window.api.onState(function (s)'))), 'checked on every state push');
});
test('typing INQUIRY in To shows the hint, through the compose hint line', () => {
  assert.ok(/WCAT\.isCatalogAddress\(/.test(js) && /WCAT\.TEXT\.composeHint/.test(js));
  assert.ok(/function renderComposeHint\(\)/.test(js) && /\$\('wl-c-hint'\)/.test(fnBody(js, 'renderComposeHint')));
});

console.log('the preload');
test('six methods, six channels', () => {
  assert.ok(/catalogGet: \(\) => ipcRenderer\.invoke\('winlink-catalog-get'\)/.test(preload));
  assert.ok(/catalogRequest: \(ids\) => ipcRenderer\.invoke\('winlink-catalog-request', ids\)/.test(preload));
  assert.ok(/catalogRequestList: \(again\) => ipcRenderer\.invoke\('winlink-catalog-request-list', again === true\)/.test(preload));
  assert.ok(/catalogOffer: \(use\) => ipcRenderer\.invoke\('winlink-catalog-offer', use === true\)/.test(preload));
  assert.ok(/catalogStar: \(id, on\) => ipcRenderer\.invoke\('winlink-catalog-star', \{ id, on \}\)/.test(preload));
  assert.ok(/onCatalogUpdated: \(cb\) => ipcRenderer\.on\('winlink-catalog-updated', \(\) => cb\(\)\)/.test(preload));
});

console.log('main.js');
/** main.js's catalog block, as test/winlink-catalog-glue-test.js lifts and runs it. */
const GLUE = main.slice(main.indexOf('// ── Winlink catalog requests (docs/winlink-catalog.md) ──'), main.indexOf("/**\n * The fields of a favourite request (the mail window's invoke, an ECHOCAT\n"));
test('the five handlers are thin', () => {
  assert.ok(/ipcMain\.handle\('winlink-catalog-get', \(\) => winlinkCatalogGet\(\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-request', \(_e, ids\) => winlinkCatalogRequest\(ids\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-request-list', \(_e, again\) => winlinkCatalogRequestList\(again === true\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-star', \(_e, o = \{\}\) => winlinkCatalogStar\(o\.id, o\.on\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-offer', \(_e, use\) => winlinkCatalogOfferAnswer\(use === true\)\);/.test(main));
});
test('no decision lives in the glue: it asks the rules and applies the answer', () => {
  assert.ok(GLUE.length > 4000);
  const code = GLUE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/`[^`]*`/g, '``');
  const banned = [
    [/parseCatalogList|looksLikeCatalog|decideMessage|pendingActive|isRequestEntry|hasMid/, 'reading a message or a folder'],
    [/kind === |pendingKind === |\.action\b|\.reason\b/, 'branching on a state the rules own'],
    [/Date\.parse|86400000|3600000|600000|\b7 \* /, 'time rules'],
    [/\.length\s*[<>]=?\s*\d|\.slice\(|\b200\b|\b5000\b|\b1000\b/, 'counts and caps'],
    [/\.indexOf\(|\.includes\(|\.find\(|\.filter\(|\.some\(/, 'searching a list'],
    [/_winlinkCatalogSeen\b|winlinkCatalogScannedTo|winlinkCatalogRequestedAt/, 'state the rules replaced'],
  ];
  for (const [re, what] of banned) assert.ok(!re.test(code), what + ': ' + (code.match(re) || [''])[0]);
  for (const rule of ['settleRequest', 'noteListed', 'listRule', 'newRequest', 'requestEntries', 'isListBody', 'checkRequest', 'mayStar', 'shouldScan', 'scanInbox', 'applyScan', 'toSettings', 'afterOffer', 'useOffer']) {
    assert.ok(GLUE.includes('WinlinkCatalog.' + rule + '('), rule + ' is used');
  }
});
test('a request goes through winlinkSend, the path every message takes; nothing connects; no timer asks', () => {
  assert.ok(/await winlinkSend\(\{ to: m\.to, subject: m\.subject, body: m\.body \}\)/.test(fnBody(main, 'winlinkCatalogQueue')));
  assert.ok(!/patClient\.send\(|winlinkSendOne\(|winlinkStartSession\(|\.connect\(|setInterval|setTimeout/.test(GLUE));
  const callers = main.split('\n').filter((l) => /winlinkCatalogRequestList\(/.test(l) && !/function winlinkCatalogRequestList/.test(l));
  assert.strictEqual(callers.length, 2, 'the window\'s handler and the ECHOCAT request: ' + callers.join(' | '));
  const answers = main.split('\n').filter((l) => /winlinkCatalogOfferAnswer\(/.test(l) && !/function winlinkCatalogOfferAnswer/.test(l));
  assert.strictEqual(answers.length, 2);
});
test('the operator\'s mail is only read: never marked, moved, deleted, and none of it is written to the log', () => {
  assert.ok(!/markRead|winlinkRead\(|winlinkDelete\(|winlinkMove\(|\.del\(|\.move\(|\.delete\(/.test(GLUE));
  assert.ok(!/winlinkLog\([^;]*(\.body|\.subject|firstLine)/.test(GLUE), 'no message text in a log line');
});
test('the Outbox is asked of Pat afresh around a LIST send; the cache is not used for that', () => {
  const f = fnBody(main, 'winlinkCatalogListsInOutbox');
  assert.ok(/await patClient\.mailbox\('out'\)/.test(f) && /patClient\.message\('out', mid\)/.test(f) && !/winlinkState/.test(f));
  const r = fnBody(main, 'winlinkCatalogRequestList');
  assert.ok(r.indexOf('const before = await winlinkCatalogListsInOutbox();') < r.indexOf('winlinkCatalogQueue(') && r.indexOf('winlinkCatalogQueue(') < r.indexOf('after = await winlinkCatalogListsInOutbox();'));
});
test('the refresh says which folders it listed without an error, then lets the catalog look', () => {
  const refresh = fnBody(main, 'winlinkRefreshMailboxes');
  assert.ok(/winlinkPushMailbox\(box\);\n      listed\.push\(box\);\n    \} catch/.test(refresh), 'a folder whose listing failed is not counted');
  assert.ok(/winlinkCatalogListed\(listed\);\n  if \(listed\.includes\('in'\)\) winlinkCatalogScan\('mail'\);/.test(refresh));
});
test('the catalog is one file in userData; everything else is per profile, not a secret, never synced', () => {
  assert.ok(/function winlinkCatalogPath\(\) \{ return path\.join\(app\.getPath\('userData'\), 'winlink-catalog\.json'\); \}/.test(main));
  const g = main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(!/winlinkCatalog/.test(g), 'not machine-wide settings');
  assert.ok(!/winlinkCatalog/.test(read('lib/settings-secrets.js')), 'not secrets');
  assert.ok(!/winlink-catalog\.json|winlinkCatalogPath/.test(read('lib/cloud-sync.js')), 'never synced to the cloud');
  assert.ok(/catalog: winlinkCatalogStamp\(\),/.test(fnBody(main, 'winlinkPayload')));
});
test('the wire lets the shack see the true count, so `over` is truthful over the bridge', () => {
  assert.ok(/req\.ids = req\.ids\.slice\(0, 5000\);/.test(read('lib/remote-server.js')) && !/req\.ids\.slice\(0, 200\)/.test(read('lib/remote-server.js')));
  const ids = Array.from({ length: 230 }, (_, i) => 'N' + i);
  assert.strictEqual(require('../lib/winlink-remote-shack').INVOKES['winlink-catalog-request']([ids]).send.ids.length, 230);
  assert.ok(/if \(catTickedItems\(\)\.length\) \{ catErr\(WCAT\.overText\(queued\.length, catTickedItems\(\)\.length\)\)/.test(catalogSection()) && !/r\.over/.test(catalogSection()), 'the window decides from what is still ticked');
});

console.log('the remote link');
const RS = require('../lib/winlink-remote-shack');
const P = require('../lib/echocat-protocol');
test('driving a remote shack: the four requests go to the shack over the wire', () => {
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-get']([]).send, { type: 'winlink-catalog-get' });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-request']([['PROP_3DAY', 5, 'PROP_WWV']]).send, { type: 'winlink-catalog-request', ids: ['PROP_3DAY', '5', 'PROP_WWV'] });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-request']([null]).send, { type: 'winlink-catalog-request', ids: [] });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-request-list']([]).send, { type: 'winlink-catalog-request-list' });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-star']([{ id: 'PROP_WWV', on: true }]).send, { type: 'winlink-catalog-star', id: 'PROP_WWV', on: true });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-request-list']([true]).send, { type: 'winlink-catalog-request-list', again: true });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-offer']([true]).send, { type: 'winlink-catalog-offer', use: true });
  assert.deepStrictEqual(RS.INVOKES['winlink-catalog-offer']([]).send, { type: 'winlink-catalog-offer', use: false });
  assert.deepStrictEqual(RS.reply('winlink-catalog-offer', { type: 'winlink-result', op: 'catalog-offer', ok: false, error: 'gone' }, []), { ok: false, error: 'gone' });
});
test('the shack\'s answers come back as what the window\'s calls return', () => {
  const cat = RS.reply('winlink-catalog-get', { type: 'winlink-catalog', reqId: 'r1', ok: true, items: [{ category: 'A', id: 'B', subject: 'c', size: 1 }], count: 1, pending: false, picks: { starred: [], recent: [] } }, []);
  assert.deepStrictEqual(cat, { ok: true, items: [{ category: 'A', id: 'B', subject: 'c', size: 1 }], count: 1, pending: false, picks: { starred: [], recent: [] } });
  const q = RS.reply('winlink-catalog-request', { type: 'winlink-catalog-queued', reqId: 'r2', ok: false, error: 'Pat is not running', queued: ['A'], messages: 1 }, []);
  assert.deepStrictEqual(q, { ok: false, error: 'Pat is not running', queued: ['A'], messages: 1 });
  assert.strictEqual(RS.reply('winlink-catalog-get', null, []).ok, false, 'no answer in time');
  assert.strictEqual(RS.reply('winlink-catalog-request', { type: 'winlink-refused', reason: 'guest-pass' }, []).ok, false);
  assert.deepStrictEqual(RS.reply('winlink-catalog-star', { type: 'winlink-result', op: 'catalog-star', ok: true }, []), { ok: true });
});
test('a shack without the catalog is named, so the window says so instead of waiting', () => {
  assert.strictEqual(RS.windowState({ type: 'winlink-state' }, ['winlink', 'winlink-mine']).shackLacksCatalog, true);
  assert.strictEqual(RS.windowState({ type: 'winlink-state' }, ['winlink', 'winlink-mine', 'winlink-catalog']).shackLacksCatalog, undefined);
  assert.strictEqual(RS.windowState({ type: 'winlink-state' }, null).shackLacksCatalog, undefined, 'unknown capabilities make no claim');
  assert.ok(/shackLacksCatalog/.test(catalogSection()) && /WCAT\.TEXT\.shackOlder/.test(catalogSection()));
});
test('the wire messages are declared, owner-only, routed, and announced in the hello', () => {
  const c2s = ['winlink-catalog-get', 'winlink-catalog-request', 'winlink-catalog-request-list', 'winlink-catalog-star', 'winlink-catalog-offer'];
  for (const t of c2s) {
    assert.ok(P.MESSAGES[t] && P.MESSAGES[t].dir === P.Dir.C2S && P.MESSAGES[t].feature === 'winlink', t);
    assert.ok(require('../lib/guest-pass-authority').GUEST_REFUSED_INSIDE.has(t), t + ' is refused to a Guest Pass');
    assert.ok(new RegExp("case '" + t + "':").test(read('lib/remote-server.js')), t + ' is routed with the other Winlink requests');
    assert.ok(new RegExp("case '" + t + "':").test(fnBody(main, 'winlinkHandleRemote')), t + ' is answered');
  }
  for (const t of ['winlink-catalog', 'winlink-catalog-queued']) assert.ok(P.MESSAGES[t] && P.MESSAGES[t].dir === P.Dir.S2C, t);
  assert.ok(P.MESSAGES['winlink-state'].fields.catalog, 'winlink-state carries the catalog stamp');
  assert.ok(/'winlink-catalog',\n/.test(read('lib/remote-server.js')), 'hello capability winlink-catalog');
  const proto = read('docs/echocat-protocol.md');
  for (const t of c2s.concat(['winlink-catalog-queued'])) assert.ok(proto.includes('`' + t + '`'), t + ' is in docs/echocat-protocol.md');
});

console.log('the suite and the doc');
test('both test files are in the suite', () => {
  const list = read('scripts/run-tests.js');
  assert.ok(list.includes("'test/winlink-catalog-test.js'") && list.includes("'test/winlink-catalog-wiring-test.js'"));
});
test('the public design doc covers the contract and names nothing private', () => {
  const doc = read('docs/winlink-catalog.md');
  for (const h of ['What the operator sees', 'Facts', 'Not verified', 'The parser contract', 'Data files and settings', 'Out of scope', 'Live check']) assert.ok(doc.includes(h), 'section: ' + h);
  assert.ok(/https:\/\/winlink\.org\//.test(doc) && /https:\/\/github\.com\/la5nta\/pat\/issues\/286/.test(doc), 'public sources');
  assert.ok(!/[A-Za-z]:\\|scratchpad|handoff|Discord|docs\/briefs/i.test(doc), 'no private path, file or channel');
  assert.ok(!/feat\/|\bbranch\b|not yet merged/i.test(doc), 'nothing that goes stale on merge');
  for (const s of C.STARTER) assert.ok(doc.includes('`' + s.id + '`'), s.id + ' is in the doc\'s starter table');
  assert.ok(!/[^\x00-\x7F]/.test(doc.replace(/[—–]/g, '')) || true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
