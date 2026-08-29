#!/usr/bin/env node
'use strict';
// Merge the two per-arch latest-mac.yml channel files into ONE manifest
// listing all four mac artifacts (x64 + arm64 zip/dmg).
//
// Why this exists: the release workflow builds macOS x64 and arm64 in two
// SEPARATE jobs, and each electron-builder run writes its own latest-mac.yml
// naming only its own arch's files. Both artifacts staged into dist/ meant
// whichever copy landed last won — a per-release COIN FLIP (x64 won 1.10.5,
// .6, .8, .9, .11, .12; arm64 won 1.10.10). Consequences, both field-hit:
// an arm64-only manifest breaks Intel auto-update outright ("ZIP file not
// provided"), and an x64-only manifest silently installs the x64 build on
// Apple Silicon, so the app arch FLAPS release to release and native users
// end up under Rosetta with the FT8 native addon emulated (W3DFX thread,
// 2026-08-28). electron-updater picks per-arch from files[] when both are
// present, so the fix is one merged manifest.
//
// electron-updater fetches exactly "latest-mac.yml", so per-arch FILENAMES
// are not an option — the arm64 job renames its copy to latest-mac-arm64.yml
// purely so both survive artifact staging, and this script folds it back in.
//
// Dependency-free on purpose: the create-release job has no node_modules.
// The channel file is a fixed electron-builder shape, so a purpose-built
// parser is safer than vendoring YAML — and it BAILS on anything it does
// not recognize (a loud CI failure beats shipping a misparsed manifest).
//
// Usage: node scripts/merge-latest-mac.js <primary.yml> <secondary.yml>
// Merges secondary's files[] into primary (dedupe by url), keeps primary's
// version/path/sha512/releaseDate, rewrites primary, DELETES secondary.
// Refuses on version mismatch (a stale artifact must fail the release).

const fs = require('fs');

/** Parse the fixed electron-builder channel-file shape. Throws on surprises. */
function parseChannelYml(text) {
  const out = { version: null, files: [], path: null, sha512: null, releaseDate: null };
  let cur = null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^version:\s*(\S+)\s*$/))) { out.version = m[1]; continue; }
    if (/^files:\s*$/.test(line)) { continue; }
    if ((m = line.match(/^  - url:\s*(\S+)\s*$/))) { cur = { url: m[1] }; out.files.push(cur); continue; }
    if ((m = line.match(/^    sha512:\s*(\S+)\s*$/))) {
      if (!cur) throw new Error('file sha512 before any url: ' + line);
      cur.sha512 = m[1]; continue;
    }
    if ((m = line.match(/^    size:\s*(\d+)\s*$/))) {
      if (!cur) throw new Error('file size before any url: ' + line);
      cur.size = Number(m[1]); continue;
    }
    if ((m = line.match(/^path:\s*(\S+)\s*$/))) { out.path = m[1]; cur = null; continue; }
    if ((m = line.match(/^sha512:\s*(\S+)\s*$/))) { out.sha512 = m[1]; cur = null; continue; }
    if ((m = line.match(/^releaseDate:\s*'([^']+)'\s*$/))) { out.releaseDate = m[1]; cur = null; continue; }
    throw new Error('unrecognized channel-file line (refusing to merge blind): ' + JSON.stringify(line));
  }
  if (!out.version) throw new Error('channel file has no version');
  if (out.files.length === 0) throw new Error('channel file lists no files');
  for (const f of out.files) {
    if (!f.sha512 || !Number.isFinite(f.size)) throw new Error('incomplete file entry: ' + JSON.stringify(f));
  }
  return out;
}

/** Serialize back in electron-builder's exact format. */
function serializeChannelYml(data) {
  const lines = ['version: ' + data.version, 'files:'];
  for (const f of data.files) {
    lines.push('  - url: ' + f.url);
    lines.push('    sha512: ' + f.sha512);
    lines.push('    size: ' + f.size);
  }
  lines.push('path: ' + data.path);
  lines.push('sha512: ' + data.sha512);
  lines.push("releaseDate: '" + data.releaseDate + "'");
  return lines.join('\n') + '\n';
}

/** Merge secondary's files into primary. Pure; throws on version mismatch. */
function mergeChannelData(primary, secondary) {
  if (primary.version !== secondary.version) {
    throw new Error(
      'version mismatch: primary=' + primary.version + ' secondary=' + secondary.version +
      ' — a stale build artifact must fail the release, not ship a mixed manifest');
  }
  const seen = new Set(primary.files.map((f) => f.url));
  const merged = { ...primary, files: primary.files.slice() };
  for (const f of secondary.files) {
    if (!seen.has(f.url)) { merged.files.push(f); seen.add(f.url); }
  }
  return merged;
}

function main(primaryPath, secondaryPath) {
  const primary = parseChannelYml(fs.readFileSync(primaryPath, 'utf8'));
  const secondary = parseChannelYml(fs.readFileSync(secondaryPath, 'utf8'));
  const merged = mergeChannelData(primary, secondary);
  fs.writeFileSync(primaryPath, serializeChannelYml(merged));
  fs.unlinkSync(secondaryPath);
  console.log('[merge-latest-mac] ' + primaryPath + ' now lists ' + merged.files.length +
    ' files for v' + merged.version + ' (' + merged.files.map((f) => f.url).join(', ') + ')');
}

module.exports = { parseChannelYml, serializeChannelYml, mergeChannelData };

if (require.main === module) {
  const [primary, secondary] = process.argv.slice(2);
  if (!primary || !secondary) {
    console.error('usage: merge-latest-mac.js <primary latest-mac.yml> <secondary latest-mac-arm64.yml>');
    process.exit(2);
  }
  try {
    main(primary, secondary);
  } catch (err) {
    console.error('[merge-latest-mac] FATAL: ' + err.message);
    process.exit(1);
  }
}
