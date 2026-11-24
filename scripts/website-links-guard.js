#!/usr/bin/env node
'use strict';
// scripts/website-links-guard.js
//
// The release workflow's update-website job pushes potacat-website index.html
// straight to master, and that push is a production deploy. This module keeps
// that push to version strings only:
//
//   updateDownloadVersions(html, version)  changes version strings in place
//     inside the DOWNLOAD-START/END block and the hero intel-mac href, and
//     nothing else (used by scripts/update-website-links.js).
//   checkVersionOnlyDiff(oldHtml, newHtml, { version })  passes only when
//     every changed line is inside the DOWNLOAD block or is the intel-mac hero
//     line, and the only differences on those lines are version strings
//     (X.Y.Z, with or without a leading v). Anything else fails with a list of
//     the offending lines.
//
// CLI (used by .github/workflows/release.yml):
//   node scripts/website-links-guard.js <old.html> <new.html> <version> [--report <file>]
// Exit 0 = pass. Exit 1 = fail; the offending lines are printed and, with
// --report, written to <file> as Markdown for the website handoff.
//
// Lives in scripts/, not lib/, because it is CI-only and lib/ ships in the app.

const START_RE = /<!-- DOWNLOAD-START\b/;
const END_RE = /<!-- DOWNLOAD-END -->/;
const VERSION_RE = /\d+\.\d+\.\d+/g;
const INTEL_MAC_RE = /class="intel-mac"/;
const LINK_RE = /<a\b/g;

function splitLines(text) {
  // Split on \n only, so a CRLF/LF change shows up as changed lines.
  return String(text).split('\n');
}

// [start, end] line indexes (inclusive) of the DOWNLOAD block, or null.
function blockRange(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && START_RE.test(lines[i])) start = i;
    else if (start >= 0 && END_RE.test(lines[i])) return [start, i];
  }
  return null;
}

function normalise(line) {
  return line.replace(VERSION_RE, '<VER>');
}

function countLinks(lines, range) {
  if (!range) return 0;
  let n = 0;
  for (let i = range[0]; i <= range[1]; i++) n += (lines[i].match(LINK_RE) || []).length;
  return n;
}

