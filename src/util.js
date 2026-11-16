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
// Short forms programmers write and prose spells out. Both become the long form's stem, so that a rule that says
// "acknowledging" meets the test that says "acks". A fixed list: it does not depend on the repository.
const ABBR = { ack: 'acknowledg', auth: 'authent', authn: 'authent', authz: 'authoriz', config: 'configur', cfg: 'configur', conf: 'configur', init: 'initial', env: 'environ', doc: 'document', spec: 'specif', repo: 'repository', sync: 'synchron', temp: 'temporary', tmp: 'temporary', max: 'maximum', min: 'minimum', num: 'numb', param: 'paramet', arg: 'argument', dir: 'directory', msg: 'messag', db: 'databas', err: 'error', req: 'request', res: 'respons', resp: 'respons', del: 'delet', dup: 'duplicat', dedup: 'duplicat', dedupe: 'duplicat', info: 'inform', admin: 'administrat', app: 'applicat', util: 'utility', perf: 'perform', nav: 'navigat', btn: 'button', pwd: 'password', passwd: 'password', txn: 'transact', tx: 'transact', evt: 'event', ctx: 'context', idx: 'index', src: 'sourc', dest: 'destinat', dst: 'destinat', prev: 'previou', cur: 'current', curr: 'current', calc: 'calculat', gen: 'generat', exec: 'execut', eval: 'evaluat', impl: 'implement', ref: 'referenc', attr: 'attribut', prop: 'property', props: 'property', creds: 'credential', cred: 'credential', perm: 'permiss', perms: 'permiss', notif: 'notificat', sub: 'subscript', pub: 'publish', recv: 'receiv', rcv: 'receiv' };
// and the long forms in all their endings come down to the same stem: configuration, configured → "configur"
const LONG = [...new Set(Object.values(ABBR))].filter((p) => p.length >= 6).sort((a, b) => b.length - a.length);
function stem(w) {
  const s = stemOnly(w);
  if (ABBR[s] || ABBR[w]) return ABBR[s] || ABBR[w];
  return (s.length > 6 && LONG.find((p) => s.startsWith(p))) || s;
}
function stemOnly(w) {
  // One stem per word family, so that a rule and a test meet whichever form each uses: walk, walks, walked,
  // walking, walker, walkers → "walk"; drive, driver, driving → "driv"; retry, retried, retries → "retry".
  // Crude on purpose ("number" → "numb"): both sides go through the same function, so only families matter.
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && /(s|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('ied')) s = s.slice(0, -3) + 'y';
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('er')) s = s.slice(0, -2);
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 4 && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ss|ll|ff)$/.test(s)) s = s.slice(0, -1);   // stopp → stop
  return s;
}

// Ideas that rules and tests name with different words. A rule says "never the same message twice"; its test says
// "sends a message once per send ID". Neither stemming nor counting will bring "twice" and "once" together: they are
// the same idea said from two sides. Each word below also yields its idea as a token ("=once"), so a rule and a test
// that speak of the same idea share a word. A fixed list about what tests check, the same for every repository.
const IDEAS = {
  once: 'once twice duplicat repeat again idempotent exactly singl uniqu redeliver',
  lost: 'lost lose loss drop miss keep kept surviv persist durabl retain preserv',
  crash: 'crash die dy dead kill restart reboot recover fail outag interrupt',
  refuse: 'refus reject deny denied forbid forbidden disallow block prevent invalid unauthoriz',
  allow: 'allow accept permit grant valid',
  limit: 'limit cap maximum minimum exceed most least bound threshold quota',
  order: 'order sort sequenc first last befor after earlier later follow preced',
  wait: 'wait delay debounc paus timeout expir deadlin later schedul',
  remove: 'delet remov purg eras clear drop',
  create: 'creat add insert new made',
  show: 'show display render visibl appear print list',
  hide: 'hide hidden invisibl secret mask redact conceal',
  error: 'error fail throw exception reject',
  empty: 'empty none zero nothing blank absent',
  store: 'stor sav persist writ disk databas record log',
  send: 'send sent deliver post publish emit notify',
};
const IDEA_OF = new Map();
for (const [idea, words] of Object.entries(IDEAS)) for (const w of words.split(' ')) for (const form of [w, stem(w)]) if (!IDEA_OF.has(form)) IDEA_OF.set(form, `=${idea}`);

// a few of those words are stop words everywhere else ("first", "after", "most"): kept when they carry an idea
const IDEA_WORDS = new Set(['once', 'twice', 'again', 'first', 'last', 'before', 'after', 'most', 'least', 'none', 'nothing', 'new', 'later', 'earlier']);

/**
 * Words of a text for matching: camelCase and snake_case are split, numbers are kept (limits such as "20" matter),
 * CJK runs become bigrams. Returns stems in order of appearance, duplicates included.
 */
function tokenize(text) {
  const out = [];
  // "each other" is two stop words and one meaning (things acting on one another: colliding, overlapping, queueing).
  // Kept as one word, it is often the only thing a rule and its test have in common.
  const s = String(text).replace(/\b(each other|one another)\b/gi, ' mutualxx ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  for (const m of s.matchAll(/[A-Za-z]+|\d+(?:\.\d+)?|[一-鿿]+/g)) {
    const w = m[0];
    if (/[一-鿿]/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (/^\d/.test(w)) out.push(w);
    else {
      const l = w.toLowerCase();
      if (IDEA_WORDS.has(l)) { const s = stem(l); out.push(s); if (IDEA_OF.has(s)) out.push(IDEA_OF.get(s)); } else if (l.length > 1 && !STOP.has(l)) { const s = stem(l); out.push(s); if (IDEA_OF.has(s)) out.push(IDEA_OF.get(s)); }
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

const ideaOf = (stemmed) => IDEA_OF.get(stemmed) || null;

module.exports = { ideaOf, sha, globToRe, matcher, escapeRe, pool, tokenize, stem, uniq, isBinary, readText, writeAtomic, readJson, clip, cmp, by, plural, count, groupBy };
