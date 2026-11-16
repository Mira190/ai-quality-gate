'use strict';
// The lexicon is general or it is wrong. These tests hold it to that: its own structure, word families from ordinary
// English, and a set of rule/test pairs from unrelated domains that it has to bring together without help.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SHORT_FORMS, IDEAS, IRREGULAR, stem, ideaOf } = require('../../src/lexicon');
const { tokenize } = require('../../src/util');
const { linkRules } = require('../../src/trace/link');
const { pairs, orphans } = require('../fixtures/paraphrases');

test('GATE-32 one stem per word family, across inflection and the common derivations', () => {
  const families = [
    ['walk', 'walks', 'walked', 'walking', 'walker', 'walkers'], ['stop', 'stopped', 'stopping'], ['retry', 'retried', 'retries', 'retrying'],
    ['configure', 'configured', 'configuration', 'configurable'], ['valid', 'validate', 'validation', 'validator', 'validity'],
    ['authorize', 'authorised', 'authorization'], ['duplicate', 'duplicated', 'duplication'], ['notify', 'notified', 'notification'],
    ['delete', 'deleted', 'deletion'], ['persist', 'persistence', 'persistent'], ['expire', 'expired', 'expiration', 'expiry'],
    ['remove', 'removal'], ['generate', 'generation', 'generator'], ['create', 'created', 'creation'], ['connect', 'connection'],
    ['differ', 'different', 'difference'], ['secure', 'security'], ['success', 'successful', 'successfully'], ['available', 'availability'],
    ['visible', 'visibility'], ['organize', 'organise', 'organisation'], ['accept', 'acceptance'], ['calculate', 'calculation', 'calculator'],
    ['send', 'sends', 'sent', 'sending'], ['keep', 'kept', 'keeps'], ['pay', 'paid', 'payment', 'payments'], ['write', 'wrote', 'written'],
  ];
  for (const f of families) assert.equal(new Set(f.map(stem)).size, 1, `${f.join(', ')} → ${[...new Set(f.map(stem))].join(' | ')}`);
  // and words that only look alike stay apart
  for (const [a, b] of [['format', 'form'], ['signal', 'sign'], ['important', 'import'], ['state', 'stat'], ['terminal', 'terminate'], ['policy', 'police'], ['user', 'use']]) assert.notEqual(stem(a), stem(b), `${a} / ${b}`);
});

test('GATE-32 a short form and the word it stands for are one token; a short form is matched as written only', () => {
  for (const [short, long] of Object.entries(SHORT_FORMS)) assert.equal(stem(short), stem(long), `${short} / ${long}`);
  assert.equal(stem('msgs'), stem('messages'));
  assert.equal(stem('ids'), stem('identifiers'));
  // every long form is a real word of at least five letters: a short form is never mapped to another short form
  for (const long of Object.values(SHORT_FORMS)) assert.ok((long.length >= 4 && !SHORT_FORMS[long]) || long === 'expire', long);
  // the irregular forms lead to words, not to more irregular forms
  for (const [form, base] of Object.entries(IRREGULAR)) assert.ok(!IRREGULAR[base] || base === form, `${form} → ${base}`);
});

test('GATE-32 an idea has many words and a word has one idea', () => {
  const seen = new Map();
  for (const [idea, words] of Object.entries(IDEAS)) {
    const list = words.split(' ');
    assert.ok(list.length >= 5, `${idea} names too few words to be an idea`);
    for (const w of list) {
      assert.ok(!seen.has(stem(w)) || seen.get(stem(w)) === idea, `"${w}" is in ${idea} and in ${seen.get(stem(w))}`);
      seen.set(stem(w), idea);
      assert.equal(ideaOf(stem(w)), `=${idea}`, w);
    }
  }
  // the two sides of one thing share an idea
  const ideas = (text) => new Set(tokenize(text).filter((t) => t.startsWith('=')));
  const share = (a, b) => [...ideas(a)].some((i) => ideas(b).has(i));
  for (const [a, b] of [['never twice', 'exactly once'], ['nothing is lost', 'keeps every job'], ['is rejected', 'not allowed and refused'], ['at most three', 'exceeds the limit'], ['after a crash', 'when the worker restarts'], ['in order', 'sorted, oldest first'], ['is hidden', 'masks the secret'], ['times out', 'expires after a delay']]) assert.ok(share(a, b), `${a} / ${b}`);
  // and everyday words that mean nothing in particular carry none
  for (const w of ['user', 'page', 'value', 'name', 'item', 'file', 'system', 'thing', 'result', 'when', 'with']) assert.equal(ideaOf(stem(w)), null, w);
});

test('GATE-32 held-out pairs: a rule finds its test among differently worded tests from other domains, and an unrelated rule finds none', () => {
  const mk = (name, i) => ({ key: `t${i} › ${name}`, name, ids: [], line: 1, end: 8, nt: [...new Set(tokenize(name))], bt: [], file: { path: `t${i}.test.js`, pkg: '', imports: [] } });
  const cases = pairs.map(([, name], i) => mk(name, i));
  const rules = [...pairs.map(([text], i) => ({ id: `P-${i}`, title: '', text, critical: true, limits: [], pkg: '' })), ...orphans.map((text, i) => ({ id: `O-${i}`, title: '', text, critical: true, limits: [], pkg: '' }))];
  const links = linkRules(rules, { cases, files: [] }, { trace: { candidates: 4, min_overlap: 0.34, excerpt_lines: 30 } });
  let first = 0, shown = 0, reached = 0;
  const missed = [];
  pairs.forEach(([text, name], i) => {
    const l = links.get(`P-${i}`);
    const cands = l.candidates.map((c) => c.case.name), wide = l.wider.map((c) => c.case.name);
    if (cands[0] === name) first++;
    if (cands.includes(name)) shown++;
    if (cands.includes(name) || wide.slice(0, 5).includes(name)) reached++; else missed.push(text);
  });
  const stray = orphans.filter((_, i) => links.get(`O-${i}`).candidates.some((c) => !c.weak)).length;
  console.log(`paraphrases: ${pairs.length} pairs · right test first ${first} · shown to the first reading ${shown} · reached by the second reading ${reached} · orphans given a candidate ${stray} of ${orphans.length}`);
  if (missed.length) console.log(`not reached: ${missed.join(' | ')}`);
  // thresholds a little under what the lexicon reaches today: a change may raise them, never lower them
  assert.ok(reached >= pairs.length * 0.8, `reached ${reached} of ${pairs.length}`);
  assert.ok(first >= pairs.length * 0.5, `first ${first} of ${pairs.length}`);
  assert.ok(stray <= 1, `orphans with a candidate: ${stray}`);
});
