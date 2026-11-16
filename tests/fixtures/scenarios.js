'use strict';
// Metamorphic scenarios: one defect planted in (or one fix applied to) the fixture repository, and the exact change
// in findings it must cause. This is the gate's own regression harness for the quality of what it reports:
//   recall     a planted defect that produces no finding is a miss;
//   precision  any finding the scenario did not ask for is noise.
// Every scenario is decided by code alone, so the scorecard is the same on every machine and costs no model call.
const fs = require('node:fs');
const path = require('node:path');

const edit = (dir, file, fn) => { const p = path.join(dir, file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
const swap = (file, from, to) => (dir) => edit(dir, file, (s) => { if (!s.includes(from)) throw new Error(`scenario out of date: ${file} has no "${from}"`); return s.replace(from, to); });
const DISCOUNT = 'tests/unit/discount.test.ts', CI = '.github/workflows/ci.yml', REQS = 'docs/requirements.md';

module.exports = [
  // ---- proof
  { name: 'a proving test is skipped', apply: swap(DISCOUNT, "it('REQ-1", "it.skip('REQ-1"), added: ['proof.skipped:REQ-1:P0'] },
  { name: 'a proving test loses its assertions', apply: (d) => edit(d, DISCOUNT, (s) => s.replace(/expect\((.*?)\)\.toBe\(80\);/g, '$1;')), added: ['proof.no-assert:REQ-1:P1'] },
  { name: 'the rule changes its limit and the test does not follow', apply: swap(REQS, 'never exceed 20%', 'never exceed 25%'), added: ['proof.limit:REQ-1:P1'] },
  { name: 'the rule ID is dropped from the test', apply: swap(DISCOUNT, "it('REQ-1 caps", "it('caps"), added: ['proof.unverified:REQ-1:P1'] },
  // another test still shares two of the rule's words ("order", "total"): without a model that is "unverified", not "no test"
  { name: 'the proving test is deleted', apply: (d) => fs.rmSync(path.join(d, DISCOUNT)), added: ['proof.unverified:REQ-1:P1'] },
  { name: 'a critical rule is added without a test', apply: (d) => edit(d, REQS, (s) => `${s}- **REQ-11 Chargeback.** A chargeback above $250 is escalated to a reviewer.\n`), added: ['proof.unproven:REQ-11:P0'] },
  { name: 'a non-critical rule is added without a test', apply: (d) => edit(d, REQS, (s) => `${s}- **REQ-12 Sorting.** The catalogue is sorted alphabetically.\n`), added: ['proof.unproven:REQ-12:P1'] },
  { name: 'a skipped test is enabled again', apply: swap('tests/unit/refund.test.ts', 'it.skip(', 'it('), removed: ['proof.skipped:REQ-4:P0'] },
  { name: 'a superseded decision gains nothing', apply: (d) => edit(d, 'docs/adr/0004-soap-gateway.md', (s) => `${s}\nThe client retries payments forever.\n`) },

  // ---- placement
  { name: 'a unit test is moved into the e2e folder', apply: (d) => fs.renameSync(path.join(d, DISCOUNT), path.join(d, 'tests/e2e/discount.test.ts')), added: ['placement.no-boundary:tests/e2e/discount.test.ts:P2', 'placement.too-high:REQ-1:P1'] },
  { name: 'a unit test starts calling an HTTP server', apply: (d) => edit(d, 'tests/unit/cart.test.ts', (s) => `import request from 'supertest';\n${s}`), added: ['placement.mislabelled:tests/unit/cart.test.ts:P2'] },
  { name: 'a logic rule gets its unit test', apply: (d) => fs.writeFileSync(path.join(d, 'tests/unit/shipping.test.ts'), "import { shippingFee } from '../../src/shipping';\n\nit('REQ-2 ships free over $50, charges $5 otherwise', () => {\n  expect(shippingFee(50)).toBe(5);\n  expect(shippingFee(50.01)).toBe(0);\n});\n"), removed: ['placement.too-high:REQ-2:P1'], changed: ['ci.level-not-run:e2e:P1→P2'] },
  { name: 'a boundary rule gets an integration test', apply: (d) => fs.writeFileSync(path.join(d, 'tests/integration/payment.int.test.ts'), "import request from 'supertest';\nimport { app } from '../../src/webhook';\n\nit('REQ-3 retries a timed-out payment at most 3 times', async () => {\n  const res = await request(app).post('/pay').send({ amount: 10 });\n  expect(res.body.attempts).toBe(3);\n});\n"), removed: ['placement.boundary-mocked:REQ-3:P1'] },
  { name: 'a parameter table grows in a browser test', apply: (d) => edit(d, 'tests/e2e/totals.e2e.test.ts', (s) => `${s}\nit.each([\n  [1, 1],\n  [2, 2],\n  [3, 3],\n  [4, 4],\n])('adds %s', (a, b) => {\n  expect(total([a])).toBe(b);\n});\n`), added: ['placement.table-at-top:tests/e2e/totals.e2e.test.ts:P2'] },

  // ---- CI
  { name: 'the test step may fail without failing the build', apply: swap(CI, '        run: npm test\n', '        run: npm test\n        continue-on-error: true\n'), added: ['ci.tests:tests:P0'] },
  { name: 'the test command swallows its exit code', apply: swap(CI, 'run: npm test', 'run: npm test || true'), added: ['ci.tests:tests:P0'] },
  { name: 'the workflow stops running on pull requests', apply: swap(CI, '  pull_request:\n', ''), added: ['ci.tests:tests:P0'] },
  { name: 'the test step is deleted', apply: swap(CI, '      - name: Test\n        run: npm test\n', ''), added: ['ci.tests:tests:P0'] },
  // one integration-level file lives under tests/unit and still runs, so the level as a whole is not dark: the rule is named
  { name: 'the test script stops running the integration tests', apply: swap('package.json', 'jest tests/unit tests/integration', 'jest tests/unit'), added: ['proof.not-in-pr:ADR-3:P1'] },
  { name: 'lint is made blocking', apply: swap(CI, '        continue-on-error: true\n', ''), removed: ['ci.lint:lint:P1'] },
  { name: 'a type check step is added', apply: swap(CI, '      - name: Test\n', '      - run: npx tsc --noEmit\n      - name: Test\n'), removed: ['ci.typecheck:typecheck:P1'] },
  { name: 'a type check is added behind a script', apply: (d) => { swap(CI, '      - name: Test\n', '      - run: npm run check\n      - name: Test\n')(d); swap('package.json', '"lint": "eslint ."', '"lint": "eslint .", "check": "tsc --noEmit && prettier --check ."')(d); }, removed: ['ci.typecheck:typecheck:P1', 'ci.format:format:P2'] },
  { name: 'coverage is measured without a minimum', apply: swap('package.json', 'jest tests/unit tests/integration', 'jest --coverage tests/unit tests/integration'), removed: ['ci.coverage:coverage:P2'], added: ['ci.coverage.no-threshold:coverage:P3'] },
  { name: 'the CI configuration is deleted', apply: (d) => fs.rmSync(path.join(d, '.github/workflows'), { recursive: true }), added: ['ci.none:ci:P0'], removed: ['ci.lint:lint:P1', 'ci.typecheck:typecheck:P1', 'ci.format:format:P2', 'ci.coverage:coverage:P2', 'ci.secrets:secrets:P2', 'ci.sast:sast:P3', 'ci.level-not-run:e2e:P1'] },

  // ---- nothing that matters changed: nothing may be reported
  { name: 'a README is edited', apply: (d) => edit(d, 'README.md', (s) => `${s}\nThe service must be started with npm start.\n`) },
  { name: 'source code is edited', apply: (d) => edit(d, 'src/totals.ts', (s) => `${s}\nexport const zero = 0;\n`) },
  { name: 'a test is reformatted', apply: (d) => edit(d, DISCOUNT, (s) => s.replace(/\n {4}/g, '\n\n      ')) },
];
