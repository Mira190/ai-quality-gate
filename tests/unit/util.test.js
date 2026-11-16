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

test('words: identifiers are split, stop words go, numbers stay, ideas ride along, Chinese becomes bigrams', () => {
  // families, short forms and ideas are the lexicon's (tests/unit/lexicon.test.js); here, what the tokenizer itself does
  assert.deepEqual(tokenize('applyDiscount caps discounts at 20%').filter((t) => !t.startsWith('=')), ['apply', 'discount', 'cap', 'discount', '20']);
  assert.deepEqual(tokenize('the retry_count of HTTPServer v2'), ['retry', '=retry', 'count', 'http', 'serv', 'v', '2'].filter((t) => t !== 'v'));
  assert.deepEqual(tokenize('折扣上限'), ['折扣', '扣上', '上限']);
  // a stop word that names an idea is kept, with the idea; "each other" is one word; a verb and its particle are the compound
  assert.deepEqual(tokenize('the first of these'), ['first', '=order']);
  assert.deepEqual(tokenize('they pass through each other'), ['pass', 'through', 'mutual']);
  assert.deepEqual(tokenize('it times out'), ['timeout', '=wait']);
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
