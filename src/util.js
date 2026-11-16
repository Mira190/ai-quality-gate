'use strict';
// Small shared helpers. Everything here is pure or touches only the local file system.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha = (s, n = 16) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

/** Glob → RegExp. Supports **, *, ?, {a,b}. Paths always use forward slashes. */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A matcher for a list of globs; a glob without a slash matches at any depth. */
function matcher(globs) {
  const res = (globs || []).filter(Boolean).map((g) => globToRe(g.includes('/') ? g.replace(/^\.\//, '') : '**/' + g));
  return (p) => res.some((r) => r.test(p));
}

/** Run fn over items with at most `n` in flight. Results keep the input order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

const STOP = new Set(('a an and are as at be been but by can could do does for from had has have if in into is it its may might more most must ' +
  'no not of on only or other shall should so some such than that the their them then there these they this those to was were when where which ' +
  'while who will with would each every any all per via within without after before between during system user users test tests spec should ' +
  'given when then it describe expect assert true false null undefined return const let var function async await new').split(' '));

/** Light stemmer: enough to make "discounts"/"discounted" meet "discount". Deterministic, no dictionary. */
// Word families, short forms and ideas live in lexicon.js: general facts about English and about how programmers
// write, with the rules for changing them.
const { stem, ideaOf, joinCompounds, IDEA_WORDS } = require('./lexicon');

/**
 * Words of a text for matching: camelCase and snake_case are split, numbers are kept (limits such as "20" matter),
 * CJK runs become bigrams. Returns stems in order of appearance, duplicates included.
 */
function tokenize(text) {
  const out = [];
  // "each other" is two stop words and one meaning (things acting on one another: colliding, overlapping, queueing).
  // Kept as one word, it is often the only thing a rule and its test have in common.
  const s = joinCompounds(String(text)).replace(/\b(each other|one another)\b/gi, ' mutual ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  for (const m of s.matchAll(/[A-Za-z]+|\d+(?:\.\d+)?|[一-鿿]+/g)) {
    const w = m[0];
    if (/[一-鿿]/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (/^\d/.test(w)) out.push(w);
    else {
      const l = w.toLowerCase();
      // a stop word is kept when it names an idea ("first", "after", "most", "once")
      if (l.length > 1 && (IDEA_WORDS.has(l) || !STOP.has(l))) { const t = stem(l); out.push(t); const idea = ideaOf(t); if (idea) out.push(idea); }
    }
  }
  return out;
}
const uniq = (a) => [...new Set(a)];

const isBinary = (buf) => buf.subarray(0, 4096).includes(0);

/** Read a text file, at most maxBytes. Returns null for a missing, binary or unreadable file. */
function readText(file, maxBytes = 1 << 20) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (isBinary(buf)) return null;
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** Write through a temporary file so a killed run never leaves half a file behind. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const by = (...keys) => (a, b) => { for (const k of keys) { const c = cmp(k(a), k(b)); if (c) return c; } return 0; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const count = (arr, fn) => arr.reduce((n, x) => n + (fn(x) ? 1 : 0), 0);
const groupBy = (arr, fn) => { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

module.exports = { ideaOf, sha, globToRe, matcher, escapeRe, pool, tokenize, stem, uniq, isBinary, readText, writeAtomic, readJson, clip, cmp, by, plural, count, groupBy };
