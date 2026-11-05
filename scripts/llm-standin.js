#!/usr/bin/env node
'use strict';
// llm-standin: let a stand-in (a person, or another agent) answer the model calls of the seeded golden set, when no
// API key is available. The pipeline runs in fill mode: every call the cassette lacks is written out as a request, the
// stand-in answers it in the request's JSON schema, and the answers go into the cassettes. Calls depend on earlier
// answers (rules are judged, then traced, then their tests and code are checked), so it takes a few rounds:
//   node scripts/llm-standin.js collect --dir <work> [--case <id>]...   requests the cassettes cannot answer yet
//   (the stand-in writes <work>/answers/<id>.json for each <work>/requests/<id>.json)
//   node scripts/llm-standin.js merge --dir <work>                       answers → cassettes
//   ...repeat until collect finds nothing new, then score:
//   node scripts/eval-golden.js --track seeded --mode fill --votes <n> --cassettes bench/golden/seeded/cassettes-standin
// Identical requests from different cases are asked once (per vote). Report text
// (write:*, plan-tests) is not asked: it does not change which issues are found, and the scorer counts issues only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('../src/pipeline');
const { LLM } = require('../src/llm');
const { CASES, filesOf } = require('../bench/golden/seeded/cases');
const { build: buildFixture } = require('../tests/fixture/quote-service');

