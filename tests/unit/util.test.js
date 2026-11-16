'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { globToRe, matcher, tokenize, pool, clip } = require('../../src/util');

test('globs: ** crosses directories, * does not, a bare name matches at any depth', () => {
  assert.equal(globToRe('src/**/*.ts').test('src/a/b/c.ts'), true);
  assert.equal(globToRe('src/**/*.ts').test('src/c.ts'), true);
  assert.equal(globToRe('src/*.ts').test('src/a/c.ts'), false);
  assert.equal(globToRe('*.{js,ts}').test('a.ts'), true);
  const m = matcher(['legacy/**', '*.snap']);
  assert.deepEqual(['legacy/a/b.js', 'x/y/z.snap', 'src/a.js'].map(m), [true, true, false]);
});

test('words: identifiers are split, plurals and tenses meet, numbers stay, Chinese becomes bigrams', () => {
  assert.deepEqual(tokenize('applyDiscount caps discounts at 20%'), ['apply', 'discount', 'cap', '=limit', 'discount', '20']);
  // the same idea said from two sides shares a token: "never twice" and "once", "nothing is lost" and "keeps"
  const idea = (text) => tokenize(text).filter((t) => t.startsWith('='));
  assert.deepEqual([idea('Never the same message twice.'), idea('sends a message once per send ID')], [['=once'], ['=send', '=once', '=send']]);
  assert.ok(idea('Nothing acknowledged is lost').includes('=lost') && idea('keeps an event when the gateway is killed').includes('=lost'));
  assert.ok(idea('however often the process dies').includes('=crash') && idea('after a restart').includes('=crash'));
  assert.deepEqual(tokenize('retried retries retry_count'), ['retry', 'retry', 'retry', 'count']);
  // short forms meet what prose spells out
  for (const [short, long] of [['acks', 'acknowledging'], ['config', 'configuration'], ['init', 'initialise'], ['auth', 'authentication'], ['msgs', 'messages'], ['dedupe', 'duplicates']]) assert.deepEqual(tokenize(short), tokenize(long), short);
  // one stem per word family, whichever form the rule or the test uses
  for (const family of [['walk', 'walks', 'walked', 'walking', 'walker', 'walkers'], ['drive', 'driver', 'driving', 'drives'], ['stop', 'stopped', 'stopping'], ['cache', 'caches', 'cached', 'caching']]) assert.equal(new Set(family.flatMap((w) => tokenize(w))).size, 1, family.join());
  assert.deepEqual(tokenize('折扣上限'), ['折扣', '扣上', '上限']);
});

test('pool keeps the input order and bounds concurrency', async () => {
  let live = 0, peak = 0;
  const out = await pool([30, 10, 20, 5], 2, async (ms) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, ms)); live--; return ms * 2; });
  assert.deepEqual(out, [60, 20, 40, 10]);
  assert.equal(peak, 2);
});

test('clip shortens on one line', () => {
  assert.equal(clip('a  b\nc', 10), 'a b c');
  assert.equal(clip('abcdefghij', 5), 'abcd…');
});
