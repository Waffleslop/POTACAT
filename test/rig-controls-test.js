// Anti-drift guard for rig-control. Both transports (desktop IPC + ECHOCAT
// phone) route through the single main.js `applyRigControl`, so they cannot
// diverge from each other. This test pins the remaining seam: the dispatcher's
// handled actions must match the canonical registry in lib/rig-controls.js
// exactly — so a control can't be wired without metadata, or declared without
// being wired. (This is the regression that silently broke NR/Comp/ANF/VOX on
// the phone before the unification.)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RIG_CONTROLS } = require('../lib/rig-controls');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const VALID_KINDS = new Set(['toggle', 'level', 'momentary', 'enum']);
const VALID_GROUPS = new Set(['rx', 'tx', 'tune', 'power', 'cw', 'freq', 'ant']);

check('registry entries are well-formed', () => {
  for (const [action, meta] of Object.entries(RIG_CONTROLS)) {
    assert(VALID_KINDS.has(meta.kind), `${action}: bad kind "${meta.kind}"`);
    assert(VALID_GROUPS.has(meta.group), `${action}: bad group "${meta.group}"`);
    if (!meta.internal) {
      assert(typeof meta.label === 'string' && meta.label.length, `${action}: missing label`);
      assert(typeof meta.help === 'string' && meta.help.length, `${action}: missing help`);
    }
  }
});

// Pull the action `case` labels out of the single dispatcher in main.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = src.indexOf('applyRigControl = function');
const end = src.indexOf("ipcMain.handle('rig-control'", start);

check('applyRigControl is locatable in main.js', () => {
  assert(start !== -1, 'could not find `applyRigControl = function` in main.js');
  assert(end !== -1 && end > start, "could not find the ipcMain.handle('rig-control') delegation after it");
});

check('dispatcher actions and registry are in exact parity', () => {
  const body = src.slice(start, end);
  const cases = new Set();
  const re = /case '([^']+)':/g;
  let m;
  while ((m = re.exec(body))) cases.add(m[1]);

  const declared = new Set(Object.keys(RIG_CONTROLS));
  const handledNotDeclared = [...cases].filter((c) => !declared.has(c)).sort();
  const declaredNotHandled = [...declared].filter((c) => !cases.has(c)).sort();

  assert.deepStrictEqual(handledNotDeclared, [],
    `handled by applyRigControl but missing from lib/rig-controls.js: ${handledNotDeclared.join(', ')}`);
  assert.deepStrictEqual(declaredNotHandled, [],
    `declared in lib/rig-controls.js but not handled by applyRigControl: ${declaredNotHandled.join(', ')}`);

  assert(cases.size >= 30, `expected the full control set, only found ${cases.size} cases`);
});

check('there is no second rig-control switch (drift trap)', () => {
  // The ECHOCAT transport must delegate, not re-implement.
  assert(/remoteServer\.on\('rig-control',\s*\(data\)\s*=>\s*applyRigControl\(data, 'echocat'\)\)/.test(src),
    "ECHOCAT rig-control must delegate to applyRigControl(data, 'echocat'), not contain its own switch");
});

if (failures) {
  console.error(`\nrig-controls-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nrig-controls-test: OK — ${Object.keys(RIG_CONTROLS).length} actions in parity`);
