'use strict';
// Builds the fixture repository `acme/shop` in a directory: a small checkout service whose documents, tests and CI
// hold one example of everything the gate reports. Nothing here is executed; the gate only reads it.
//
//   rule     what the fixture sets up                                         expected
//   REQ-1    unit test names the ID and uses the limit                        proven (code)
//   REQ-2    only a browser test with a 5-row table, run nightly              hole (not on PR) + placement: too-high, table-at-top
//   REQ-3    boundary rule, unit test with jest.mock names the ID             placement: boundary-mocked
//   REQ-4    the only test is skipped                                         P0 skipped
//   REQ-5    no ID in tests; a test asserts it                                proven (model, verified)
//   REQ-6    no ID in tests; a test checks 8, the rule says 12                hole: partial (model, verified)
//   REQ-7    nothing                                                          P1 no test (code)
//   REQ-8    critical and vague                                               cannot be tested as written (advice)
//   ADR-3    integration test names the ID                                    proven, right level
//   ADR-4    superseded                                                       not counted
//   design   one inferred rule with a test, one inferred non-rule             proven (model) / dropped
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FILES = {
  'README.md': `# shop\n\nCheckout service. Requirements are in docs/requirements.md, decisions in docs/adr/.\n`,
  'docs/requirements.md': `# Checkout requirements

- **REQ-1 Discount cap.** Discounts never exceed 20% of the order total.
- **REQ-2 Free shipping.** Orders over $50 ship free; the shipping fee is $5 otherwise.
- **REQ-3 Payment retry.** When the payment gateway times out, the payment is retried at most 3 times.
- **REQ-4 Refund window.** A refund can be requested within 30 days of delivery.
- **REQ-5 Session expiry.** A session expires after 15 minutes of inactivity.
- **REQ-6 Password length.** Passwords must be at least 12 characters long.
- **REQ-7 Order export.** An order history can be exported as CSV.
- **REQ-8 Payment speed.** Payment processing should be fast.
`,
  'docs/adr/0003-idempotent-webhooks.md': `# 3. Idempotent webhooks

## Status

Accepted

## Context

The payment gateway delivers a webhook more than once.

## Decision

The webhook endpoint stores the event id and answers 200 without side effects when it sees the same event id again.
`,
  'docs/adr/0004-soap-gateway.md': `# 4. SOAP gateway client

## Status

Superseded by ADR 3

## Decision

We will use the SOAP gateway client.
`,
  'docs/design.md': `# Cart design

The cart must reject a quantity above 99 for one item.

Pricing code should be easy to read.

Developers must run the migrations before starting the service.
`,
  'src/discount.ts': `export function applyDiscount(total: number, percent: number): number {\n  const capped = Math.min(percent, 20);\n  return total - (total * capped) / 100;\n}\n`,
  'src/shipping.ts': `export function shippingFee(total: number): number {\n  return total > 50 ? 0 : 5;\n}\n`,
  'src/payment.ts': `import { gateway } from './gateway';\n\nexport async function pay(amount: number): Promise<boolean> {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    try { return await gateway.charge(amount); } catch (e) { if (attempt === 2) throw e; }\n  }\n  return false;\n}\n`,
  'src/gateway.ts': `export const gateway = { charge: async (amount: number): Promise<boolean> => amount > 0 };\n`,
  'src/refund.ts': `export const canRefund = (daysSinceDelivery: number): boolean => daysSinceDelivery <= 30;\n`,
  'src/session.ts': `export const isExpired = (idleMinutes: number): boolean => idleMinutes >= 15;\n`,
  'src/password.ts': `export const isValidPassword = (p: string): boolean => p.length >= 12;\n`,
  'src/cart.ts': `export function addItem(quantity: number): void {\n  if (quantity > 99) throw new Error('quantity');\n}\n`,
  'src/totals.ts': `export const total = (prices: number[]): number => prices.reduce((a, b) => a + b, 0);\n`,
  'src/webhook.ts': `export const app = { seen: new Set<string>() };\n`,
  'src/geo.ts': `export const lookup = async (ip: string): Promise<string> => (await fetch('http://localhost:3000/geo/' + ip)).text();\n`,
  'tests/unit/discount.test.ts': `import { applyDiscount } from '../../src/discount';

describe('discount', () => {
  it('REQ-1 caps the discount at 20%', () => {
    expect(applyDiscount(100, 20)).toBe(80);
    expect(applyDiscount(100, 21)).toBe(80);
  });
});
`,
  'tests/unit/payment.test.ts': `import { pay } from '../../src/payment';
import { gateway } from '../../src/gateway';

jest.mock('../../src/gateway');

describe('payment', () => {
  // covers: REQ-3
  it('retries a timed-out payment at most 3 times', async () => {
    (gateway.charge as jest.Mock).mockRejectedValue(new Error('timeout'));
    await expect(pay(10)).rejects.toThrow('timeout');
    expect(gateway.charge).toHaveBeenCalledTimes(3);
  });
});
`,
  'tests/unit/refund.test.ts': `import { canRefund } from '../../src/refund';

it.skip('REQ-4 allows a refund within 30 days', () => {
  expect(canRefund(30)).toBe(true);
  expect(canRefund(31)).toBe(false);
});
`,
  'tests/unit/session.test.ts': `import { isExpired } from '../../src/session';

describe('session', () => {
  it('expires after 15 minutes of inactivity', () => {
    expect(isExpired(14)).toBe(false);
    expect(isExpired(15)).toBe(true);
  });
});
`,
  'tests/unit/password.test.ts': `import { isValidPassword } from '../../src/password';

describe('password', () => {
  it('rejects a password shorter than the minimum length', () => {
    expect(isValidPassword('12345678')).toBe(false);
  });
});
`,
  'tests/unit/cart.test.ts': `import { addItem } from '../../src/cart';

describe('cart', () => {
  it('rejects a quantity above the limit for one item', () => {
    expect(() => addItem(100)).toThrow();
    expect(() => addItem(99)).not.toThrow();
  });
});
`,
  'tests/unit/geo.test.ts': `import { lookup } from '../../src/geo';

it('looks up the country of an address', async () => {
  const res = await fetch('http://localhost:3000/geo/8.8.8.8');
  expect(await res.text()).toBe(await lookup('8.8.8.8'));
});
`,
  'tests/integration/webhook.int.test.ts': `import request from 'supertest';
import { app } from '../../src/webhook';

describe('ADR-3 idempotent webhooks', () => {
  it('answers 200 and does nothing for an event id it has seen', async () => {
    await request(app).post('/webhook').send({ id: 'evt_1' }).expect(200);
    await request(app).post('/webhook').send({ id: 'evt_1' }).expect(200);
    expect(app.seen.size).toBe(1);
  });
});
`,
  'tests/e2e/shipping.spec.ts': `import { chromium } from 'playwright';

describe('REQ-2 free shipping', () => {
  it.each([
    [49.99, '$5.00'],
    [50, '$5.00'],
    [50.01, 'Free'],
    [120, 'Free'],
    [0.01, '$5.00'],
  ])('order of %s shows shipping %s', async (total, fee) => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://localhost:3000/checkout?total=' + total);
    expect(await page.textContent('#shipping')).toBe(fee);
  });
});
`,
  'tests/e2e/totals.e2e.test.ts': `import { total } from '../../src/totals';

it('adds the prices of the order', () => {
  expect(total([1, 2, 3])).toBe(6);
});
`,
  'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'jest tests/unit tests/integration', lint: 'eslint .', e2e: 'jest tests/e2e' }, devDependencies: { jest: '^29.0.0', eslint: '^9.0.0', typescript: '^5.0.0', playwright: '^1.40.0', prettier: '^3.0.0' } }, null, 2) + '\n',
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  'eslint.config.js': 'module.exports = [];\n',
  '.prettierrc': '{}\n',
  '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: { interval: weekly }\n',
  '.github/workflows/ci.yml': `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Lint
        run: npm run lint
        continue-on-error: true
      - name: Test
        run: npm test
`,
  '.github/workflows/nightly.yml': `name: Nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run e2e
`,
};

// A pull request on top of the base commit: a new critical rule and its implementation, with no test.
const CHANGE = {
  'docs/requirements.md': FILES['docs/requirements.md'] + '- **REQ-9 Gift card limit.** A gift card payment never exceeds $500 per order.\n',
  'src/payment/giftcard.ts': `export function redeem(balance: number, amount: number): number {\n  if (amount > 500) {\n    throw new Error('limit');\n  }\n  if (amount > balance) {\n    throw new Error('balance');\n  }\n  return balance - amount;\n}\n`,
};

function write(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
}
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** @returns {{dir, base}} the repository and the commit a pull request would be compared with. */
function build(dir, { change = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  write(dir, FILES);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  if (change) { write(dir, CHANGE); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'gift cards'); }
  return { dir, base };
}

module.exports = { build, FILES, CHANGE };

if (require.main === module) console.log(build(path.resolve(process.argv[2] || 'shop-fixture'), { change: process.argv.includes('--change') }));
