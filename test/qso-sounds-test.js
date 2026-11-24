#!/usr/bin/env node
'use strict';
// QSO sounds and milestone banners (#1041): lib/qso-sounds.js decides which
// sound a logged contact makes and which daily milestones are marked; this
// pins those rules, the defaults, the qso-milestone message an ECHOCAT device
// gets, and the wiring (the sounds hang off the events the log already sends,
// and never build or change a record).
// Run: node test/qso-sounds-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const Q = require('../lib/qso-sounds');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const ALL_ON = { ...Q.DEFAULTS };
const T0 = 1000000;

console.log('QSO sounds: milestones');

test('the milestones are 1, 10, 25, 50, 100 and 250; 150, 200 and 500 stay the cat\'s, without sound', () => {
  assert.deepStrictEqual(Q.MILESTONES, [1, 10, 25, 50, 100, 250]);
  assert.deepStrictEqual(Q.CAT_RUNGS, [150, 200, 500]);
  for (const m of Q.CAT_RUNGS) assert.strictEqual(Q.MILESTONE_SOUND[m], undefined);
});

test('the banner copy, word for word', () => {
  assert.deepStrictEqual(Q.MILESTONES.map(Q.milestoneText), [
    'First contact today', '10 contacts today', '25 contacts today',
    '50 contacts today', '100 contacts today', '250 contacts today',
  ]);
});

test('each milestone\'s sound: 1 is the coin alone, then the five of the set', () => {
  assert.strictEqual(Q.MILESTONE_SOUND[1], undefined);
  assert.deepStrictEqual([10, 25, 50, 100, 250].map((m) => Q.MILESTONE_SOUND[m]), [
    'potacat-010-pickup', 'potacat-025-power-up', 'potacat-050-stage-get',
    'potacat-100-boss-down', 'potacat-250-world-clear',
  ]);
});

// One contact at `now`: logged here, then the count moves.
function contact(state, count, now, settings, evt) {
  const c = Q.contactLogged(state, evt || { origin: 'local-manual' }, now, settings || ALL_ON);
  const m = Q.countChanged(state, count, now + 5, { settings: settings || ALL_ON, needsContact: true });
  return { c, m };
}

test('a day from 0: the banner at every milestone, the sound from 10 up, nothing in between', () => {
  const st = Q.createState();
  assert.strictEqual(Q.countChanged(st, 0, T0, { needsContact: true }), null, 'the first read only marks');
  const seen = [];
  for (let n = 1; n <= 260; n++) {
    const { m } = contact(st, n, T0 + n * 30000);
    if (m) seen.push([n, m.kind, m.text, m.banner, m.sound]);
  }
  assert.deepStrictEqual(seen, [
    [1, 'milestone', 'First contact today', true, null],
    [10, 'milestone', '10 contacts today', true, 'potacat-010-pickup'],
    [25, 'milestone', '25 contacts today', true, 'potacat-025-power-up'],
    [50, 'milestone', '50 contacts today', true, 'potacat-050-stage-get'],
    [100, 'milestone', '100 contacts today', true, 'potacat-100-boss-down'],
    [150, 'cat', '', false, null],
    [200, 'cat', '', false, null],
    [250, 'milestone', '250 contacts today', true, 'potacat-250-world-clear'],
  ]);
});

test('500 is the cat\'s rung: no banner, no sound', () => {
  const st = Q.createState();
  Q.countChanged(st, 499, T0, { needsContact: true });
  const { m } = contact(st, 500, T0 + 1000);
  assert.deepStrictEqual(m, { rung: 500, kind: 'cat', text: '', banner: false, sound: null });
});

test('rungs passed before launch are marked silently; each fires once a day', () => {
  const st = Q.createState();
  assert.strictEqual(Q.countChanged(st, 30, T0, { needsContact: true }), null);
  assert.strictEqual(contact(st, 31, T0 + 1000).m, null);
  assert.strictEqual(contact(st, 50, T0 + 40000).m.rung, 50);
  assert.strictEqual(contact(st, 51, T0 + 80000).m, null);
});

