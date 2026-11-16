'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTestFile, declaredLevel } = require('../../src/index/tests');
const { idPattern } = require('../../src/extract/rules');
const { classify } = require('../../src/scan/inventory');

const idp = idPattern({});
const parse = (text, lang = 'js', p = 'tests/x.test.js') => parseTestFile(p, text, lang, idp);

test('GATE-5 a rule ID in the title, a comment above the test or a tag links the test', () => {
  const js = parse([
    "describe('REQ-1 discount', () => {",
    "  it('caps at 20%', () => { expect(cap(20)).toBe(20); });",
    '  // covers: REQ_002',
    "  it('ships free', () => {",
    '    expect(fee(51)).toBe(0);',
    '  });',
    '});',
    "it('unrelated', () => { expect(1).toBe(1); });",
  ].join('\n'));
  assert.deepEqual(js.cases.map((c) => c.ids), [['REQ-1'], ['REQ-1', 'REQ-2'], []]);
  assert.equal(js.cases[1].name, 'REQ-1 discount › ships free');
  const feature = parse('Feature: Checkout\n\n  @REQ-7 @smoke\n  Scenario: export\n    When I export\n    Then I get a CSV\n', 'gherkin', 'features/x.feature');
  assert.deepEqual(feature.cases[0].ids, ['REQ-7']);
  const py = parse('def test_cap():\n    """REQ-3"""\n    assert cap(3) == 3\n', 'python', 'tests/test_x.py');
  assert.deepEqual(py.cases[0].ids, ['REQ-3']);
});

test('GATE-6 skipped tests are recognised in each language', () => {
  const js = parse("it.skip('a', () => {});\nxit('b', () => {});\ndescribe.skip('g', () => {\n  it('c', () => {});\n});\ntest.todo('d');\nit('e', () => { expect(1).toBe(1); });\n");
  assert.deepEqual(js.cases.map((c) => [c.name, c.skipped]), [['a', true], ['b', true], ['g › c', true], ['d', true], ['e', false]]);
  const py = parse('import pytest\n\n@pytest.mark.skip(reason="later")\ndef test_a():\n    assert True\n\ndef test_b():\n    assert True\n', 'python');
  assert.deepEqual(py.cases.map((c) => c.skipped), [true, false]);
  const java = parse('class T {\n  @Test\n  @Disabled\n  void a() { assertEquals(1, 1); }\n\n  @Test\n  void b() { assertEquals(1, 1); }\n}\n', 'java');
  assert.deepEqual(java.cases.map((c) => [c.name, c.skipped]), [['a', true], ['b', false]]);
  const go = parse('func TestA(t *testing.T) {\n\tt.Skip("later")\n}\n\nfunc TestB(t *testing.T) {\n\tif got != 1 {\n\t\tt.Fatalf("x")\n\t}\n}\n', 'go');
  assert.deepEqual(go.cases.map((c) => [c.name, c.skipped, c.asserts]), [['TestA', true, 0], ['TestB', false, 1]]);
});

test('assertions and parameter rows are counted per case', () => {
  const r = parse([
    'it.each([',
    '  [1, 2],',
    '  [2, 3],',
    '  [3, 4],',
    '  [4, 5],',
    "])('adds %s', (a, b) => {",
    '  expect(a + 1).toBe(b);',
    '});',
    "it('asserts nothing', () => {",
    '  run();',
    '});',
  ].join('\n'));
  assert.deepEqual(r.cases.map((c) => [c.name, c.params, c.asserts]), [['adds %s', 4, 1], ['asserts nothing', 0, 0]]);
  const py = parse('@pytest.mark.parametrize("a,b", [\n    (1, 2),\n    (2, 3),\n    (3, 4),\n])\ndef test_add(a, b):\n    assert a + 1 == b\n', 'python');
  assert.equal(py.cases[0].params, 3);
  assert.equal(py.cases[0].asserts, 1);
});

test('GATE-12 the level a file needs is read from what it does', () => {
  assert.equal(parse("import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.goto('/'); });\n").observed, 'e2e');
  assert.equal(parse("const request = require('supertest');\nit('x', async () => { await request(app).get('/'); });\n").observed, 'integration');
  assert.equal(parse("const { spawnSync } = require('node:child_process');\nit('x', () => { spawnSync('ls'); });\n").observed, 'integration');
  assert.equal(parse("import { render } from '@testing-library/react';\nit('x', () => { render(<A />); });\n").observed, 'component');
  const unit = parse("jest.mock('./db');\nit('x', () => { expect(f()).toBe(1); });\n");
  assert.equal(unit.observed, 'unit');
  assert.equal(unit.mock, 'jest.mock(');
});

test('the level a folder claims is read from the path', () => {
  assert.equal(declaredLevel('tests/unit/a.test.ts'), 'unit');
  assert.equal(declaredLevel('tests/integration/a.test.ts'), 'integration');
  assert.equal(declaredLevel('src/test/java/OrderIT.java'), 'integration');
  assert.equal(declaredLevel('e2e/login.spec.ts'), 'e2e');
  assert.equal(declaredLevel('cypress/checkout.cy.ts'), 'e2e');
  assert.equal(declaredLevel('src/a.test.ts'), null);
});

test('paths are sorted into kinds without reading a file', () => {
  const kind = (p) => classify(p).kind;
  assert.equal(kind('src/a.ts'), 'source');
  assert.equal(kind('src/a.test.ts'), 'test');
  assert.equal(kind('pkg/a_test.go'), 'test');
  assert.equal(kind('tests/test_a.py'), 'test');
  assert.equal(kind('tests/helpers/db.js'), 'support');
  assert.equal(kind('node_modules/x/index.js'), 'ignored');
  assert.equal(kind('dist/app.min.js'), 'ignored');
  assert.equal(kind('docs/requirements.md'), 'doc');
  assert.equal(kind('.github/workflows/ci.yml'), 'ci');
  assert.equal(kind('eslint.config.js'), 'config');
  assert.equal(kind('package.json'), 'manifest');
});
