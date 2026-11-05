'use strict';
// The only door to the model. Every call is one Messages API request with a JSON schema (structured outputs), keyed by
// a stable logical key ("judge:requirement:0"), so a run can be recorded to a cassette and replayed exactly.
// Modes: live (call the API), record (live + save), replay (cassette only; a missing key is an error),
// offline (no model: every call returns null, so the report has only what code decides plus plain fallback cells).
const fs = require('node:fs');
const crypto = require('node:crypto');

// Bump when a prompt or a schema changes meaning: every memoised verdict made under the old wording is then re-asked.
const MEMO_VERSION = 'v1';

// USD per million tokens (https://platform.claude.com/docs/en/about-claude/pricing). Haiku 5.5 has a second card above 100K prompt tokens.
const PRICES = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, longFrom: 100000, longIn: 0.5, longOut: 2.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
// AIU: the report's unit of AI usage. 1 AIU = US$0.01 at API list price (AIU_PER_USD to change it).
const AIU_PER_USD = Number(process.env.AIU_PER_USD || 100);

function costUsd(model, u) {
  const p = PRICES[model] || { in: 5, out: 25 };
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const card = p.longFrom && prompt > p.longFrom ? { in: p.longIn, out: p.longOut } : p;
  return ((u.input_tokens || 0) * card.in + (u.cache_read_input_tokens || 0) * card.in * 0.1 + (u.cache_creation_input_tokens || 0) * card.in * 1.25 + (u.output_tokens || 0) * card.out) / 1e6;
}

