// Reply with form (#346 phase 2): a received Winlink form that names a reply
// form opens it already linked to the original, and the reply goes out with
// its own form XML.
//
// Pat v1.0.1 source (github.com/la5nta/pat at 2ad31e8):
//   - internal/forms/builder.go: the XML's form_parameters > reply_template
//     comes from the template's "ReplyTemplate:" line.
//   - api/mailbox.go attachmentHandler: GET <form xml>?rendertohtml=true&in-reply-to=<box>/<mid>
//     renders the reply; it checks the in-reply-to path stays in the mailbox.
//   - internal/forms/forms.go RenderForm: reads reply_template (adds ".0"),
//     fills the reply's input page with the original's values, and points its
//     Submit at /api/form?in-reply-to=...&template=...; PostFormDataHandler
//     checks that in-reply-to path again (the v1.0.1 path-traversal fix).
//
// Every form here is made up; no Winlink form text is in the repo. A real Pat
// runs at the end when assets/pat has one (or POTACAT_TEST_PAT names one),
// offline: it never connects.
// Run: node test/winlink-forms-reply-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readSrc } = require('./_src');
const F = require('../lib/winlink-forms');
const { WinlinkClient } = require('../lib/winlink-client');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0, skip = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const ORIGIN = 'http://127.0.0.1:8591';

const XML = (params) => '<?xml version="1.0" encoding="UTF-8"?>\n<RMS_Express_Form>\n    <form_parameters>\n' + params + '\n    </form_parameters>\n    <variables>\n        <reply_template>not this one</reply_template>\n    </variables>\n</RMS_Express_Form>';

test('the reply form a received form names, from its XML\'s form_parameters only', () => {
  assert.strictEqual(F.formReplyTemplate(XML('        <display_form>Test_Viewer.html</display_form>\n        <reply_template>Test_SendReply.0</reply_template>')), 'Test_SendReply.0');
  assert.strictEqual(F.formReplyTemplate(XML('        <reply_template>Test_SendReply</reply_template>')), 'Test_SendReply', 'Pat adds ".0" itself');
  assert.strictEqual(F.formReplyTemplate(XML('        <reply_template></reply_template>')), '', 'empty: no reply form');
  assert.strictEqual(F.formReplyTemplate(XML('        <display_form>x.html</display_form>')), '', 'the variables block never counts');
  assert.strictEqual(F.formReplyTemplate(XML('        <reply_template>A &amp; B.0</reply_template>')), '', 'only a plain file name');
  assert.strictEqual(F.formReplyTemplate(XML('        <reply_template>../../evil.0</reply_template>')), '', 'never a path');
  for (const x of ['', null, '<html></html>', 'garbage']) assert.strictEqual(F.formReplyTemplate(x), '', String(x));
});

test('in-reply-to is "<box>/<mid>" and nothing else', () => {
  assert.strictEqual(F.inReplyToRef('in', 'ABC123DEF456'), 'in/ABC123DEF456');
  for (const [b, m] of [['in', '../x'], ['../in', 'ABC'], ['in', ''], ['', 'ABC'], ['in', 'A/B']]) assert.strictEqual(F.inReplyToRef(b, m), '', `${b} ${m}`);
});

test('the reply page and its Submit are Pat\'s form pages to the window', () => {
  const u = F.viewUrl(ORIGIN, 'in', 'ABC123DEF456', 'RMS_Express_Form_Test_Viewer.xml', F.inReplyToRef('in', 'ABC123DEF456'));
  assert.strictEqual(u, ORIGIN + '/api/mailbox/in/ABC123DEF456/RMS_Express_Form_Test_Viewer.xml?rendertohtml=true&in-reply-to=in%2FABC123DEF456');
  assert.strictEqual(F.formUrlKind(u, ORIGIN), 'view');
  assert.strictEqual(F.requestAllowed({ url: u, method: 'GET', resourceType: 'mainFrame' }, ORIGIN), true);
  // forms.go RenderForm: "/api/form?in-reply-to=" + QueryEscape(path) + "&template=" + QueryEscape(rel template)
  const submit = ORIGIN + '/api/form?in-reply-to=in%2FABC123DEF456&template=Test+Forms%2FTest_SendReply.0';
  assert.strictEqual(F.formUrlKind(submit, ORIGIN), 'submit');
  assert.strictEqual(F.navigationVerdict(submit, ORIGIN, { submit: true }).allow, true);
  assert.strictEqual(F.requestAllowed({ url: submit, method: 'POST', resourceType: 'mainFrame' }, ORIGIN, { submit: true }), true);
});

const main = readSrc(path.join(ROOT, 'main.js'));
function fnBody(name) {
  const i = main.indexOf(`function ${name}(`);
  assert.ok(i > 0, name);
  return main.slice(i, main.indexOf('\n}\n', i));
}

