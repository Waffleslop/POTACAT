'use strict';

// Central registry of every secret that can live in the settings object,
// and the strip/restore pair used by Settings → Export/Import.
//
// Why: export-settings redacted via a hard-coded 3-key blocklist
// (qrzPassword, remoteToken, smartSdrClientId) that silently rotted as
// secrets accumulated — by v1.9.5 an exported settings.json carried
// sotaPassword, every rig's catTarget.password (K4 / RS-BA1), cluster node
// passwords (HamAlert), ECHOCAT paired-device bearer tokens, and cloud
// tokens in plaintext. Users share exports with friends and attach them to
// help requests. ONE list, used everywhere; add new secrets HERE.

// Top-level scalar secrets — stripped on export, re-grafted from the
// current settings on import when the imported file lacks them.
const SECRET_KEYS = [
  'qrzPassword',
  'qrzApiKey',
  'sotaPassword',
  'wavelogApiKey',
  'remoteToken',       // ECHOCAT legacy shared token
  'echocatToken',      // ECHOCAT machine token
  'cloudAccessToken',  // POTACAT Cloud JWTs
  'cloudRefreshToken',
  'smartSdrClientId',  // not a secret, but machine identity — never portable
];

// Whole arrays that are machine/deployment-bound credentials: ECHOCAT
// paired phones (each entry carries a raw bearer token = full rig control)
// and desktop-to-desktop connection targets (deviceToken). Exporting them
// is both a credential leak and useless on another machine — re-pairing is
// the correct flow. Stripped entirely; import keeps the current machine's.
const MACHINE_CREDENTIAL_ARRAYS = ['pairedDevices', 'connectionTargets'];

function _cloneSansPassword(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  delete out.password;
  return out;
}

/**
 * Deep-enough clone of `settings` with every registered secret removed.
 * Never mutates the input. Safe to serialize and hand to a user.
 */
function stripSecrets(settings) {
  const out = { ...(settings || {}) };
  for (const k of SECRET_KEYS) delete out[k];
  for (const k of MACHINE_CREDENTIAL_ARRAYS) delete out[k];
  // Active CAT target (K4 network / Icom Network passwords)
  if (out.catTarget) out.catTarget = _cloneSansPassword(out.catTarget);
  // Per-rig CAT targets
  if (Array.isArray(out.rigs)) {
    out.rigs = out.rigs.map(r =>
      r && r.catTarget ? { ...r, catTarget: _cloneSansPassword(r.catTarget) } : (r ? { ...r } : r));
  }
  // Cluster node passwords (HamAlert etc.)
  if (Array.isArray(out.clusterNodes)) {
    out.clusterNodes = out.clusterNodes.map(n => (n ? _cloneSansPassword(n) : n));
  }
  return out;
}

/**
 * Graft the current machine's secrets back onto an imported settings
 * object wherever the import doesn't carry its own value. Handles the
 * nested cases a shallow `{...current, ...imported}` merge gets wrong:
 * imported.rigs/clusterNodes REPLACE the current arrays wholesale, so a
 * stripped export imported back would silently wipe every stored rig and
 * cluster password. Matches rigs and cluster nodes by id. Mutates and
 * returns `imported`.
 */
function restoreSecrets(imported, current) {
  if (!imported || typeof imported !== 'object') return imported;
  const cur = current || {};
  for (const k of SECRET_KEYS) {
    if (imported[k] == null && cur[k] != null) imported[k] = cur[k];
  }
  for (const k of MACHINE_CREDENTIAL_ARRAYS) {
    if (imported[k] == null && cur[k] != null) imported[k] = cur[k];
  }
  // Active CAT target — same transport shape means the current password
  // still belongs to it.
  if (imported.catTarget && !imported.catTarget.password &&
      cur.catTarget && cur.catTarget.password &&
      imported.catTarget.type === cur.catTarget.type) {
    imported.catTarget.password = cur.catTarget.password;
  }
  if (Array.isArray(imported.rigs) && Array.isArray(cur.rigs)) {
    for (const rig of imported.rigs) {
      if (!rig || !rig.catTarget || rig.catTarget.password) continue;
      const match = cur.rigs.find(r => r && r.id === rig.id);
      if (match && match.catTarget && match.catTarget.password) {
        rig.catTarget.password = match.catTarget.password;
      }
    }
  }
  if (Array.isArray(imported.clusterNodes) && Array.isArray(cur.clusterNodes)) {
    for (const node of imported.clusterNodes) {
      if (!node || node.password) continue;
      const match = cur.clusterNodes.find(n => n && n.id === node.id);
      if (match && match.password) node.password = match.password;
    }
  }
  return imported;
}

module.exports = { SECRET_KEYS, MACHINE_CREDENTIAL_ARRAYS, stripSecrets, restoreSecrets };
