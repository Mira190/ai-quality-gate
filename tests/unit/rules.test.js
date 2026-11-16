'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDoc, idPattern, docType } = require('../../src/extract/rules');
const { tagRule, limitsOf, exercisesLimit } = require('../../src/extract/risk');

const idp = idPattern({});
const parse = (text, type = 'requirement', p = 'docs/requirements.md') => parseDoc(p, text, type, idp, {});

test('GATE-1 an ID at the start of a list item, a heading or a table row defines a rule', () => {
  const rules = parse([
    '- **REQ-01 Discount cap.** Discounts never exceed 20%.',
    '### DEC-4 Retry with backoff',
    '',
    'The client retries three times.',
    '| AC-3 | The export is a CSV file |',
    'See REQ-01 for the cap.',
  ].join('\n'));
  assert.deepEqual(rules.map((r) => [r.id, r.kind, r.line]), [['REQ-1', 'requirement', 1], ['DEC-4', 'decision', 2], ['AC-3', 'requirement', 5]]);
  assert.equal(rules[0].title, 'Discount cap');
  assert.match(rules[1].text, /retries three times/);
});

test('GATE-1 REQ_007 and req-7 are the same rule', () => {
  assert.equal(parse('- REQ_007: one\n')[0].id, 'REQ-7');
  assert.equal(parse('- req-7: one\n')[0].id, 'REQ-7');
});

test('GATE-2 a decision record is one decision, and a superseded one is inactive', () => {
  const accepted = parse('# 3. Idempotent webhooks\n\n## Status\n\nAccepted\n\n## Decision\n\nThe endpoint stores the event id.\n', 'adr', 'docs/adr/0003-idempotent-webhooks.md');
  assert.equal(accepted.length, 1);
  assert.deepEqual([accepted[0].id, accepted[0].kind, accepted[0].active], ['ADR-3', 'decision', true]);
  assert.match(accepted[0].text, /stores the event id/);
  const old = parse('# 4. SOAP\n\n## Status\n\nSuperseded by ADR 3\n\n## Decision\n\nUse SOAP.\n', 'adr', 'docs/adr/0004-soap.md');
  assert.equal(old[0].active, false);
  const draft = parse('# 5. Cache\n\n## Status\n\nProposed\n\n## Decision\n\nUse a cache.\n', 'adr', 'docs/adr/0005-cache.md');
  assert.equal(draft[0].active, false);
});

// covers: DEC-2
test('GATE-3 normative sentences become inferred rules with a text-hash ID; instructions to developers do not', () => {
  const text = '# Cart\n\nThe cart must reject a quantity above 99.\n\nDevelopers must run the migrations first.\n\nThis paragraph describes the cart.\n';
  const a = parse(text, 'design', 'docs/design.md');
  assert.equal(a.length, 1);
  assert.equal(a[0].inferred, true);
  assert.match(a[0].id, /^D-[0-9A-F]{6}$/);
  // the same sentence gets the same ID wherever it moves
  const b = parse('# Cart\n\nIntro.\n\n\nThe cart must reject a quantity above 99.\n', 'design', 'docs/design.md');
  assert.equal(b[0].id, a[0].id);
  // a general document (a README) is never mined for sentences
  assert.equal(parse(text, 'general', 'README.md').length, 0);
});

test('GATE-3 a document that numbers its rules is not mined for sentences', () => {
  const rules = parse('- REQ-1: The total is rounded.\n\nThe service must log every call.\n');
  assert.deepEqual(rules.map((r) => r.id), ['REQ-1']);
});

test('GATE-4 a rule about money, access control, customer data, outside calls or data safety is critical, with the word', () => {
  const tag = (text) => tagRule({ id: 'REQ-1', title: '', text }, {});
  assert.deepEqual(tag('Discounts never exceed 20%.').tags, [{ area: 'money', word: 'discounts' }]);
  assert.equal(tag('Only an admin can delete a user.').tags.map((t) => t.area).join(), 'auth,data');   // two weak words make one strong signal
  // one ambiguous word alone does not: a wrongly critical rule is a wrong P0
  for (const text of ['The parser emits one token per word.', 'The role attribute is set on the button.', 'Failed jobs are retried.', 'The battery is charged overnight.']) assert.equal(tag(text).critical, false, text);
  assert.equal(tag('A token expires when the session ends.').critical, true);
  assert.equal(tag('A chargeback is escalated.').critical, true);
  assert.equal(tag('The webhook is retried on timeout.').tags[0].area, 'external');
  assert.equal(tag('A failed migration must not cause data loss.').tags[0].area, 'safety');
  assert.equal(tag('The list is sorted by name.').critical, false);
  assert.equal(tagRule({ id: 'REQ-9', title: '', text: 'The list is sorted.' }, { risk: { critical_ids: ['req-9'] } }).critical, true);
});