const argv = process.argv.slice(2), cmd = argv[0];
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const only = new Set(argv.flatMap((a, i) => (a === '--case' ? [argv[i + 1]] : [])));
const work = path.resolve(opt('dir') || 'out/standin');
// --votes 3: each call asked 3 times as separate requests (<hash>-v0, -v1, -v2), so 3 stand-ins can answer one vote
// each and the pipeline's majority rule works as with the API
const votes = Number(opt('votes', 1));
const tapes = path.resolve(opt('cassettes') || path.join(__dirname, '../bench/golden/seeded/cassettes-standin'));
const ASKED = /^(judge|trace|asserts|built|classify-docs|atomize)\b/;
// a later stage's prompt is built from the earlier stages' answers, so only the earliest unanswered stage is asked
const STAGE = (key) => { const k = key.replace(/#v\d+$/, ''); return /^(classify-docs|atomize)/.test(k) ? 0 : /^judge/.test(k) ? 1 : /^trace/.test(k) ? 2 : 3; };
const hash = (r) => crypto.createHash('sha1').update(JSON.stringify([r.system, r.prompt, r.schema])).digest('hex').slice(0, 12);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

async function collect() {
  fs.mkdirSync(path.join(work, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(work, 'answers'), { recursive: true });
  fs.mkdirSync(tapes, { recursive: true });
  const index = readJson(path.join(work, 'index.json'), {});
  let fresh = 0, stale = 0;
  // --fixture: the quote-service fixture instead, whose real model replies are recorded, to calibrate the stand-in
  const cases = argv.includes('--fixture') ? [{ id: 'quote-service', fixture: true }] : CASES.filter((x) => !only.size || only.has(x.id));
  for (const c of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `standin-${c.id}-`));
    if (c.fixture) buildFixture(dir);
    else for (const [p, text] of Object.entries(filesOf(c))) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
    const cassette = path.join(tapes, `${c.id}.json`);
    const llm = new LLM({ mode: 'fill', cassette, votes, fillVotes: votes > 1 });
    // an answer recorded for a different prompt (the code that builds the prompt changed) is stale: ask again
    const ask = llm.ask.bind(llm);
    llm.ask = (key, req) => {
      const hit = llm.tape.calls[key];
      if (hit?.hash && hit.hash !== hash(req)) { delete llm.tape.calls[key]; staleKeys.push(key); stale++; }
      return ask(key, req);
    };
    const staleKeys = [];
    try { await run({ root: dir, repo: c.fixture ? 'acme/quote-service' : `golden/${c.id}`, sha: c.fixture ? 'a1b2c3d' : 'seeded', date: c.fixture ? '2026-10-22' : '2026-11-04', llm }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // forget a stale answer for good: off the cassette, and off the old request's list of uses
    if (staleKeys.length) {
      const t = readJson(cassette, null);
      if (t) { for (const k of staleKeys) delete t.calls[k]; fs.writeFileSync(cassette, JSON.stringify(t, null, 1) + '\n'); }
      for (const e of Object.values(index)) e.uses = e.uses.filter((u) => !(u.case === c.id && staleKeys.includes(u.key)));
    }
    const pending = Object.entries(llm.pending || {}).filter(([k]) => ASKED.test(k));
    const first = Math.min(...pending.map(([k]) => STAGE(k)));
    for (const [key, req] of pending) {
      if (STAGE(key) !== first) continue;
      const h = `${hash(req)}${votes > 1 ? `-v${(/#v(\d+)$/.exec(key) || [0, 0])[1]}` : ''}`;
      const e = (index[h] ||= { uses: [] });
      if (!e.uses.some((u) => u.case === c.id && u.key === key)) e.uses.push({ case: c.id, key });
      const f = path.join(work, 'requests', `${h}.json`);
      if (!fs.existsSync(f) && !fs.existsSync(path.join(work, 'answers', `${h}.json`))) { fs.writeFileSync(f, JSON.stringify({ id: h, system: req.system, prompt: req.prompt, schema: req.schema }, null, 1)); fresh++; }
    }
  }
  fs.writeFileSync(path.join(work, 'index.json'), JSON.stringify(index, null, 1));
  const open = fs.readdirSync(path.join(work, 'requests')).filter((f) => !fs.existsSync(path.join(work, 'answers', f)));
  console.log(`${fresh} new requests (${stale} recorded answers were for an older prompt); ${open.length} waiting for an answer in ${path.join(work, 'requests')}`);
}

// Minimal JSON-schema check of an answer (types, required keys, enums), so a malformed answer is caught here.
function check(v, s, at = '$') {
  if (s.enum && !s.enum.includes(v)) return `${at}: ${JSON.stringify(v)} not in ${s.enum.join('|')}`;
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at}: not an object`;
    for (const k of s.required || []) if (!(k in v)) return `${at}.${k}: missing`;
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) { const e = check(v[k], sub, `${at}.${k}`); if (e) return e; }
    return null;
  }
  if (s.type === 'array') { if (!Array.isArray(v)) return `${at}: not an array`; for (let i = 0; i < v.length; i++) { const e = check(v[i], s.items || {}, `${at}[${i}]`); if (e) return e; } return null; }
  if (s.type === 'string' && typeof v !== 'string') return `${at}: not a string`;
  if (s.type === 'integer' && !Number.isInteger(v)) return `${at}: not an integer`;
  if (s.type === 'number' && typeof v !== 'number') return `${at}: not a number`;
  if (s.type === 'boolean' && typeof v !== 'boolean') return `${at}: not a boolean`;
  return null;
}

function merge() {
  const index = readJson(path.join(work, 'index.json'), {});
  let n = 0, bad = 0;
  const tapesBy = new Map();
  const tape = (id) => tapesBy.get(id) || tapesBy.set(id, readJson(path.join(tapes, `${id}.json`), { model: `stand-in (${opt('model', 'agent')})`, calls: {} })).get(id);
  for (const [h, e] of Object.entries(index)) {
    const a = path.join(work, 'answers', `${h}.json`);
    if (!fs.existsSync(a)) continue;
    const req = readJson(path.join(work, 'requests', `${h}.json`), null);
    const out = readJson(a, undefined);
    const err = out === undefined ? 'not JSON' : req ? check(out, req.schema) : null;
    if (err) { bad++; console.error(`${h}: ${err}`); continue; }
    const ph = h.replace(/-v\d+$/, '');
    for (const u of e.uses) {
      const t = tape(u.case), cur = t.calls[u.key];
      if (!cur) { t.calls[u.key] = { output: out, usage: {}, hash: ph }; n++; } else if (!cur.hash) cur.hash = ph; // backfill: which prompt it answers
    }
  }
  for (const [id, t] of tapesBy) fs.writeFileSync(path.join(tapes, `${id}.json`), JSON.stringify(t, null, 1) + '\n');
  console.log(`merged ${n} calls into ${tapesBy.size} cassettes${bad ? `; ${bad} answers rejected (fix and merge again)` : ''}`);
}

(cmd === 'collect' ? collect() : cmd === 'merge' ? Promise.resolve(merge()) : Promise.reject(new Error('usage: llm-standin collect|merge --dir <work>'))).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
