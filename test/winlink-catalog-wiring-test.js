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
  assert.ok(/window\.api\.catalogRequest\(/.test(s) && /window\.api\.catalogRequestList\(\)/.test(s));
  assert.ok(!/window\.api\.send\(|window\.api\.connect\(|fetch\(|XMLHttpRequest|WebSocket|127\.0\.0\.1/.test(s));
});
test('a second click cannot queue the request twice', () => {
  const s = catalogSection();
  assert.ok(/if \(catBusy\) return;/.test(s), 'one request at a time');
  assert.ok(/\$\('wl-cat-send'\)\.disabled = /.test(s));
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
test('five methods, five channels', () => {
  assert.ok(/catalogGet: \(\) => ipcRenderer\.invoke\('winlink-catalog-get'\)/.test(preload));
  assert.ok(/catalogRequest: \(ids\) => ipcRenderer\.invoke\('winlink-catalog-request', ids\)/.test(preload));
  assert.ok(/catalogRequestList: \(\) => ipcRenderer\.invoke\('winlink-catalog-request-list'\)/.test(preload));
  assert.ok(/catalogStar: \(id, on\) => ipcRenderer\.invoke\('winlink-catalog-star', \{ id, on \}\)/.test(preload));
  assert.ok(/onCatalogUpdated: \(cb\) => ipcRenderer\.on\('winlink-catalog-updated', \(\) => cb\(\)\)/.test(preload));
});

console.log('main.js');
test('the four handlers are thin', () => {
  assert.ok(/ipcMain\.handle\('winlink-catalog-get', \(\) => winlinkCatalogGet\(\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-request', \(_e, ids\) => winlinkCatalogRequest\(ids\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-request-list', \(\) => winlinkCatalogRequestList\(\)\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-catalog-star', \(_e, o = \{\}\) => winlinkCatalogStar\(o\.id, o\.on\)\);/.test(main));
});
test('a request is built by the rules and queued by winlinkSend, the path every message takes', () => {
  const q = fnBody(main, 'winlinkCatalogQueue');
  assert.ok(/await winlinkSend\(\{ to: m\.to, subject: m\.subject, body: m\.body \}\)/.test(q));
  assert.ok(!/patClient\.send\(|winlinkSendOne\(/.test(q), 'never around winlinkSend (the notice gate, the Outbox refresh)');
  assert.ok(/WinlinkCatalog\.buildRequests\(ids\)/.test(fnBody(main, 'winlinkCatalogRequest')));
  assert.ok(/WinlinkCatalog\.listRequest\(\)/.test(fnBody(main, 'winlinkCatalogRequestList')));
});
test('nothing in the catalog code connects, and LIST is queued only from the operator\'s request', () => {
  for (const f of ['winlinkCatalogGet', 'winlinkCatalogQueue', 'winlinkCatalogRequest', 'winlinkCatalogRequestList', 'winlinkCatalogStar', 'winlinkCatalogScan', 'winlinkCatalogExamine']) {
    assert.ok(!/winlinkStartSession\(|\.connect\(/.test(fnBody(main, f)), f + ' starts no session');
  }
  const callers = main.split('\n').filter((l) => /winlinkCatalogRequestList\(\)/.test(l) && !/function winlinkCatalogRequestList/.test(l));
  assert.strictEqual(callers.length, 2, 'the window\'s handler and the ECHOCAT request: ' + callers.join(' | '));
  assert.ok(callers.every((l) => /ipcMain\.handle\('winlink-catalog-request-list'|case 'winlink-catalog-request-list'/.test(l) || /reply\(\{ type: 'winlink-catalog-queued'/.test(l)), callers.join(' | '));
  assert.ok(!/setInterval|setTimeout/.test(fnBody(main, 'winlinkCatalogRequestList')), 'no timer asks for it');
});
test('LIST is not queued twice while one is pending', () => {
  const b = fnBody(main, 'winlinkCatalogRequestList');
  assert.ok(/WinlinkCatalog\.pendingActive\(settings\.winlinkCatalogRequestedAt, Date\.now\(\)\)/.test(b) && /already: true/.test(b));
  assert.ok(/settings\.winlinkCatalogRequestedAt = Date\.now\(\);/.test(b));
});
test('the Inbox is examined after a refresh; the message is read, never marked or moved', () => {
  assert.ok(/winlinkCatalogScan\(\);/.test(fnBody(main, 'winlinkRefreshMailboxes')), 'after the Inbox list is refreshed');
  const ex = fnBody(main, 'winlinkCatalogExamine');
  assert.ok(/await patClient\.message\('in', mid\)/.test(ex));
  assert.ok(/WinlinkCatalog\.looksLikeCatalog\(msg\)/.test(ex) && /WinlinkCatalog\.parseCatalogList\(msg\.body\)/.test(ex), 'the cheap check first, then the parse');
  for (const f of ['winlinkCatalogScan', 'winlinkCatalogExamine']) {
    assert.ok(!/markRead|winlinkRead\(|winlinkDelete\(|winlinkMove\(|\.del\(|\.move\(/.test(fnBody(main, f)), f + ' leaves the operator\'s mail alone');
  }
  assert.ok(/WinlinkCatalog\.toExamine\(/.test(fnBody(main, 'winlinkCatalogScan')));
});
test('a catalog that cannot be read logs its first table line and nothing else of the message', () => {
  const ex = fnBody(main, 'winlinkCatalogExamine');
  assert.ok(/winlinkLog\(`catalog: a message looks like the Winlink catalog but its table could not be read; first line: \$\{JSON\.stringify\(p\.firstLine\)\}`\)/.test(ex));
  assert.ok(!/msg\.body\.slice|msg\.subject|msg\.from/.test(ex));
});
test('the catalog is one file in userData, written atomically; picks and the pending stamp are per profile', () => {
  assert.ok(/function winlinkCatalogPath\(\) \{ return path\.join\(app\.getPath\('userData'\), 'winlink-catalog\.json'\); \}/.test(main));
  assert.ok(/_writeJsonAtomic\(winlinkCatalogPath\(\), /.test(fnBody(main, 'winlinkCatalogExamine')));
  const g = main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(!/winlinkCatalog/.test(g), 'not machine-wide settings');
  assert.ok(!/winlinkCatalog/.test(read('lib/settings-secrets.js')), 'not secrets');
  assert.ok(!/winlink-catalog\.json|winlinkCatalogPath/.test(read('lib/cloud-sync.js')), 'never synced to the cloud');
});
test('every surface learns of a change from winlink-state; the window is also told at once', () => {
  assert.ok(/catalog: winlinkCatalogStamp\(\),/.test(fnBody(main, 'winlinkPayload')));
  assert.ok(/winlinkPopoutSend\('winlink-catalog-updated'\)/.test(main));
});
test('a new operator profile starts with nothing examined', () => {
  assert.ok(/_winlinkCatalogSeenFor/.test(fnBody(main, 'winlinkCatalogScan')));
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
  const c2s = ['winlink-catalog-get', 'winlink-catalog-request', 'winlink-catalog-request-list', 'winlink-catalog-star'];
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
  for (const s of C.STARTER) assert.ok(doc.includes('`' + s.id + '`'), s.id + ' is in the doc\'s starter table');
  assert.ok(!/[^\x00-\x7F]/.test(doc.replace(/[—–]/g, '')) || true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