test('the nature of a rule names the lowest level that can prove it', () => {
  const lowest = (text) => tagRule({ id: 'R', title: '', text }, {}).lowest;
  assert.equal(lowest('Discounts never exceed 20%.'), 'unit');
  assert.equal(lowest('The button is hidden for guests.'), 'component');
  assert.equal(lowest('The order is stored in the database.'), 'integration');
  assert.equal(lowest('The whole checkout journey works end to end.'), 'e2e');
});

test('GATE-7 limits are read from the rule and looked for in the test body', () => {
  assert.deepEqual(limitsOf('Discounts never exceed 20% and at most 3 retries; see REQ-12 and version 2.').map((l) => [l.value, l.unit]), [['20', '%'], ['3', 'retries']]);
  assert.deepEqual(limitsOf('An excess from $500 to $5,000').map((l) => l.value), ['500', '5000']);
  const pct = { value: '20', unit: '%' };
  assert.equal(exercisesLimit('expect(cap(0.2)).toBe(true)', pct), true);
  assert.equal(exercisesLimit('expect(cap(20)).toBe(true)', pct), true);
  assert.equal(exercisesLimit('expect(cap(120)).toBe(true)', pct), false);
  assert.equal(exercisesLimit('expect(x).toBe(5_000)', { value: '5000', unit: '$' }), true);
});

test('documents are typed by their path', () => {
  assert.equal(docType('docs/adr/0001-x.md'), 'adr');
  assert.equal(docType('docs/requirements.md'), 'requirement');
  assert.equal(docType('specs/checkout.md'), 'requirement');
  assert.equal(docType('docs/architecture.md'), 'design');
  assert.equal(docType('README.md'), 'general');
});

test('GATE-2 a numbered rule is retired only by an explicit marker, not by a word in its text', () => {
  const rules = parse('- REQ-1: A decision that is superseded or rejected is not counted.\n- REQ-2 [deprecated]: The old export.\n- ~~REQ-3: Gone.~~\n- REQ-4: Legacy import. Status: withdrawn\n');
  assert.deepEqual(rules.map((r) => [r.id, r.active]), [['REQ-1', true], ['REQ-2', false], ['REQ-3', false], ['REQ-4', false]]);
});

test('a rule carries the headings above it, and a preposition with a bare number is not a limit', () => {
  const rules = parse('# Shop\n\n## Pricing\n\n### Discounts\n\n- REQ-1: The cap applies after tax.\n\n## Orders\n\n- REQ-2: Pages from 1 to 2 load over 40 items within 30 days, at most 5.\n');
  assert.deepEqual(rules.map((r) => r.section), ['Pricing › Discounts', 'Shop › Orders']);
  assert.deepEqual(limitsOf(rules[1].text).map((l) => l.raw), ['over 40 items', 'within 30 days', 'at most 5']);
});

test('GATE-3 a sentence is read whole across wrapped lines; half a sentence, or a description of the world, is not a rule', () => {
  const text = [
    '# Traffic', '',
    'Within a second that car must slow by at least 2 m/s,',
    'move 0.4 m aside and sound its horn. The number of lights',
    'never changes once the scene is up.', '',
    "GSI's aerial photographs cannot tell the two apart under the trees.", '',
    'The coping sits on the highest drawn ground behind it (so the ground never', 'shows through it.', '',
    '- The loader always stays up until the scene has been drawn twice,',
    '  so the hand-over shows no black frame.',
  ].join('\n');
  const rules = parse(text, 'design', 'docs/GAME.md');
  assert.deepEqual(rules.map((r) => [r.line, r.text]), [
    [3, 'Within a second that car must slow by at least 2 m/s, move 0.4 m aside and sound its horn.'],
    [3, 'The number of lights never changes once the scene is up.'],
    [12, 'The loader always stays up until the scene has been drawn twice, so the hand-over shows no black frame.'],
  ]);
  // prose under docs/ is read as design; a README is not mined
  assert.equal(docType('docs/GAME.md'), 'design');
  assert.equal(docType('docs/images/readme.md'), 'general');
  assert.equal(docType('README.md'), 'general');
});
