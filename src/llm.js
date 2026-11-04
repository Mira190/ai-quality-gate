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
  constructor({ model = 'claude-haiku-5-5', mode = 'live', cassette = null, maxUsd = 2, effort = 'low', votes = 3, memo = null } = {}) {
    this.model = model; this.mode = mode; this.cassettePath = cassette; this.maxUsd = maxUsd; this.effort = effort; this.nVotes = Math.max(1, votes);
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
  async ask(key, { system, prompt, schema, maxTokens = 8000 }) {
    if (this.mode === 'replay' || this.mode === 'fill') {
      const hit = this.tape.calls[key];
      if (hit) { this.add(hit.usage || {}); return hit.output; }
      if (this.mode === 'replay') throw new Error(`cassette has no entry for "${key}"`);
      // fill: a stand-in answers the calls by hand; the prompt is written out, and this run falls back to code
      (this.pending ||= {})[key] = { system, prompt, schema };
      this.log.push({ key, error: 'pending' });
      return null;
    }
    if (this.mode === 'offline') { this.log.push({ key, error: 'offline' }); return null; }
    if (this.usage.usd >= this.maxUsd) { this.log.push({ key, error: 'budget reached' }); return null; }
    let res;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: this.effort, format: { type: 'json_schema', schema } },
      });
    } catch (e) {
      // a rejected key or a missing model is not a per-call failure: stop the run instead of writing a hollow report
      if ([401, 403, 404].includes(e.status)) throw new Error(`model API ${e.status}: ${String(e.message).slice(0, 200)}`);
      this.log.push({ key, error: `${e.status || ''} ${String(e.message).slice(0, 200)}` });
      return null;
    }
    this.add(res.usage || {});
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') { this.log.push({ key, error: `stop_reason ${res.stop_reason}` }); return null; }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let output;
    try { output = JSON.parse(text); } catch { this.log.push({ key, error: 'invalid JSON' }); return null; }
    if (this.mode === 'record') this.tape.calls[key] = { output, usage: pick(res.usage) };
    return output;
  }

  /**
   * The same call asked n times (self-consistency): the caller keeps a judgment only when most replies agree, so a
   * finding one sample invents and the next drops never reaches the report. Vote k > 0 is keyed "<key>#v<k>"; in replay
   * and fill a missing vote is skipped (one recorded reply is a majority of one). Returns the non-null replies.
   */
  async votes(key, opts) {
    const keys = [key, ...Array.from({ length: this.nVotes - 1 }, (_, k) => `${key}#v${k + 1}`)];
    const replay = this.mode === 'replay' || this.mode === 'fill';
    // opts may be a function of the vote number: each vote then sees the same facts in a different order, so a verdict
    // that only the first-listed candidate wins (position bias) does not get a majority
    const out = await Promise.all(keys.map((k, i) => (i && replay && !this.tape.calls[k] ? null : this.ask(k, typeof opts === 'function' ? opts(i) : opts))));
    return out.filter(Boolean);
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
   */
  async batchVotes(stage, items, { size = 12, hashOf, build, field = 'rules', idField = 'id', idOf = (x) => x.id, keyOf = (i) => `${stage}:${i}` }) {
    const out = [];
    let todo = items;
    const hashes = new Map();
    if (this.memoPath) {
      todo = [];
      for (const it of items) {
        const h = crypto.createHash('sha256').update([MEMO_VERSION, this.model, this.effort, this.nVotes, stage, hashOf(it)].join('\u0000')).digest('hex').slice(0, 32);
        hashes.set(it, h);
        const hit = this.memo.entries[h];
        if (hit && hit.replies?.length) { this.memoStats.hits++; this.memoUsed.add(h); out.push(...hit.replies.map((r) => ({ ...r, [idField]: idOf(it) }))); } else { this.memoStats.misses++; todo.push(it); }
      }
    }
    const batches = [];
    for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
    const replies = await Promise.all(batches.map((b, i) => this.votes(keyOf(i), (k) => build(b, i, k))));
    batches.forEach((b, i) => {
      const flat = replies[i].flatMap((o) => o?.[field] || []);
      out.push(...flat);
      if (!this.memoPath || replies[i].length < this.nVotes) return; // a vote failed: do not pin a partial majority
      for (const it of b) {
        const mine = flat.filter((r) => r?.[idField] === idOf(it));
        if (!mine.length) continue;
        const h = hashes.get(it);
        this.memo.entries[h] = { replies: mine.map(({ [idField]: _, ...rest }) => rest), at: new Date().toISOString().slice(0, 10) };
        this.memoUsed.add(h);
      }
    });
    return out;
  }

  add(u) {
    this.usage.calls++;
    this.usage.input_tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    this.usage.output_tokens += u.output_tokens || 0;
    this.usage.usd += u.usd ?? costUsd(this.model, u);
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