test('the log was not read at launch (a new install): the first count arrives with the first contact, and it still gets its banner', () => {
  const st = Q.createState();
  assert.strictEqual(contact(st, 1, T0).m.text, 'First contact today');
  assert.strictEqual(contact(st, 2, T0 + 30000).m, null);
  // A first count of 37 that arrives with a contact: 36 were there before it. Nothing to mark.
  assert.strictEqual(contact(Q.createState(), 37, T0).m, null);
  // The phone's copy in main says so itself (afterContact).
  const main1 = Q.createState();
  assert.strictEqual(Q.countChanged(main1, 1, T0, { rungs: Q.MILESTONES, afterContact: true }).rung, 1);
  const main2 = Q.createState();
  assert.strictEqual(Q.countChanged(main2, 12, T0, { rungs: Q.MILESTONES }), null, 'a plain first read only marks');
  assert.strictEqual(Q.countChanged(main2, 13, T0 + 9, { rungs: Q.MILESTONES, afterContact: true }), null);
});

test('a new UTC day (the count drops) starts again at "First contact today"', () => {
  const st = Q.createState();
  Q.countChanged(st, 60, T0, { needsContact: true });
  const { m } = contact(st, 1, T0 + 50000);
  assert.strictEqual(m.text, 'First contact today');
});

test('several rungs passed at once: one milestone, the highest', () => {
  const st = Q.createState();
  Q.countChanged(st, 8, T0, { needsContact: true });
  const { m } = contact(st, 26, T0 + 1000);
  assert.strictEqual(m.rung, 25);
  assert.strictEqual(contact(st, 27, T0 + 60000).m, null, '10 is not played afterwards');
});

test('an import or a sync moves the count with no contact logged: marked, silent', () => {
  const st = Q.createState();
  Q.countChanged(st, 0, T0, { needsContact: true });
  assert.strictEqual(Q.countChanged(st, 12, T0 + 60000, { settings: ALL_ON, needsContact: true }), null);
  assert.strictEqual(contact(st, 13, T0 + 120000).m, null, 'and 10 is not celebrated late');
  // A contact logged long before the count moved is not this change's contact.
  const st2 = Q.createState();
  Q.countChanged(st2, 0, T0, { needsContact: true });
  Q.contactLogged(st2, { origin: 'local-manual' }, T0 + 1000, ALL_ON);
  assert.strictEqual(Q.countChanged(st2, 10, T0 + 1000 + Q.LIVE_MS + 1, { settings: ALL_ON, needsContact: true }), null);
});

test('the switches: banners off keeps the sound, milestone sounds off keeps the banner, Sounds off silences', () => {
  const run = (settings) => { const st = Q.createState(); Q.countChanged(st, 9, T0, { needsContact: true }); return contact(st, 10, T0 + 1000, settings).m; };
  assert.deepStrictEqual([run({ milestoneBanners: false }).banner, run({ milestoneBanners: false }).sound], [false, 'potacat-010-pickup']);
  assert.deepStrictEqual([run({ soundMilestones: false }).banner, run({ soundMilestones: false }).sound], [true, null]);
  assert.deepStrictEqual([run({ soundsOn: false }).banner, run({ soundsOn: false }).sound], [true, null]);
});

console.log('QSO sounds: which sound for which outcome');

test('a contact: the coin', () => {
  const st = Q.createState();
  assert.deepStrictEqual(Q.contactLogged(st, { origin: 'local-manual' }, T0, ALL_ON).sound, { file: 'potacat-coin' });
});

test('every log path this desktop logs from plays here', () => {
  for (const origin of ['local-manual', 'jtcat-engine', 'wsjtx-bridge', 'forwarded-from-host']) {
    assert.deepStrictEqual(Q.contactLogged(Q.createState(), { origin }, T0, ALL_ON).sound, { file: 'potacat-coin' }, origin);
  }
});

test('sound follows the operator: a contact the phone logged is silent on the desktop', () => {
  assert.strictEqual(Q.contactLogged(Q.createState(), { origin: 'ws-log-qso' }, T0, ALL_ON).sound, null);
  assert.strictEqual(Q.contactLogged(Q.createState(), { origin: 'jtcat-engine', fromDevice: true }, T0, ALL_ON).sound, null, 'JTCAT run from the phone');
  assert.strictEqual(Q.saveFailed({ origin: 'ws-log-qso' }).sound, null);
  // Its milestone still shows the banner here, with no sound: the phone plays that too.
  const st = Q.createState();
  Q.countChanged(st, 9, T0, { needsContact: true });
  const { m } = contact(st, 10, T0 + 1000, ALL_ON, { origin: 'ws-log-qso' });
  assert.deepStrictEqual([m.banner, m.sound], [true, null]);
});

test('a dupe: the two falling notes', () => {
  assert.deepStrictEqual(Q.contactLogged(Q.createState(), { origin: 'local-manual', dupe: true }, T0, ALL_ON).sound, { file: 'potacat-dupe' });
});

