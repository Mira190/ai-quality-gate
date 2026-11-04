'use strict';
// The clean base repository of the seeded golden set: `acme/refund-service`, a small Node service whose every rule
// is stated, implemented, tested at the right level with its limits, and run in PR CI, and whose PR workflow has all
// 7 checks. A correct reviewer reports nothing on it (section 1-5 issues = none). Each case in cases.js changes one
// thing and says which issue that change must produce.
//
// Rules (critical area in brackets):
//   REQ-01 refund window, 30 days        [money · refund]       limits 30 days      tests/unit/refund.test.js (tagged)
//   REQ-02 refund fee, $15               [money · refund]       limits $15          tests/unit/refund.test.js (by name)
//   REQ-03 order history page, 50        [not critical]         limit 50            tests/unit/orders.test.js
//   REQ-04 only admins change the fee    [access · admin]                           tests/component/admin.test.js
//   DEC-01 gateway timeout, 5 s          [outside calls]        adds behaviour      tests/component/gateway.test.js (fake server)
//   DEC-02 refunds are idempotent        [money · refund]       adds behaviour      tests/unit/refund-service.test.js
//   DEC-03 order list newest first       [not critical]         adds behaviour      tests/unit/orders.test.js

const BASE = {};
const put = (p, text) => { BASE[p] = text.replace(/^\n/, ''); };

put('README.md', `
# refund-service

Refunds for online orders: a customer asks for a refund, the service checks the window, takes the fee off and posts
the refund to the payment gateway. Staff can change the fee.

    npm ci
    npm test

The requirements and the design are in docs/.
`);

put('docs/requirements.md', `
# Refund service requirements

Each requirement has an ID. Tests name the ID where they can.

- **REQ-01 Refund window.** The system shall accept a refund request made within 30 days of purchase and reject a request made after day 30.

- **REQ-02 Refund fee.** The refund amount shall be the price paid minus a $15 fee; when the price paid is $15 or less, the refund amount shall be $0.

- **REQ-03 Order history page size.** The order history API shall return at most 50 orders per page.

- **REQ-04 Fee changes by admins only.** Only a user with the admin role shall change the refund fee; the system shall answer HTTP 403 to any other user.
`);

put('docs/design.md', `
# Refund service design

How the refund service is built. Each decision has an ID.

## Payments

### DEC-01 Gateway timeout
Calls to the payment gateway in \`src/gateway.js\` time out after 5 seconds. On a timeout or a gateway error the refund is stored as \`PENDING\` and retried by the nightly job.
Serves: REQ-01

### DEC-02 Refunds are idempotent
\`RefundService.refund\` stores each result by order ID and returns the stored result when the same order is refunded again, so a refund sent twice is paid once.
Serves: REQ-02

## Orders

### DEC-03 Newest orders first
The order history lists orders newest first, by purchase date.
Serves: REQ-03
`);

put('package.json', JSON.stringify({
  name: 'refund-service', version: '1.0.0', private: true, type: 'module',
  scripts: {
    test: 'vitest run --coverage',
    'test:e2e': 'playwright test',
    lint: 'eslint .',
    'format:check': 'prettier --check .',
    typecheck: 'tsc --noEmit -p jsconfig.json',
  },
  devDependencies: { vitest: '^3.2.0', '@vitest/coverage-v8': '^3.2.0', eslint: '^9.0.0', prettier: '^3.3.0', typescript: '^5.6.0', supertest: '^7.0.0', '@playwright/test': '^1.48.0' },
}, null, 2) + '\n');

put('jsconfig.json', `
{ "compilerOptions": { "checkJs": true, "noEmit": true, "module": "esnext", "target": "es2022" }, "include": ["src"] }
`);

put('vitest.config.js', `
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/component/**/*.test.js'],
    coverage: {
      enabled: true,
      include: ['src/**'],
      thresholds: {
        perFile: true,
        lines: 80,
      },
    },
  },
});
`);

put('playwright.config.js', `
import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: './e2e' });
`);

put('config/fees.json', `
{ "refundFee": 15, "windowDays": 30 }
`);