class LLM {
  constructor({ model = 'claude-haiku-5-5', mode = 'live', cassette = null, maxUsd = 2, effort = 'low', votes = 3, memo = null, adaptive = true, batchApi = false, batchPollMs = 15000, batchTimeoutMs = 6 * 3600 * 1000 } = {}) {
    this.model = model; this.mode = mode; this.cassettePath = cassette; this.maxUsd = maxUsd; this.effort = effort;
    // votes: a number, or per stage ({ default: 3, built: 1 }): a stage whose findings never block can take fewer
    const v = typeof votes === 'object' && votes ? votes : { default: votes };
    this.nVotes = Math.max(1, Number(v.default ?? 3));
    this.stageVotes = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'default').map(([k, n]) => [k, Math.max(1, Number(n))]));
    // adaptive: ask two votes first and the third only when they disagree (a disagreement goes to the solo re-judge)
    this.adaptive = adaptive;
    // batchApi: queue every request into Message Batches (half price, minutes to hours): for default-branch baseline runs
    this.batchApi = batchApi && (mode === 'live' || mode === 'record');
    this.batchPollMs = batchPollMs; this.batchTimeoutMs = batchTimeoutMs;
    this.queue = []; this.flushTimer = null; this.batchSeq = 0;
    // Verdict memo: per-item replies keyed by a hash of everything the model saw about that item. Off in replay and fill
    // (the cassette is the memo there) and offline (nothing to remember).
    this.memoPath = memo && ['live', 'record'].includes(mode) ? memo : null;
    this.memo = { version: MEMO_VERSION, entries: {} };
    if (this.memoPath && fs.existsSync(this.memoPath)) { try { const m = JSON.parse(fs.readFileSync(this.memoPath, 'utf8')); if (m.version === MEMO_VERSION) this.memo = m; } catch { /* a corrupt memo is a cold start */ } }
    this.memoUsed = new Set();
    this.memoStats = { hits: 0, misses: 0 };
    this.tape = cassette && fs.existsSync(cassette) ? JSON.parse(fs.readFileSync(cassette, 'utf8')) : { model, calls: {} };
    if (mode === 'replay' && this.tape.model) this.model = this.tape.model;
    this.usage = { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
    this.log = [];
    if (mode === 'live' || mode === 'record') {
      const Anthropic = require('@anthropic-ai/sdk');
      this.client = new Anthropic({ maxRetries: 3, timeout: 180000 });
    }
  }

  /** One schema-constrained call. Returns the parsed object, or null on failure (the caller falls back to code). */
  // prefix: the part of the prompt every vote and every batch of a stage shares (instructions, the rule list). It goes
  // first, marked for prompt caching, so votes after the first read it at a tenth of the price; the varying part
  // (the items, in vote order) comes after it. A prefix under the model's minimum (512 tokens on Haiku 5.5) is simply
  // not cached.
  async ask(key, { system, prefix = null, prompt, schema, maxTokens = 8000 }) {
    if (this.mode === 'replay' || this.mode === 'fill') {
      const hit = this.tape.calls[key];
      if (hit) { this.add(hit.usage || {}); return hit.output; }
      if (this.mode === 'replay') throw new Error(`cassette has no entry for "${key}"`);
      // fill: a stand-in answers the calls by hand; the prompt is written out, and this run falls back to code
      (this.pending ||= {})[key] = { system, prompt: prefix ? `${prefix}\n\n${prompt}` : prompt, schema };
      this.log.push({ key, error: 'pending' });
      return null;
    }
    if (this.mode === 'offline') { this.log.push({ key, error: 'offline' }); return null; }
    if (this.usage.usd >= this.maxUsd) { this.log.push({ key, error: 'budget reached' }); return null; }
    let res;
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prefix ? [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }, { type: 'text', text: prompt }] : prompt }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema } },
    };
    try {
      res = this.batchApi ? await this.enqueue(params) : await this.client.messages.create(params);
      if (!res) { this.log.push({ key, error: 'batch request failed' }); return null; }
    } catch (e) {
      // a rejected key or a missing model is not a per-call failure: stop the run instead of writing a hollow report
      if ([401, 403, 404].includes(e.status)) throw new Error(`model API ${e.status}: ${String(e.message).slice(0, 200)}`);
      this.log.push({ key, error: `${e.status || ''} ${String(e.message).slice(0, 200)}` });
      return null;
    }
    this.add(res.usage || {}, this.batchApi ? 0.5 : 1);
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') { this.log.push({ key, error: `stop_reason ${res.stop_reason}` }); return null; }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let output;
    try { output = JSON.parse(text); } catch { this.log.push({ key, error: 'invalid JSON' }); return null; }
    if (this.mode === 'record') this.tape.calls[key] = { output, usage: pick(res.usage) };
    return output;
  }

  // ---- Message Batches: requests made in the same tick go out as one batch; each caller awaits its own result ----
  enqueue(params) {
    return new Promise((resolve, reject) => {
      this.queue.push({ params, resolve, reject });
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush().catch((e) => { for (const q of this.pendingFlush || []) q.reject(e); }), 50);
    });
  }

  async flush() {
    const q = this.queue; this.queue = []; this.flushTimer = null; this.pendingFlush = q;
    if (!q.length) return;
    // custom_id must match [a-zA-Z0-9_-]{1,64}; results come back in any order, so they are keyed, never positional
    const ids = q.map(() => `r${this.batchSeq++}`);
    const batch = await this.client.messages.batches.create({ requests: q.map((x, i) => ({ custom_id: ids[i], params: x.params })) });
    const t0 = Date.now();
    let b = batch;
    while (b.processing_status !== 'ended') {
      if (Date.now() - t0 > this.batchTimeoutMs) { await this.client.messages.batches.cancel(batch.id).catch(() => {}); throw new Error(`batch ${batch.id} timed out`); }
      await new Promise((r) => setTimeout(r, this.batchPollMs));
      b = await this.client.messages.batches.retrieve(batch.id);
    }
    const byId = new Map();
    for await (const r of await this.client.messages.batches.results(batch.id)) byId.set(r.custom_id, r.result);
    ids.forEach((id, i) => { const r = byId.get(id); q[i].resolve(r?.type === 'succeeded' ? r.message : null); });
  }

  /**
   * The same call asked n times (self-consistency): the caller keeps a judgment only when most replies agree, so a
   * finding one sample invents and the next drops never reaches the report. Vote k > 0 is keyed "<key>#v<k>"; in replay
   * and fill a missing vote is skipped (one recorded reply is a majority of one). Returns the non-null replies.
   */
  async votes(key, opts, n = this.nVotes, from = 0) {
    const keyOf = (i) => (i ? `${key}#v${i}` : key);
    const idx = Array.from({ length: n - from }, (_, k) => from + k);
    const replay = this.mode === 'replay' || this.mode === 'fill';
    // opts may be a function of the vote number: each vote then sees the same facts in a different order, so a verdict
    // that only the first-listed candidate wins (position bias) does not get a majority
    const one = (i) => (i && replay && !this.tape.calls[keyOf(i)] ? null : this.ask(keyOf(i), typeof opts === 'function' ? opts(i) : opts));
    // live: the first vote goes alone so it writes the prompt cache; the others then read the shared prefix from it
    if (!replay && !this.batchApi && idx.length > 1 && idx[0] === 0) {
      const first = await one(0);
      return [first, ...(await Promise.all(idx.slice(1).map(one)))].filter(Boolean);
    }
    return (await Promise.all(idx.map(one))).filter(Boolean);
  }

  /**
   * Votes over many items, batched, with a per-item verdict memo. Returns every reply object for every item (one per
   * vote; each carries the item's current id in `idField`).
   *
   * Why per item: a batched prompt makes one item's verdict depend on its neighbours, so an edit to one rule used to
   * re-roll the verdicts of the eleven rules batched with it. With the memo, an item whose own inputs (hashOf) did not
   * change gets back exactly the replies it got before; only changed items are asked again, batched among themselves.
   * Same input, same verdict, run after run: the model's sampling noise is paid once per distinct input.
   *
   *   stage   logical key prefix; batch i is keyed `${stage}:${i}` (cassette-compatible)
   *   size    items per batch (Infinity: one call)
   *   hashOf  item → string of everything the prompt shows about the item
   *   build   (batch, batchIndex, vote) → ask() options
   *   field   reply array field ("rules", "decisions"); idField reply id field ("id")
   *   keyOf   batch index → logical key
   *   signature  reply → string of its verdict; items whose votes give different signatures are asked again alone
   */
  async batchVotes(stage, items, { size = 12, hashOf, build, field = 'rules', idField = 'id', idOf = (x) => x.id, keyOf = (i) => `${stage}:${i}`, signature = null }) {
    const per = new Map(); // item → its replies
    let todo = items;
    const hashes = new Map();
    const n = this.stageVotes[stage.split(':')[0]] ?? this.nVotes;
    // adaptive: two votes first; items where they agree are done (2 of 2), the rest go to the solo re-judge with n votes
    const early = signature && this.adaptive && n >= 3 ? 2 : n;
    const hashFor = (it) => crypto.createHash('sha256').update([MEMO_VERSION, this.model, this.effort, n, stage, hashOf(it)].join('\u0000')).digest('hex').slice(0, 32);
    if (this.memoPath) {
      todo = [];
      for (const it of items) {
        const h = hashFor(it);
        hashes.set(it, h);
        const hit = this.memo.entries[h];
        if (hit && hit.replies?.length) { this.memoStats.hits++; this.memoUsed.add(h); per.set(it, hit.replies.map((r) => ({ ...r, [idField]: idOf(it) }))); } else { this.memoStats.misses++; todo.push(it); }
      }
    }
    const batches = [];
    for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
    const replies = await Promise.all(batches.map((b, i) => this.votes(keyOf(i), (k) => build(b, i, k), early)));
    const complete = new Set();
    batches.forEach((b, i) => {
      const flat = replies[i].flatMap((o) => o?.[field] || []);
      for (const it of b) {
        per.set(it, flat.filter((r) => r?.[idField] === idOf(it)));
        if (replies[i].length >= early) complete.add(it);
      }
    });
    this.voteStats = this.voteStats || { calls: 0, saved: 0 };
    this.voteStats.calls += batches.length * early;
    this.voteStats.saved += batches.length * (n - early);
    // Split votes mark an item on a knife edge, where batch neighbours and position move the verdict most. Ask it again
    // alone (no neighbours) and keep that answer: the solo votes decide. Live only: a replayed run has no solo replies.
    if (signature && (this.mode === 'live' || this.mode === 'record') && n > 1) {
      const split = todo.filter((it) => complete.has(it) && new Set(per.get(it).map(signature)).size > 1);
      this.splitStats = this.splitStats || { asked: 0, settled: 0 };
      await Promise.all(split.map(async (it) => {
        this.splitStats.asked++;
        const solo = (await this.votes(`${stage}:solo:${idOf(it)}`, (k) => build([it], 0, k), n)).flatMap((o) => o?.[field] || []).filter((r) => r?.[idField] === idOf(it));
        if (solo.length >= n) { per.set(it, solo); if (new Set(solo.map(signature)).size === 1) this.splitStats.settled++; } else complete.delete(it);
      }));
    }
    if (this.memoPath) for (const it of todo) {
      // a failed vote: do not pin a partial majority
      if (!complete.has(it) || !per.get(it)?.length) continue;
      const h = hashes.get(it);
      this.memo.entries[h] = { replies: per.get(it).map(({ [idField]: _, ...rest }) => rest), at: new Date().toISOString().slice(0, 10) };
      this.memoUsed.add(h);
    }
    return items.flatMap((it) => per.get(it) || []);
  }

  add(u, factor = 1) {
    this.usage.calls++;
    this.usage.input_tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    this.usage.cache_read_tokens = (this.usage.cache_read_tokens || 0) + (u.cache_read_input_tokens || 0);
    this.usage.output_tokens += u.output_tokens || 0;
    this.usage.usd += u.usd ?? costUsd(this.model, u) * factor;
  }

  get aiu() { return Math.round(this.usage.usd * AIU_PER_USD * 100) / 100; }

  save() {
    if (this.memoPath) {
      // keep only the verdicts this run used or made: the memo follows the repository instead of growing forever
      const entries = Object.fromEntries(Object.entries(this.memo.entries).filter(([h]) => this.memoUsed.has(h)));
      fs.mkdirSync(require('node:path').dirname(this.memoPath), { recursive: true });
      fs.writeFileSync(this.memoPath, JSON.stringify({ version: MEMO_VERSION, entries }) + '\n');
    }
    if (this.mode === 'fill' && this.cassettePath) fs.writeFileSync(this.cassettePath.replace(/\.json$/, '') + '.pending.json', JSON.stringify(this.pending || {}, null, 1));
    if (this.mode !== 'record' || !this.cassettePath) return;
    this.tape.model = this.model;
    fs.writeFileSync(this.cassettePath, JSON.stringify(this.tape, null, 2) + '\n');
  }
}
const pick = (u = {}) => ({ input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0 });

module.exports = { LLM, costUsd, AIU_PER_USD, MEMO_VERSION };