test('a refused save: the buzz, with Sounds off too', () => {
  assert.deepStrictEqual(Q.saveFailed({ origin: 'local-manual' }).sound, { file: 'potacat-save-failed' });
  assert.strictEqual(Q.saveFailed.length, 1, 'no settings are asked: it plays whatever the switches say');
});

test('a pileup: contacts closer than 20 s play the short coin, and every contact still gets one', () => {
  assert.strictEqual(Q.PILEUP_GAP_MS, 20000);
  const st = Q.createState();
  const got = [0, 12000, 24000, 60000, 79999, 100000].map((t) => Q.contactLogged(st, { origin: 'local-manual' }, T0 + t, ALL_ON).sound.file);
  assert.deepStrictEqual(got, ['potacat-coin', 'potacat-coin-short', 'potacat-coin-short', 'potacat-coin', 'potacat-coin-short', 'potacat-coin']);
});

test('one event, one sound: the records of an n-fer and the contacts a Fox logs in one cycle', () => {
  const st = Q.createState();
  const got = [0, 30, 60, 400].map((t) => Q.contactLogged(st, { origin: 'jtcat-engine' }, T0 + t, ALL_ON).sound);
  assert.deepStrictEqual(got, [{ file: 'potacat-coin' }, null, null, null]);
  assert.ok(Q.contactLogged(st, { origin: 'jtcat-engine' }, T0 + 15000, ALL_ON).sound, 'the next cycle sounds again');
});

test('the switches: Sounds off or Contact logged sound off is no contact sound', () => {
  assert.strictEqual(Q.contactLogged(Q.createState(), { origin: 'local-manual' }, T0, { soundsOn: false }).sound, null);
  assert.strictEqual(Q.contactLogged(Q.createState(), { origin: 'local-manual' }, T0, { soundContact: false }).sound, null);
  assert.strictEqual(Q.contactLogged(Q.createState(), { origin: 'local-manual', dupe: true }, T0, { soundContact: false }).sound, null);
});

test('dupe: the Activator rule (same call, band, mode, UTC day, my park), never outside an activation', () => {
  const had = [{ date: '20261124', ref: '', myRef: 'US-1111', band: '20M', mode: 'SSB' }];
  const again = { date: '20261124', ref: '', myRef: 'US-1111', band: '20M', mode: 'SSB' };
  assert.strictEqual(Q.isDupe(had, again), true);
  assert.strictEqual(Q.isDupe(had, { ...again, mode: 'USB' }), true, 'USB and LSB are SSB');
  assert.strictEqual(Q.isDupe(had, { ...again, band: '40M' }), false);
  assert.strictEqual(Q.isDupe(had, { ...again, mode: 'CW' }), false);
  assert.strictEqual(Q.isDupe(had, { ...again, date: '20261125' }), false);
  assert.strictEqual(Q.isDupe(had, { ...again, myRef: 'US-2222' }), false, 'my other park of a two-fer');
  assert.strictEqual(Q.isDupe(had, { ...again, ref: 'US-3333' }), false, 'a park-to-park at their next park');
  assert.strictEqual(Q.isDupe([{ ...had[0], myRef: '' }], { ...again, myRef: '' }), false, 'hunting: never a dupe');
  assert.strictEqual(Q.isDupe(undefined, again), false);
});

console.log('QSO sounds: defaults and migration');

test('defaults: everything on', () => {
  assert.deepStrictEqual({ ...Q.DEFAULTS }, {
    soundsOn: true, soundContact: true, soundMilestones: true, milestoneBanners: true,
    soundVolume: 80, soundOutput: '',
  });
  assert.deepStrictEqual(Q.readSettings({}), { on: true, contact: true, milestones: true, banners: true, volume: 80, output: '', outputLabel: '' });
  assert.deepStrictEqual(Q.readSettings(undefined), Q.readSettings({}));
});

test('volume stays between 10 and 100 (off is the switch, not the slider)', () => {
  assert.deepStrictEqual([0, 5, 10, 55, 100, 400, 'x', null].map((v) => Q.readSettings({ soundVolume: v }).volume), [10, 10, 10, 55, 100, 100, 80, 80]);
});