// The release version the block currently points at, from its first asset URL.
function blockVersion(html) {
  const lines = splitLines(html);
  const r = blockRange(lines);
  if (!r) return null;
  const body = lines.slice(r[0], r[1] + 1).join('\n');
  const m = body.match(/\/releases\/(?:download|tag)\/v(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Point the download block and the hero intel-mac link at `version` by
 * replacing version strings in place. Never adds, removes or reorders markup.
 * Returns { html, oldVersion, changed } or throws when the block is missing.
 */
function updateDownloadVersions(html, version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('version must be X.Y.Z, got ' + version);
  const lines = splitLines(html);
  const r = blockRange(lines);
  if (!r) throw new Error('DOWNLOAD-START / DOWNLOAD-END markers not found; the website download block needs a human (handoff to the website session)');
  const oldVersion = blockVersion(html);
  if (!oldVersion) throw new Error('no /releases/download/vX.Y.Z/ link inside the DOWNLOAD block');
  const oldRe = new RegExp('(^|[^\\d.])' + escapeRe(oldVersion) + '(?![\\d]|\\.\\d)', 'g');
  for (let i = r[0]; i <= r[1]; i++) {
    lines[i] = lines[i].replace(oldRe, (m, pre) => pre + version);
  }
  // The hero "On an Intel Mac? Get the Intel build" link sits outside the
  // block (1.13.0 shipped with it on 1.12.0). Only its href changes, and only
  // its version strings, so a stale hero link is brought along too.
  for (let i = 0; i < lines.length; i++) {
    if (i >= r[0] && i <= r[1]) continue;
    if (!INTEL_MAC_RE.test(lines[i])) continue;
    lines[i] = lines[i].replace(/(<a class="intel-mac" href=")([^"]*)(")/g,
      (m, a, href, b) => a + href.replace(VERSION_RE, version) + b);
  }
  const out = lines.join('\n');
  return { html: out, oldVersion, changed: out !== html };
}

/**
 * Pass only when the new file differs from the old one by version strings
 * inside the DOWNLOAD block or on the intel-mac hero line.
 * Returns { ok, offending: [{ kind, line, old, new, detail }], linksOld, linksNew }.
 * `line` numbers are 1-based in the old file (or the new file for additions).
 */
function checkVersionOnlyDiff(oldHtml, newHtml, opts = {}) {
  const version = opts.version ? String(opts.version) : null;
  const a = splitLines(oldHtml);
  const b = splitLines(newHtml);
  const offending = [];
  const ra = blockRange(a);
  const rb = blockRange(b);
  const linksOld = countLinks(a, ra);
  const linksNew = countLinks(b, rb);

  if (!ra) offending.push({ kind: 'structure', line: 0, detail: 'old index.html has no DOWNLOAD-START/END block' });
  if (!rb) offending.push({ kind: 'structure', line: 0, detail: 'new index.html has no DOWNLOAD-START/END block' });
  if (ra && rb && linksOld !== linksNew) {
    offending.push({ kind: 'link-count', line: ra[0] + 1, detail: `DOWNLOAD block has ${linksOld} links before and ${linksNew} after` });
  }

  const inAllowed = (lines, range, i) =>
    (range && i >= range[0] && i <= range[1]) || INTEL_MAC_RE.test(lines[i]);

  if (a.length !== b.length) {
    // Lines were added or removed. Trim the common head and tail (version-only
    // differences count as common) and report everything in between.
    let head = 0;
    while (head < a.length && head < b.length && normalise(a[head]) === normalise(b[head])) head++;
    let ta = a.length - 1, tb = b.length - 1;
    while (ta >= head && tb >= head && normalise(a[ta]) === normalise(b[tb])) { ta--; tb--; }
    const inside = ra && head >= ra[0] && head <= ra[1] + 1;
    offending.push({
      kind: inside ? 'structure' : 'outside',
      line: head + 1,
      detail: `${a.length} lines before, ${b.length} after: lines were added or removed ${inside ? 'inside' : 'outside'} the DOWNLOAD block`,
    });
    const CAP = 40;
    let shown = 0;
    for (let i = head; i <= ta && shown < CAP; i++, shown++) offending.push({ kind: 'removed', line: i + 1, old: a[i] });
    for (let i = head; i <= tb && shown < CAP; i++, shown++) offending.push({ kind: 'added', line: i + 1, new: b[i] });
    return { ok: false, offending, linksOld, linksNew };
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const allowed = inAllowed(a, ra, i) && inAllowed(b, rb, i);
    if (!allowed) {
      offending.push({ kind: 'outside', line: i + 1, old: a[i], new: b[i], detail: 'changed outside the DOWNLOAD block and the intel-mac hero link' });
      continue;
    }
    if (normalise(a[i]) !== normalise(b[i])) {
      offending.push({ kind: 'structure', line: i + 1, old: a[i], new: b[i], detail: 'changed more than version strings' });
      continue;
    }
    if (version) {
      const stray = (b[i].match(VERSION_RE) || []).filter((v, k) => v !== version && v !== (a[i].match(VERSION_RE) || [])[k]);
      if (stray.length) {
        offending.push({ kind: 'version', line: i + 1, old: a[i], new: b[i], detail: `version strings changed to ${stray.join(', ')}, not ${version}` });
      }
    }
  }
  return { ok: offending.length === 0, offending, linksOld, linksNew };
}

function formatOffending(result) {
  const out = [];
  for (const o of result.offending) {
    const where = o.line ? `line ${o.line}` : 'file';
    out.push(`- ${o.kind} at ${where}${o.detail ? ': ' + o.detail : ''}`);
    if (o.old !== undefined) out.push('    - old: `' + o.old.replace(/`/g, "'") + '`');
    if (o.new !== undefined) out.push('    + new: `' + o.new.replace(/`/g, "'") + '`');
  }
  return out.join('\n');
}

module.exports = { updateDownloadVersions, checkVersionOnlyDiff, formatOffending, blockVersion, blockRange };

if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const ri = args.indexOf('--report');
  const report = ri >= 0 ? args[ri + 1] : null;
  if (ri >= 0) args.splice(ri, 2);
  const [oldPath, newPath, version] = args;
  if (!oldPath || !newPath || !version) {
    console.error('Usage: node scripts/website-links-guard.js <old.html> <new.html> <version> [--report <file>]');
    process.exit(2);
  }
  const result = checkVersionOnlyDiff(fs.readFileSync(oldPath, 'utf8'), fs.readFileSync(newPath, 'utf8'), { version });
  if (result.ok) {
    console.log(`website links guard: pass (version strings only, ${result.linksNew} links in the DOWNLOAD block)`);
    process.exit(0);
  }
  const text = formatOffending(result);
  console.log('website links guard: FAIL, the index.html change is more than version strings:');
  console.log(text);
  if (report) fs.writeFileSync(report, text + '\n', 'utf8');
  process.exit(1);
}