// ---- source -------------------------------------------------------------------------------------------------------
put('src/refund.js', `
import fees from '../config/fees.json' with { type: 'json' };

const DAY = 24 * 60 * 60 * 1000;

/** REQ-01: a refund may be requested up to and including day 30 after purchase. */
export function canRefund(purchasedAt, requestedAt) {
  const days = Math.floor((requestedAt - purchasedAt) / DAY);
  return days >= 0 && days <= fees.windowDays;
}

/** REQ-02: price paid minus the fee, never below zero. */
export function refundAmount(pricePaid, fee = fees.refundFee) {
  return Math.max(0, Math.round((pricePaid - fee) * 100) / 100);
}
`);

put('src/orders.js', `
export const PAGE_SIZE = 50;

/** REQ-03 and DEC-03: newest first, at most PAGE_SIZE per page. */
export function pageOrders(orders, page = 1) {
  const sorted = [...orders].sort((a, b) => b.purchasedAt - a.purchasedAt);
  return sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}
`);

put('src/gateway.js', `
const TIMEOUT_MS = 5000;

/** DEC-01: every gateway call has a 5 s timeout; a timeout or an error gives PENDING. */
export async function postRefund(baseUrl, orderId, amount) {
  try {
    const res = await fetch(\`\${baseUrl}/refunds\`, {
      method: 'POST',
      body: JSON.stringify({ orderId, amount }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'PENDING', reason: \`gateway \${res.status}\` };
    return { status: 'PAID', id: (await res.json()).id };
  } catch (e) {
    return { status: 'PENDING', reason: e.name === 'TimeoutError' ? 'timeout' : 'error' };
  }
}
`);

put('src/refund-service.js', `
import { canRefund, refundAmount } from './refund.js';
import { postRefund } from './gateway.js';

/** DEC-02: one payment per order, however often refund() is called. */
export class RefundService {
  constructor({ gatewayUrl, store = new Map() }) {
    this.gatewayUrl = gatewayUrl;
    this.store = store;
  }

  async refund(order, now = Date.now()) {
    if (this.store.has(order.id)) return this.store.get(order.id);
    if (!canRefund(order.purchasedAt, now)) return { status: 'REJECTED' };
    const result = await postRefund(this.gatewayUrl, order.id, refundAmount(order.pricePaid));
    this.store.set(order.id, result);
    return result;
  }
}
`);

put('src/admin.js', `
import fees from '../config/fees.json' with { type: 'json' };

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  return next();
}

/** REQ-04: PUT /admin/fee, admins only. */
export function mountAdmin(app) {
  app.put('/admin/fee', requireAdmin, (req, res) => {
    fees.refundFee = Number(req.body.fee);
    res.json({ refundFee: fees.refundFee });
  });
}
`);

put('src/app.js', `
import express from 'express';
import { mountAdmin } from './admin.js';

export function createApp({ user } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  mountAdmin(app);
  return app;
}
`);

// ---- tests --------------------------------------------------------------------------------------------------------
put('tests/unit/refund.test.js', `
import { describe, it, expect } from 'vitest';
import { canRefund, refundAmount } from '../../src/refund.js';

const DAY = 24 * 60 * 60 * 1000;
const bought = Date.UTC(2026, 0, 1);

describe('refund window', () => {
  it('REQ-01 accepts a request on day 30', () => {
    expect(canRefund(bought, bought + 30 * DAY)).toBe(true);
  });
  it('REQ-01 rejects a request on day 31', () => {
    expect(canRefund(bought, bought + 31 * DAY)).toBe(false);
  });
  it('REQ-01 accepts a request on day 29', () => {
    expect(canRefund(bought, bought + 29 * DAY)).toBe(true);
  });
});

describe('refund fee', () => {
  it('takes the $15 fee off the price paid', () => {
    expect(refundAmount(100)).toBe(85);
  });
  it('gives $0 when the price paid is exactly the $15 fee', () => {
    expect(refundAmount(15)).toBe(0);
  });
  it('gives $1 when the price paid is $16', () => {
    expect(refundAmount(16)).toBe(1);
  });
  it('gives $0 when the price paid is $14', () => {
    expect(refundAmount(14)).toBe(0);
  });
});
`);