test('migration: a chime flavour picked before this build is kept; everyone else gets the coin', () => {
  for (const f of ['soft', 'twotone', 'bell', 'morse-r']) {
    assert.strictEqual(Q.contactSound(f), f);
    assert.deepStrictEqual(Q.contactLogged(Q.createState(), { origin: 'local-manual' }, T0, { qsoChime: f }).sound, { chime: f });
  }
  for (const v of ['off', undefined, '', 'coin', 'nonsense']) assert.strictEqual(Q.contactSound(v), 'coin');
  assert.deepStrictEqual(Q.contactLogged(Q.createState(), { origin: 'local-manual' }, T0, { qsoChime: 'off' }).sound, { file: 'potacat-coin' });
});

test('the one-time "Keep it, or turn it off" banner: owed once, only to an operator who never picked a chime', () => {
  assert.strictEqual(Q.coinOfferDue({ qsoChime: 'off' }), true);
  assert.strictEqual(Q.coinOfferDue({}), true);
  assert.strictEqual(Q.coinOfferDue({ soundCoinOffered: true }), false);
  assert.strictEqual(Q.coinOfferDue({ qsoChime: 'bell' }), false);
  assert.strictEqual(Q.coinOfferDue({ soundContact: false }), false);
  assert.strictEqual(Q.coinOfferDue({ soundsOn: false }), false);
  assert.deepStrictEqual({ ...Q.COIN_OFFER }, { text: 'New: a short sound each time a contact is logged.', keep: 'Keep it', off: 'Turn it off' });
});

console.log('QSO sounds: the qso-milestone message');

const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const html = readSrc(path.join(root, 'renderer', 'index.html'));
const css = readSrc(path.join(root, 'renderer', 'styles.css'));
const preload = readSrc(path.join(root, 'preload.js'));
const proto = readSrc(path.join(root, 'docs', 'echocat-protocol.md'));

test('the message shape is unchanged: type, milestone, count, mega, message', () => {
  assert.deepStrictEqual(Q.milestoneMessage(10, 11), { type: 'qso-milestone', milestone: 10, count: 11, mega: false, message: '10 contacts today' });
  assert.deepStrictEqual(Q.milestoneMessage(1, 1), { type: 'qso-milestone', milestone: 1, count: 1, mega: false, message: 'First contact today' });
  const { validate } = require('../lib/echocat-protocol');
  if (typeof validate === 'function') {
    for (const m of Q.MILESTONES) assert.ok(validate(Q.milestoneMessage(m, m)).ok !== false, 'schema accepts ' + m);
  }
});

test('the phone is sent 1, 10, 25, 50, 100, 250 and never 150, 200 or 500', () => {
  const st = Q.createState();
  Q.countChanged(st, 0, T0, { rungs: Q.MILESTONES });
  const sent = [];
  for (let n = 1; n <= 520; n++) {
    const hit = Q.countChanged(st, n, T0 + n, { rungs: Q.MILESTONES });
    if (hit) sent.push(Q.milestoneMessage(hit.rung, n));
  }
  assert.deepStrictEqual(sent.map((m) => m.milestone), [1, 10, 25, 50, 100, 250]);
  assert.ok(sent.every((m) => m.mega === false), 'mega is never true again');
});

test('main sends it from the lib, at the contact; the 500 message is retired', () => {
  const i = main.indexOf('function checkRemoteQsoMilestone(afterContact)');
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/QsoSounds\.countChanged\(_remoteMilestones, count, Date\.now\(\), \{ rungs: QsoSounds\.MILESTONES, afterContact: !!afterContact \}\)/.test(body));
  assert.ok(/remoteServer\.sendToClient\(QsoSounds\.milestoneMessage\(hit\.rung, count\)\)/.test(body));
  assert.ok(!/UNSTOPPABLE/.test(main), 'the 500 message is gone from main');
  assert.ok(!/REMOTE_QSO_MILESTONES/.test(main));
  const save = main.slice(main.indexOf('async function saveQsoRecord'), main.indexOf('async function saveQsoRecord') + 22000);
  assert.ok(/checkRemoteQsoMilestone\(true\);/.test(save), 'checked when a contact is saved');
});

test('docs/echocat-protocol.md records the change and what an old phone does', () => {
  const row = proto.split('\n').find((l) => l.startsWith('| `qso-milestone` |'));
  assert.ok(row, 'a qso-milestone row');
  for (const part of ['1, 10, 25, 50, 100', '250', 'First contact today', 'N contacts today', '150', '200', '500', 'UNSTOPPABLE', 'mega', 'qso-sounds']) {
    assert.ok(row.includes(part), part);
  }
  assert.ok(/older|old phone|without an update/i.test(row), 'says what an old phone does');
  const ok = proto.split('\n').find((l) => l.startsWith('| `log-ok` |'));
  assert.ok(/`dupe`/.test(ok), 'log-ok carries dupe');
  const srv = readSrc(path.join(root, 'lib', 'remote-server.js'));
  assert.ok(/'qso-sounds'/.test(srv), 'the shack says so in its hello');
});