test('main: Reply with form asks the gate, reads the reply form from Pat\'s copy, and opens it pre-linked', () => {
  const info = fnBody('winlinkFormInfo');
  assert.ok(info.indexOf('await winlinkFormsGate()') > 0 && /if \(!g\.ok\) return/.test(info), 'no forms on an old Pat');
  assert.ok(/patClient\.attachment\(box, mid, file\)/.test(info) && /WinlinkForms\.formReplyTemplate\(/.test(info));
  const open = fnBody('winlinkFormOpen');
  assert.ok(/const kind = o\.kind === 'view' \|\| o\.kind === 'reply' \? o\.kind : 'new';/.test(open));
  assert.ok(/if \(!info\.reply\) return \{ ok: false/.test(open), 'a form without a reply form is said, not opened');
  assert.ok(/url = WinlinkForms\.viewUrl\(origin, box, mid, file, WinlinkForms\.inReplyToRef\(box, mid\)\);/.test(open));
  assert.ok(/await openWinlinkFormWindow\(\{ url, origin, id, submit: kind !== 'view', title \}\);/.test(open), 'a reply posts; a view never does');
  assert.ok(/WinlinkMailActions\.replySubject\(/.test(open), 'Re: <subject>, the same words as Reply');
  const sub = fnBody('winlinkFormSubmitted');
  assert.ok(/if \(f\.reply && !c\.to\) c\.to = f\.reply\.to;/.test(sub) && /if \(f\.reply && !c\.subject\) c\.subject = f\.reply\.subject;/.test(sub), 'only fills what the reply form left empty');
  assert.ok(/ipcMain\.handle\('winlink-form-info'/.test(main));
});

test('the reader: Reply with form only on a received form that names one', () => {
  const js = readSrc(path.join(ROOT, 'renderer/winlink-popout.js'));
  assert.ok(/formAtt && \(openBox === 'in' \|\| openBox === 'archive'\) \? '<button class="wl-btn" id="wl-reply-form" hidden/.test(js), 'hidden until Pat\'s copy says so');
  assert.ok(/if \(b && openMid === mid && r && r\.ok && r\.reply\) \{ b\.hidden = false;/.test(js));
  assert.ok(/window\.api\.formOpen\(\{ kind: 'reply', box: openBox, mid: mid, file: formAtt\.file \}\)/.test(js));
  assert.ok(/formInfo: \(o\) => ipcRenderer\.invoke\('winlink-form-info', o\)/.test(readSrc(path.join(ROOT, 'preload-winlink-popout.js'))));
});

// ── a real Pat, offline, with made-up forms (skipped when there is none) ──

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function writeFixtureForms(dir) {
  const d = path.join(dir, 'Test Forms');
  fs.mkdirSync(d, { recursive: true });
  const form = (action, fields) => `<html><body><form method="post" enctype="multipart/form-data" action="${action}">${fields}<input type="submit"></form></body></html>`;
  fs.writeFileSync(path.join(d, 'Potacat Test.txt'), 'Form: Potacat_Test_Input.html,Potacat_Test_Viewer.html\nReplyTemplate: Potacat_Test_Reply.0\nTo: N0CALL\nSubject: Test from <var Name>\nMsg:\nName: <var Name>\n');
  fs.writeFileSync(path.join(d, 'Potacat_Test_Input.html'), form('http://{FormServer}:{FormPort}', '<input name="Name">'));
  fs.writeFileSync(path.join(d, 'Potacat_Test_Viewer.html'), '<html><body><p id="name">{var Name}</p></body></html>');
  // The reply: the original's values ({var Name}) are filled into its input page by Pat.
  fs.writeFileSync(path.join(d, 'Potacat_Test_Reply.0'), 'Form: Potacat_Test_Reply_Input.html,Potacat_Test_Reply_Viewer.html\nTo: <MsgOriginalSender>\nSubject: Re: <MsgOriginalSubject>\nMsg:\nAnswer: <var Answer>\n');
  fs.writeFileSync(path.join(d, 'Potacat_Test_Reply_Input.html'), form('http://{FormServer}:{FormPort}', '<p id="orig">{var Name}</p><input name="Answer">'));
  fs.writeFileSync(path.join(d, 'Potacat_Test_Reply_Viewer.html'), '<html><body><p id="answer">{var Answer}</p></body></html>');
  fs.writeFileSync(path.join(dir, 'Standard_Forms_Version.dat'), '0.0.0.1');
}

test('a real Pat (offline): a received form names its reply form; the reply opens pre-linked, posts, and carries its own XML', async () => {
  const WinlinkPat = require('../lib/winlink-pat');
  const bin = process.env.POTACAT_TEST_PAT || path.join(ROOT, 'assets', 'pat', WinlinkPat.patBinaryName());
  if (!fs.existsSync(bin)) { skip++; return 'skip'; }
  const { patTestEnv } = require('./modem-loopback/pat-env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-forms-reply-'));
  const port = await freePort();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(WinlinkPat.buildPatConfig({ mycall: 'N0CALL', httpPort: port }), null, 2));
  const mbox = path.join(dir, 'mailbox');
  const forms = path.join(dir, 'forms');
  fs.mkdirSync(mbox, { recursive: true });
  writeFixtureForms(forms);
  const args = WinlinkPat.buildPatArgs({ configPath: cfgPath, mboxDir: mbox, logPath: path.join(dir, 'pat.log'), eventLogPath: path.join(dir, 'pat-events.json'), formsDir: forms });
  const proc = spawn(bin, args, { stdio: 'ignore', env: patTestEnv(dir, ['N0CALL']), windowsHide: true });
  const c = new WinlinkClient({ port });
  const origin = F.patOrigin(port);
  const post = async (action, field, value, id) => {
    const fd = new FormData(); fd.append(field, value);
    return fetch(origin + action.replace(/&amp;/g, '&'), { method: 'POST', body: fd, headers: { cookie: F.formCookieHeader(id) } });
  };
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { await c.status(); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    assert.ok(up, 'Pat answered');
    // The original: filled, queued with its cookie, then moved to the Inbox as a stand-in for a received one.
    const [form] = F.shapeCatalog(await c.formCatalog()).forms;
    const page = await (await fetch(F.fillUrl(origin, form.path))).text();
    const id1 = F.newFormInstanceId(crypto.randomBytes);
    assert.strictEqual((await post(page.match(/action="([^"]+)"/)[1], 'Name', 'Casey', id1)).status, 200);
    const d1 = F.formResultToCompose(await c.formData(id1));
    await c.send(WinlinkPat.composeFields({ to: d1.to, subject: d1.subject, body: d1.body }).fields, [], { formInstance: id1 });
    const [queued] = await c.mailbox('out');
    await c.move('out', queued.mid, 'in');
    const mid = queued.mid;
    const att = F.formAttachment(queued.attachments);
    // What the reader asks: does it name a reply form?
    const xml = (await c.attachment('in', mid, att.file)).toString('utf8');
    assert.strictEqual(F.formReplyTemplate(xml), 'Potacat_Test_Reply.0');
    // The reply page, pre-linked: the original's values are in it, and its Submit carries in-reply-to.
    const replyUrl = F.viewUrl(origin, 'in', mid, att.file, F.inReplyToRef('in', mid));
    const r = await fetch(replyUrl);
    assert.strictEqual(r.status, 200);
    assert.ok(/sandbox allow-forms/.test(r.headers.get('content-security-policy') || ''), 'sandboxed by Pat 1.0.1');
    const rp = await r.text();
    assert.ok(/<p id="orig">Casey<\/p>/.test(rp), 'the original form\'s values are in the reply');
    const action = rp.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&');
    assert.strictEqual(F.formUrlKind(origin + action, origin), 'submit');
    assert.ok(new URL(origin + action).searchParams.get('in-reply-to') === 'in/' + mid, action);
    // Pat 1.0.1's path check on in-reply-to (the traversal fix).
    const evil = action.replace(/in-reply-to=[^&]+/, 'in-reply-to=' + encodeURIComponent('../../../x'));
    const bad = await post(evil, 'Answer', 'x', F.newFormInstanceId(crypto.randomBytes));
    assert.strictEqual(bad.status, 400, 'a path outside the mailbox is refused');
    // The reply posted with its own cookie comes back addressed and subjected by the reply template.
    const id2 = F.newFormInstanceId(crypto.randomBytes);
    assert.strictEqual((await post(action, 'Answer', 'Copy that', id2)).status, 200);
    const d2 = F.formResultToCompose(await c.formData(id2));
    assert.deepStrictEqual([d2.to, d2.subject], ['N0CALL', 'Re: Test from Casey']);
    assert.ok(/Answer: Copy that/.test(d2.body));
    await c.send(WinlinkPat.composeFields({ to: d2.to, subject: d2.subject, body: d2.body }).fields, [], { formInstance: id2 });
    const out = await c.mailbox('out');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(F.formAttachment(out[0].attachments).file, 'RMS_Express_Form_Potacat_Test_Reply_Viewer.xml', 'the reply carries its own form');
    const shown = await (await fetch(F.viewUrl(origin, 'out', out[0].mid, 'RMS_Express_Form_Potacat_Test_Reply_Viewer.xml'))).text();
    assert.ok(/<p id="answer">Copy that<\/p>/.test(shown));
  } finally {
    c.close();
    try { proc.kill(); } catch {}
  }
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(ROOT, 'scripts', 'run-tests.js')).includes("'test/winlink-forms-reply-test.js'"));
});

(async () => {
  console.log('Winlink forms: Reply with form (#346 phase 2)');
  for (const [name, fn] of queue) {
    try {
      const r = await fn();
      if (r === 'skip') console.log('  skip ' + name + ' (no Pat binary: assets/pat or POTACAT_TEST_PAT)');
      else { pass++; console.log('  ok  ' + name); }
    } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  // exitCode, not exit(): exiting under a just-closed fetch socket trips a libuv assert on Windows (Node 24).
  process.exitCode = fail ? 1 : 0;
})();
