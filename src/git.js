'use strict';
// Everything the gate asks of git. git already knows the content hash of every tracked file, so a repository with
// 200,000 files is listed without reading one of them; the hash is the cache key for everything derived from a file.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX = 1 << 30;
function git(root, args, { allowFail = false, okCodes = [0] } = {}) {
  try {
    return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (okCodes.includes(e.status)) return e.stdout || '';
    if (allowFail) return null;
    throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

const isRepo = (root) => git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';

const SKIP_DIR = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', 'vendor', '.next', 'coverage', '__pycache__']);
function walk(root, limit) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of ents) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) stack.push(rel); } else if (e.isFile()) out.push({ path: rel, sha: null });
    }
  }
  return out;
}

/**
 * Files of the working tree: [{path, sha}], sorted by path. sha is the git blob hash when the working copy equals
 * the index, otherwise null (the caller hashes the content): a stale hash would poison the cache on a developer's
 * machine, where files are edited but not yet staged.
 */
function listFiles(root, { limit = 400000 } = {}) {
  if (!isRepo(root)) return { files: walk(root, limit).sort((a, b) => (a.path < b.path ? -1 : 1)), git: false };
  const files = new Map();
  for (const rec of git(root, ['ls-files', '-s', '-z']).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, hash] = rec.slice(0, tab).split(' ');
    if (mode === '160000' || mode === '120000') continue; // submodule, symlink
    files.set(rec.slice(tab + 1), hash);
  }
  const dirty = (git(root, ['diff', '--name-only', '-z'], { allowFail: true }) || '').split('\0').filter(Boolean);
  for (const p of dirty) if (files.has(p)) files.set(p, null);
  const deleted = (git(root, ['ls-files', '-d', '-z'], { allowFail: true }) || '').split('\0').filter(Boolean);
  for (const p of deleted) files.delete(p);
  const untracked = (git(root, ['ls-files', '-o', '--exclude-standard', '-z'], { allowFail: true }) || '').split('\0').filter(Boolean);
  for (const p of untracked) files.set(p, null);
  const out = [...files].map(([p, s]) => ({ path: p, sha: s })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files: out.slice(0, limit), git: true, truncated: out.length > limit ? out.length - limit : 0 };
}

/** Parse a unified diff (-U0) into Map(path → {status, added: [[from, to]], addedLines, from?}). */
function parseDiff(text) {
  const files = new Map();
  /** @type {any} */
  let cur = null;
  let oldPath = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) { cur = null; oldPath = null; continue; }
    if (line.startsWith('--- ')) { oldPath = line.slice(4).trim() === '/dev/null' ? null : strip(line.slice(4)); continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim() === '/dev/null' ? null : strip(line.slice(4));
      if (p) { cur = { status: oldPath ? (oldPath === p ? 'M' : 'R') : 'A', added: [], addedLines: 0 }; if (oldPath && oldPath !== p) cur.from = oldPath; files.set(p, cur); }
      else if (oldPath) { files.set(oldPath, { status: 'D', added: [], addedLines: 0 }); cur = null; }
      continue;
    }
    const m = cur && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
      if (n > 0) { cur.added.push([start, start + n - 1]); cur.addedLines += n; }
    }
  }
  return files;
}
const strip = (p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^[ab]\//, '');

/**
 * The change under review. `base` is a commit (pull request), `staged` the index (pre-commit), neither the working
 * tree against HEAD. A pull request is compared with the merge base when the history is there, and with the base
 * commit itself in a shallow clone.
 */
function changes(root, /** @type {any} */ { base, staged } = {}) {
  const flags = ['-U0', '--no-color', '--no-ext-diff', '--find-renames'];
  let text = null;
  if (base) text = git(root, ['diff', ...flags, `${base}...HEAD`], { allowFail: true }) ?? git(root, ['diff', ...flags, base, 'HEAD'], { allowFail: true });
  else if (staged) text = git(root, ['diff', '--cached', ...flags], { allowFail: true });
  else text = git(root, ['diff', ...flags, 'HEAD'], { allowFail: true });
  if (text === null) return null;
  // files that are binary or renamed without edits carry no hunks; name-status still lists them
  const files = parseDiff(text);
  const ns = base ? git(root, ['diff', '--name-status', '--find-renames', base, 'HEAD'], { allowFail: true }) : null;
  for (const l of (ns || '').split('\n')) {
    const [st, a, b] = l.split('\t');
    const p = b || a;
    if (p && !files.has(p)) files.set(p, { status: st[0], added: [], addedLines: 0 });
  }
  return files;
}

/** Lines matching an extended regex across tracked files: [{path, line, text}]. Scales with git, not with us. */
function grep(root, pattern, { max = 20000 } = {}) {
  const out = git(root, ['grep', '-n', '-I', '-i', '-E', '--no-color', '--untracked', '-e', pattern], { allowFail: true, okCodes: [0, 1] });
  if (!out) return [];
  const hits = [];
  for (const l of out.split('\n')) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 400) });
    if (hits.length >= max) break;
  }
  return hits;
}

const head = (root) => git(root, ['rev-parse', '--short', 'HEAD'], { allowFail: true })?.trim() || null;

module.exports = { listFiles, changes, parseDiff, grep, isRepo, head };