console.log('QSO sounds: the wiring');

test('the sounds hang off the one logged event; main only adds who logged it and whether it is a dupe', () => {
  assert.strictEqual((main.match(/send\("qso-logged"/g) || []).length, 1, 'exactly one emitter');
  const save = main.slice(main.indexOf('async function saveQsoRecord'), main.indexOf('async function saveQsoRecord') + 22000);
  const send = save.slice(save.indexOf('send("qso-logged"'), save.indexOf('send("qso-logged"') + 400);
  assert.ok(/origin, fromDevice: origin === 'jtcat-engine' && !!qsoData\.logSource, dupe: soundDupe,/.test(send));
  assert.ok(save.indexOf('QsoLog.appendRecords(') < save.indexOf('send("qso-logged"'), 'sent after the record is written');
  assert.ok(/const soundDupe = !logAs && QsoSounds\.isDupe\(workedQsos\.get\(/.test(save));
  assert.ok(save.indexOf('const soundDupe') < save.indexOf('workedQsos.get(call).push(entry)'), 'read before this record joins the list');
});

test('a refused save is told from logContact\'s own result, never guessed', () => {
  const lc = main.slice(main.indexOf('async function logContact(entry, opts) {'), main.indexOf('function tellQsoLogFailed('));
  assert.ok(/if \(!written\.length && !\(failure && failure\.suppressed\)\) tellQsoLogFailed\(opts, failure && failure\.error\);/.test(lc));
  assert.ok(/tellQsoLogFailed\(opts, why\);\n\s+return \{ success: false, error: why, records: \[\] \};/.test(lc.replace(/\r\n/g, '\n')), 'the no-mode refusal too');
  assert.ok(/win\.webContents\.send\('qso-log-failed', \{ origin:/.test(main));
  assert.strictEqual((main.match(/send\('qso-log-failed'/g) || []).length, 1);
  assert.ok(/onQsoLogFailed: \(cb\) => ipcRenderer\.on\('qso-log-failed'/.test(preload));
});

test('nothing in the feature writes the log or builds a record', () => {
  for (const f of ['lib/qso-sounds.js', 'lib/sound-guard.js', 'renderer/sounds.js']) {
    const src = readSrc(path.join(root, f)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code, not comments
    assert.ok(!/require\(|appendRecords|mutateLog|buildAdifFields|saveQsoRecord\(|logContact\(|logQso|saveQso/.test(src), f);
  }
  const block = app.slice(app.indexOf('function onContactLogged('), app.indexOf('// --- Tune confirmation click ---'));
  assert.ok(!/window\.api\.(?!onQsoLogged|onQsoLogFailed|onJtcatChime)\w+/.test(block), 'the listeners only listen');
});

test('the main window: the lib decides, the cat keeps 150, 200 and 500', () => {
  assert.ok(/window\.api\.onQsoLogged\(\(q\) => \{ try \{ onContactLogged\(q\); \} catch \{\} \}\)/.test(app));
  assert.ok(/QsoSounds\.contactLogged\(qsoSoundState, q \|\| \{\}, Date\.now\(\), soundSettings\)/.test(app));
  const fn = app.slice(app.indexOf('function checkQsoMilestone()'), app.indexOf('// --- Milestone banner (#1041) ---'));
  assert.ok(/QsoSounds\.countChanged\(qsoSoundState, count, Date\.now\(\), \{ settings: soundSettings, needsContact: true \}\)/.test(fn));
  assert.ok(/if \(hit\.rung === 500\) \{\s+showMegaCelebration\(/.test(fn) && /showCatCelebration\(`\$\{hit\.rung\} QSOs today! Keep going!`\)/.test(fn));
  assert.ok(/if \(hit\.banner\) showMilestoneBanner\(hit\.text\);/.test(fn));
  assert.ok(/if \(hit\.sound\) PotacatSounds\.playFile\(hit\.sound\);/.test(fn));
  assert.ok(!/QSO_MILESTONES|celebratedMilestones/.test(app), 'one list of rungs, in the lib');
});

test('the banner: about 3 s, fades, takes no click or focus, and is placed clear of the log entry and TX controls', () => {
  assert.strictEqual(Q.BANNER_MS, 3000);
  const fn = app.slice(app.indexOf('function showMilestoneBanner('), app.indexOf('function showCoinOffer('));
  assert.ok(/el\.textContent = text;/.test(fn), 'plain text, one line');
  assert.ok(/setTimeout\(\(\) => el\.classList\.add\('leaving'\), QsoSounds\.BANNER_MS\)/.test(fn));
  assert.ok(!/focus\(|tabIndex|showModal|<button/.test(fn));
  assert.ok(/const TOP_BANNER_AVOID = \['#banner-logger', '#remote-ptt-btn', '#jtcat-tx-indicator', '#jtcat-halt-tx', '\.milestone-banner'\];/.test(app));
  const i = css.indexOf('.milestone-banner {');
  const rule = css.slice(i, css.indexOf('}', i));
  for (const part of ['left: 50%;', 'pointer-events: none;', 'white-space: nowrap;', 'background: var(--bg-primary);', 'color: var(--text-primary);', 'border: 2px solid var(--accent-green);', 'transition: opacity']) {
    assert.ok(rule.includes(part), part);
  }
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rule), 'theme tokens, no fixed colours');
  assert.ok(/\.milestone-banner\.leaving \{ opacity: 0; \}/.test(css));
});

test('the Sounds pane: its own tab, the labels of the issue, everything on', () => {
  assert.ok(/<button type="button" class="settings-tab" data-tab="sounds">Sounds<\/button>/.test(html));
  const i = html.indexOf('data-settings-tab="sounds"');
  const pane = html.slice(i, html.indexOf('</fieldset>', i));
  for (const label of [
    '<input type="checkbox" id="set-sounds-on" checked> Sounds</label>',
    '<input type="checkbox" id="set-sound-contact" checked> Contact logged sound</label>',
    '<input type="checkbox" id="set-sound-milestones" checked> Milestone sounds</label>',
    '<input type="checkbox" id="set-milestone-banners" checked> Milestone banners</label>',
    'Volume:', '<input type="range" id="set-sound-volume" min="10" max="100" step="5" value="80">',
    '<button type="button" id="set-qso-chime-play" class="btn btn-sm" aria-label="Play the chosen sound">Play</button>', // Play replaced Test (test/sounds-pane-preview-test.js)
    'Sound output:', '<option value="">Automatic</option>',
    'id="set-sound-status"',
  ]) assert.ok(pane.includes(label), label);
  assert.ok(/<option value="coin">Coin<\/option>\s+<option value="soft">Soft ding<\/option>/.test(pane), 'the coin first, then the four chimes');
  assert.strictEqual((html.match(/id="set-qso-chime"/g) || []).length, 1, 'the chime select moved here from Settings > Spots');
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(pane), 'no emoji');
});

test('the pane is loaded, saved and machine-wide', () => {
  assert.ok(/applySoundSettings\(settings\);/.test(app));
  assert.ok(/fillSoundsPane\(s\);/.test(app));
  assert.ok(/\.\.\.readSoundsPane\(\),/.test(app));
  // Save never loses the chosen output: it is written only once its list is
  // there, and an unplugged output stays in the list as the choice.
  const read = app.slice(app.indexOf('function readSoundsPane()'), app.indexOf('function soundOutputLabelOf('));
  assert.ok(/if \(soundOutputsListed\) \{\s+out\.soundOutput = soundsPane\.output\.value \|\| '';/.test(read));
  assert.ok(/if \(info\.chosen === 'missing'\) \{/.test(app) && /\+ ' \(not connected\)';/.test(app));
  const keys =main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  for (const k of ['soundsOn', 'soundContact', 'soundMilestones', 'milestoneBanners', 'soundVolume', 'soundOutput', 'soundOutputLabel', 'soundCoinOffered']) {
    assert.ok(keys.includes("'" + k + "'"), k);
  }
});

test('every sound the lib names is a file made by the generator, and the page loads the modules in order', () => {
  for (const id of Q.FILES) assert.ok(fs.existsSync(path.join(root, 'renderer', 'sounds', id + '.wav')), id);
  assert.strictEqual(Q.FILES.length, 9);
  const order = ['../lib/qso-sounds.js', '../lib/sound-guard.js', 'sounds.js', 'app.js'].map((f) => html.indexOf('<script src="' + f + '"></script>'));
  assert.ok(order.every((n) => n > 0) && order.join() === order.slice().sort((a, b) => a - b).join());
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