put('tests/unit/orders.test.js', `
import { describe, it, expect } from 'vitest';
import { pageOrders, PAGE_SIZE } from '../../src/orders.js';

const orders = (n) => Array.from({ length: n }, (_, i) => ({ id: i, purchasedAt: i }));

describe('order history page', () => {
  it('returns all 50 orders when there are 50', () => {
    expect(pageOrders(orders(50))).toHaveLength(50);
  });
  it('returns 50 orders on the first page when there are 51', () => {
    expect(pageOrders(orders(51))).toHaveLength(50);
    expect(pageOrders(orders(51), 2)).toHaveLength(1);
  });
  it('lists the newest order first', () => {
    expect(pageOrders(orders(3))[0].id).toBe(2);
  });
  it('uses a page size of 50', () => {
    expect(PAGE_SIZE).toBe(50);
  });
});
`);

put('tests/component/admin.test.js', `
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('admin fee route', () => {
  it('lets an admin change the refund fee', async () => {
    const res = await request(createApp({ user: { role: 'admin' } })).put('/admin/fee').send({ fee: 20 });
    expect(res.status).toBe(200);
    expect(res.body.refundFee).toBe(20);
  });
  it('answers 403 to a customer who tries to change the fee', async () => {
    const res = await request(createApp({ user: { role: 'customer' } })).put('/admin/fee').send({ fee: 0 });
    expect(res.status).toBe(403);
  });
  it('answers 403 when nobody is logged in', async () => {
    const res = await request(createApp()).put('/admin/fee').send({ fee: 0 });
    expect(res.status).toBe(403);
  });
});
`);

put('tests/component/gateway.test.js', `
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { postRefund } from '../../src/gateway.js';

// A fake gateway: the real adapter runs against it over HTTP.
let server, url, delayMs = 0, status = 200;
beforeAll(async () => {
  server = http.createServer((req, res) => setTimeout(() => { res.statusCode = status; res.end(JSON.stringify({ id: 'r-1' })); }, delayMs));
  await new Promise((ok) => server.listen(0, ok));
  url = \`http://127.0.0.1:\${server.address().port}\`;
});
afterAll(() => server.close());

describe('payment gateway adapter', () => {
  it('pays when the gateway answers within 4999 ms', async () => {
    delayMs = 4999; status = 200;
    expect(await postRefund(url, 'o-1', 10)).toEqual({ status: 'PAID', id: 'r-1' });
  }, 10000);
  it('stores PENDING when the gateway takes 5001 ms (timeout after 5 s)', async () => {
    delayMs = 5001; status = 200;
    expect((await postRefund(url, 'o-2', 10)).status).toBe('PENDING');
  }, 10000);
  it('stores PENDING when the gateway answers 500', async () => {
    delayMs = 0; status = 500;
    expect(await postRefund(url, 'o-3', 10)).toEqual({ status: 'PENDING', reason: 'gateway 500' });
  });
});
`);

put('tests/unit/refund-service.test.js', `
import { describe, it, expect, vi } from 'vitest';
import { RefundService } from '../../src/refund-service.js';
import * as gateway from '../../src/gateway.js';

describe('RefundService.refund', () => {
  it('pays a refund sent twice only once and returns the stored result', async () => {
    const post = vi.spyOn(gateway, 'postRefund').mockResolvedValue({ status: 'PAID', id: 'r-9' });
    const svc = new RefundService({ gatewayUrl: 'http://gw' });
    const order = { id: 'o-9', purchasedAt: Date.now(), pricePaid: 40 };
    const first = await svc.refund(order);
    const second = await svc.refund(order);
    expect(second).toEqual(first);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
`);

put('e2e/refund.spec.js', `
import { test, expect } from '@playwright/test';

test('a customer sees the refund confirmation', async ({ page }) => {
  await page.goto('/orders/o-1');
  await page.getByRole('button', { name: 'Request refund' }).click();
  await expect(page.getByText('Refund requested')).toBeVisible();
});
`);

// ---- CI -----------------------------------------------------------------------------------------------------------
put('.github/workflows/pr.yml', `
name: PR checks
on:
  pull_request:
  push:
    branches: [main]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run format:check
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
`);

put('.github/workflows/nightly.yml', `
name: Nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run test:e2e
`);

module.exports = { BASE };
