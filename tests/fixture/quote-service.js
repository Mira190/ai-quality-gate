'use strict';
// Builds the fixture repository `acme/quote-service`: the invented repository the mock report describes.
// Every line the mock cites is placed at that line; `check(dir)` asserts them, so an edit here cannot silently move one.
const fs = require('node:fs');
const path = require('node:path');

const FILES = {};
const put = (p, text) => { FILES[p] = text.replace(/^\n/, ''); };

// ---- documents -------------------------------------------------------------------------------------------------
put('README.md', `
# quote-service

Online car insurance quotes: the customer enters a vehicle and a postcode, gets a premium, and can buy a policy.

## Development

    npm ci
    npm test

See docs/ for the requirements and the design.
`);

put('docs/requirements.md', `
# Quote service requirements

The quote service sells car insurance online. Each requirement has an ID.

- **REQ-01 Premium by vehicle age.** The premium shall be the base premium times the factor for the vehicle's age band in \`src/pricing/rates.json\`.

- **REQ-02 Excess $500 to $5,000.** The customer shall choose an excess from $500 to $5,000; the system shall reject any other amount.

- **REQ-03 Postcode eligibility.** The system shall offer a quote only for postcodes in the service area list.

- **REQ-04 Quote retention, 30 days.** A saved quote shall be kept for 30 days and then deleted.

- **REQ-05 Payment retried on failure.** Payment should be retried where possible.

- **REQ-06 Document, CRM update, event log.** After a purchase, the system shall email the policy document, send one update to the CRM and write one event-log entry.

- **REQ-07 Quote page usability.** The quote page should be easy to use.

- **REQ-08 Discount cap.** Discounts never exceed 20%.

- **REQ-09 Quote speed.** Quotes should load fast.

- **REQ-10 Session expiry.** Sessions must expire in a reasonable time.

- **REQ-11 Concession card discount.** Concession card holders get 10% off.

- **REQ-12 Cancellation refund.** Refund is pro rata minus a $50 fee.
`);

// design.md: DEC-11 is stated on line 88 and DEC-13 on line 101 (the mock cites both).
function designDoc() {
  const L = [];
  const pad = (to) => { let k = 0; while (L.length < to - 1) L.push(L.length % 2 ? `This note is kept for the design review record (${++k}).` : ''); };
  const dec = (id, title, text, meta, textLine) => {
    if (textLine) { pad(textLine - 2); if (L[L.length - 1] !== '') L.push(''); while (L.length < textLine - 2) L.push(''); }
    L.push(`### ${id} ${title}`, text, ...(meta ? [meta] : []), '');
  };
  L.push('# Quote service design', '', 'This document records how the quote service is built. Each decision has an ID.', '', '## Pricing', '');
  dec('DEC-01', 'Premium lookup', 'The pricing module reads the age bands from `src/pricing/rates.json` and multiplies the base premium by the band factor.');
  dec('DEC-02', 'Excess check', 'The quote form and the API both check the chosen excess against the allowed range before pricing.');
  dec('DEC-04', 'Premium rounding', 'Premiums are rounded half up to whole cents by `roundPremium` in `src/pricing/round.ts`.', 'Serves: REQ-01');
  L.push('## Storage', '');
  dec('DEC-03', 'Saved quotes', 'Saved quotes live in the `quotes` table; a nightly job deletes rows older than 30 days.');
  dec('DEC-12', 'Service area list', 'The postcode check reads the service area list from `config/areas.csv` and also keeps a second copy of it in an in-memory index that nothing reads.', 'Serves: REQ-03');
  L.push('## Payments', '');
  dec('DEC-05', 'Gateway timeout and retry limit', 'Calls to the payment gateway have a timeout and a retry limit, both set in `config/payment.json`; after the last retry the purchase fails with `PAYMENT_UNAVAILABLE`.', 'Serves: REQ-05');
  dec('DEC-06', 'Payment is idempotent', 'Each charge carries an idempotency key. `PaymentService.charge` stores the key with the result and returns the stored result when the same key comes again, so a request sent twice charges once.', 'Serves: REQ-05');
  L.push('## Notifications', '');
  dec('DEC-07', 'CRM timeout; errors surfaced', 'Calls to the CRM have a timeout. A CRM error is logged and returned to the caller; the purchase still completes.', 'Serves: REQ-06');
  dec('DEC-09', 'Policy document email', 'The notification service emails the policy document as a PDF.');
  L.push('## Access', '');
  dec('DEC-08', 'Admin routes check the role', 'Every `/admin` route checks that the user has the admin role and answers 403 otherwise.', 'Reason: only staff may change the rate table.');
  L.push('## Web', '');
  dec('DEC-10', 'Quote page cache', 'Quote pages are served from a CDN cache.');
  L.push('## Review notes', '');
  dec('DEC-11', 'Discounts stack up to 25%', 'Discounts stack, up to 25% in total.', 'Serves: REQ-08', 88);
  L.push('## Refunds', '');
  dec('DEC-13', 'Refund posted to the gateway', 'When a policy is cancelled, `RefundService.post` sends the refund to the payment gateway.', 'Serves: REQ-12', 101);
  return L.join('\n');
}
put('docs/design.md', designDoc());

put('docs/adr/0003-session-store.md', `
# ADR 0003: Session store in process memory

Status: Superseded

## Context

The first release ran on one server.

## Decision

Sessions shall be kept in process memory and shall be lost on restart.

## Consequences

A restart logs every customer out.
`);

// 84 KB of old rules: over the 60 KB read budget, so the run lists it under Not read.
function legacyRules() {
  const out = ['# Legacy underwriting rules', '', 'Imported from the old system. Kept for reference until the migration ends.', ''];
  let k = 0;
  while (out.join('\n').length < 86016 - 140) out.push(`- LR-${String(++k).padStart(4, '0')}: The legacy rater shall apply loading table ${k % 40} to cover class ${k % 9} unless an override is on file.`);
  let s = out.join('\n') + '\n';
  return s + '-'.repeat(86016 - Buffer.byteLength(s) - 1) + '\n';
}
put('docs/legacy-rules.md', legacyRules());

// ---- code ------------------------------------------------------------------------------------------------------
put('package.json', JSON.stringify({
  name: 'quote-service', private: true, type: 'module',
  scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc -p tsconfig.build.json', format: 'prettier --write .' },
  devDependencies: { vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0', '@playwright/test': '^1.48.0', supertest: '^7.0.0', typescript: '^5.6.0', eslint: '^9.0.0', prettier: '^3.3.0' },
  dependencies: { express: '^4.21.0', pg: '^8.13.0' },
}, null, 2) + '\n');

put('config/payment.json', `{ "timeoutMs": 10000, "maxRetries": 2 }\n`);
put('config/areas.csv', 'postcode\n2000\n2010\n3000\n');

put('src/config.ts', `
export const config = {
  crmUrl: process.env.CRM_URL ?? 'http://crm.internal',
  gatewayUrl: process.env.GATEWAY_URL ?? 'http://gateway.internal',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost/quotes',
};
`);

put('src/pricing/rates.json', JSON.stringify({ bands: [{ maxAge: 3, factor: 0.9 }, { maxAge: 7, factor: 1.0 }, { maxAge: 12, factor: 1.2 }, { maxAge: null, factor: 1.5 }] }, null, 2) + '\n');

put('src/pricing/premium.ts', `
import rates from './rates.json';
import { roundPremium } from './round';

// Base premium times the factor of the vehicle's age band.
export function premiumFor(base: number, vehicleAge: number): number {
  const band = rates.bands.find((b) => b.maxAge === null || vehicleAge <= b.maxAge)!;
  return roundPremium(base * band.factor);
}
`);

put('src/pricing/round.ts', `
// Half up to whole cents.
export function roundPremium(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
`);

put('src/pricing/excess.ts', `
export const MIN_EXCESS = 500;
export const MAX_EXCESS = 5000;

export function validateExcess(excess: number): boolean {
  return excess >= MIN_EXCESS && excess <= MAX_EXCESS;
}
`);

put('src/pricing/discount.ts', `
export interface Discounts { concessionCard?: boolean; multiPolicy?: boolean; }

// Applies every discount the customer has.
export function applyDiscount(premium: number, d: Discounts): number {
  let total = 0;
  if (d.concessionCard) total += 0.10;
  if (d.multiPolicy) total += 0.15;
  return premium * (1 - Math.min(total, 0.25));
}
`);

put('src/pricing/rates.ts', `
import type { Request, Response } from 'express';
import rates from './rates.json';

export function listRates(_req: Request, res: Response) {
  res.json(rates);
}

export function updateRates(req: Request, res: Response) {
  Object.assign(rates, req.body);
  res.status(200).json(rates);
}
`);

put('src/routes/admin.ts', `
import { Router } from 'express';
import { requireLogin } from '../auth/session';
import { listRates, updateRates } from '../pricing/rates';

// Admin routes: staff manage the rate table here.
export const router = Router();

router.get('/admin/rates', requireLogin, listRates);

// Changing the rates changes every new quote.
// Rates are posted as JSON.
router.post('/admin/rates', requireLogin, updateRates);

export default router;
`);

put('src/auth/session.ts', `
import type { Request, Response, NextFunction } from 'express';

export interface Session { id: string; userId: string; role: 'customer' | 'admin'; lastSeen: number; }

const sessions = new Map<string, Session>();

export function createSession(userId: string, role: Session['role']): Session {
  const s = { id: crypto.randomUUID(), userId, role, lastSeen: Date.now() };
  sessions.set(s.id, s);
  return s;
}

export function isExpired(s: Session, now: number, idleMs: number): boolean {
  return now - s.lastSeen > idleMs;
}

export function requireLogin(req: Request, res: Response, next: NextFunction) {
  const s = sessions.get(String(req.headers['x-session'] ?? ''));
  if (!s) return res.status(401).end();
  (req as any).session = s;
  next();
}
`);

put('src/eligibility.ts', `
import { readFileSync } from 'node:fs';

const areas = new Set(readFileSync('config/areas.csv', 'utf8').split('\\n').slice(1).filter(Boolean));
const index = new Map([...areas].map((p) => [p, true]));

export function isEligible(postcode: string): boolean {
  return areas.has(postcode);
}

export { index };
`);

put('src/quote/repo.ts', `
import { Client } from 'pg';

export const RETENTION_DAYS = 30;

export class QuoteRepository {
  constructor(private db: Client) {}

  async save(quote: { id: string; premium: number }, savedAt: Date) {
    await this.db.query('insert into quotes (id, premium, saved_at) values ($1, $2, $3)', [quote.id, quote.premium, savedAt]);
  }

  async find(id: string, now: Date) {
    const { rows } = await this.db.query('select * from quotes where id = $1', [id]);
    return rows[0] && !isPastRetention(rows[0].saved_at, now) ? rows[0] : null;
  }
}

export function isPastRetention(savedAt: Date, now: Date): boolean {
  return now.getTime() - savedAt.getTime() > RETENTION_DAYS * 24 * 3600 * 1000;
}
`);

put('src/payment/gateway-adapter.ts', `
import settings from '../../config/payment.json';
import { config } from '../config';

export interface GatewayCharge { key: string; amount: number; }

// Talks to the payment gateway over HTTP.
export class GatewayAdapter {
  async charge(c: GatewayCharge): Promise<{ ok: boolean; id?: string }> {
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
      const res = await fetch(\`\${config.gatewayUrl}/charges\`, { method: 'POST', body: JSON.stringify(c) });
      if (res.ok) return { ok: true, id: (await res.json()).id };
    }
    throw new Error('PAYMENT_UNAVAILABLE');
  }

  async refund(paymentId: string, amount: number): Promise<{ ok: boolean }> {
    const res = await fetch(\`\${config.gatewayUrl}/refunds\`, { method: 'POST', body: JSON.stringify({ paymentId, amount }) });
    return { ok: res.ok };
  }
}
`);

put('src/payment/simulator.ts', `
// A stand-in for the payment gateway, used by the integration tests.
export class PaymentSimulator {
  attempts = 0;
  constructor(private failFirst = 0, private delayMs = 0) {}

  async charge(amount: number, opts: { maxRetries: number; timeoutMs: number }) {
    while (this.attempts <= opts.maxRetries) {
      this.attempts++;
      if (this.delayMs > opts.timeoutMs) continue;
      if (this.attempts > this.failFirst) return { ok: true, amount };
    }
    return { ok: false, amount };
  }
}
`);

put('src/payment/service.ts', `
import { GatewayAdapter } from './gateway-adapter';

export interface ChargeRequest { idempotencyKey: string; amount: number; }
export interface ChargeResult { ok: boolean; paymentId?: string; }

const results = new Map<string, ChargeResult>();

// Charges a customer. A request may be retried by the browser.
export class PaymentService {
  constructor(private gateway = new GatewayAdapter()) {}

  /**
   * Charges once per idempotency key: a key seen before returns the
   * stored result and does not call the gateway again.
   *
   * The key comes from the browser, one per checkout.
   */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const seen = results.get(request.idempotencyKey);
    if (seen) return seen;
    const r = await this.gateway.charge({ key: request.idempotencyKey, amount: request.amount });
    const result = { ok: r.ok, paymentId: r.id };
    results.set(request.idempotencyKey, result);
    return result;
  }
}
`);

put('src/refund/amount.ts', `
export const CANCELLATION_FEE = 50;

// Pro rata refund of the unused days, minus the cancellation fee.
export function computeRefund(premium: number, daysUsed: number, daysInTerm: number): number {
  const unused = premium * (1 - daysUsed / daysInTerm);
  return Math.max(0, Math.round((unused - CANCELLATION_FEE) * 100) / 100);
}
`);

put('src/refund/service.ts', `
import { GatewayAdapter } from '../payment/gateway-adapter';
import { computeRefund } from './amount';

export interface Refund {
  policyId: string;
  paymentId: string;
  premium: number;
  daysUsed: number;
  daysInTerm: number;
}

export interface RefundRecord {
  policyId: string;
  amount: number;
  postedAt: Date;
}

const records: RefundRecord[] = [];

// Refunds are posted when a policy is cancelled.
export class RefundService {
  constructor(private gateway = new GatewayAdapter()) {}

  history(): RefundRecord[] {
    return records;
  }

  // Computes the amount and sends it to the payment gateway.
  // Called once per cancelled policy.
  async post(refund: Refund): Promise<void> {
    const amount = computeRefund(refund.premium, refund.daysUsed, refund.daysInTerm);
    await this.gateway.refund(refund.paymentId, amount);
    records.push({ policyId: refund.policyId, amount, postedAt: new Date() });
  }
}
`);

put('src/notify/crm.ts', `
// CRM adapter: tells the CRM about each new policy.
import { config } from '../config';

export interface CrmUpdate {
  policyId: string;
  customerId: string;
  premium: number;
}

export class CrmClient {
  constructor(private baseUrl = config.crmUrl) {}

  /**
   * Sends one update for a new policy.
   */
  async sendUpdate(update: CrmUpdate): Promise<void> {
    const body = JSON.stringify({
      policy: update.policyId,
      customer: update.customerId,
      premium: update.premium,
    });
    const res = await fetch(\`\${this.baseUrl}/policies\`, { method: 'POST', body });
    if (!res.ok) {
      throw new Error(\`CRM answered \${res.status}\`);
    }
  }
}

export const crm = new CrmClient();

// Called by the notification service after a purchase.
export async function notifyCrm(update: CrmUpdate): Promise<boolean> {
  try {
    await crm.sendUpdate(update);
    return true;
  } catch (e) {
    // The purchase must not fail because the CRM is down.
    // Keep going; the CRM catches up from the nightly export.
    void e;
    return true;
  }
}
`);

put('src/notify/notification.ts', `
import { notifyCrm } from './crm';

export interface Purchase { policyId: string; customerId: string; email: string; premium: number; }

// After a purchase: email the policy document, update the CRM, log the event.
export class NotificationService {
  sent: { to: string; document: string }[] = [];
  events: string[] = [];

  async afterPurchase(p: Purchase) {
    this.sent.push({ to: p.email, document: \`policy-\${p.policyId}.pdf\` });
    await notifyCrm({ policyId: p.policyId, customerId: p.customerId, premium: p.premium });
    this.events.push(\`purchase:\${p.policyId}\`);
    return { document: \`policy-\${p.policyId}.pdf\` };
  }
}
`);

// ---- tests -----------------------------------------------------------------------------------------------------
put('unit/excess.test.ts', `
import { describe, it, expect } from 'vitest';
import { validateExcess } from '../src/pricing/excess';

describe('validateExcess', () => {
  it('accepts an excess in the allowed range', () => {
    // The quote form offers a few fixed choices.
    const choice = 'standard';
    expect(choice).toBe('standard');
    expect(validateExcess(1000)).toBe(true);
  });

  it('rejects an excess above the range', () => {
    // Customers sometimes type an extra zero.
    const typed = 'extra zero';
    expect(validateExcess(10000)).toBe(false);
  });
});
`);

put('unit/session.test.ts', `
import { describe, it, expect } from 'vitest';
import { createSession, isExpired } from '../src/auth/session';

describe('sessions', () => {
  it('creates a customer session', () => {
    const s = createSession('u1', 'customer');
    expect(s.role).toBe('customer');
  });

  it('gives each session its own id', () => {
    const a = createSession('u1', 'customer');
    const b = createSession('u1', 'customer');
    expect(a.id).not.toBe(b.id);
  });

  // Waiting for the idle limit to be agreed.
  // Owner: product.
  it.skip('expires a session after the idle limit', () => {
    const s = createSession('u1', 'customer');
    expect(isExpired(s, s.lastSeen + 1, 0)).toBe(true);
  });

  // Same reason as above.
  it.skip('keeps an active session alive', () => {
    const s = createSession('u1', 'customer');
    expect(isExpired(s, s.lastSeen, 0)).toBe(false);
  });
});
`);

put('unit/refund.test.ts', `
import { describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { computeRefund } from '../src/refund/amount';

const db = new Client({ connectionString: process.env.DATABASE_URL });

describe('computeRefund', () => {
  it('refunds the unused days minus the fee', async () => {
    await db.connect();
    expect(computeRefund(1200, 60, 360)).toBe(950);
    await db.end();
  });

  it('charges the fee of 50 even on the first day', () => {
    expect(computeRefund(1200, 0, 360)).toBe(1150);
  });

  it('never refunds a negative amount', () => {
    expect(computeRefund(49, 0, 360)).toBe(0);
  });
});
`);

put('unit/rounding.test.ts', `
import { describe, it, expect } from 'vitest';
import { roundPremium } from '../src/pricing/round';

describe('roundPremium', () => {
  it('rounds a half cent up', () => {
    expect(roundPremium(10.005)).toBe(10.01);
  });

  it('rounds below a half cent down', () => {
    expect(roundPremium(10.004)).toBe(10.0);
  });
});
`);

put('component/notification.test.ts', `
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../src/notify/notification';
import { notifyCrm } from '../src/notify/crm';

// The CRM client is replaced: these tests check what the notification
// service sends, not the CRM itself. The CRM adapter has its
// own tests (none yet).
vi.mock('../src/notify/crm');

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
    vi.mocked(notifyCrm).mockResolvedValue(true);
  });

  it('emails the policy document after a purchase', async () => {
    await service.afterPurchase({
      policyId: 'p1',
      customerId: 'c1',
      email: 'a@example.com',
      premium: 640,
    });
    const sent = service.sent[0];
    expect(sent.to).toBe('a@example.com');
    expect(sent.document).toBe('policy-p1.pdf');
  });

  it('returns the document name', async () => {
    const r = await service.afterPurchase({ policyId: 'p2', customerId: 'c2', email: 'b@example.com', premium: 640 });
    expect(r.document).toBe('policy-p2.pdf');
  });
});
`);

put('integration/helpers/db.ts', `
import { Client } from 'pg';
export const connect = async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; };
`);

put('integration/quote-repo.test.ts', `
import { describe, it, expect } from 'vitest';
import { connect } from './helpers/db';
import { QuoteRepository } from '../src/quote/repo';

const day = 24 * 3600 * 1000;

describe('QuoteRepository', () => {
  it('finds a quote saved 30 days ago', async () => {
    const repo = new QuoteRepository(await connect());
    const now = new Date();
    await repo.save({ id: 'q1', premium: 640 }, new Date(now.getTime() - 30 * day));
    expect(await repo.find('q1', now)).not.toBeNull();
  });

  it('does not find a quote saved 31 days ago', async () => {
    const repo = new QuoteRepository(await connect());
    const now = new Date();
    await repo.save({ id: 'q2', premium: 640 }, new Date(now.getTime() - 31 * day));
    expect(await repo.find('q2', now)).toBeNull();
  });
});
`);

put('integration/payment.test.ts', `
import { describe, it, expect } from 'vitest';
import { connect } from './helpers/db';
import { PaymentService } from '../src/payment/service';

describe('PaymentService against the sandbox gateway', () => {
  it('charges a card', async () => {
    await connect();
    const r = await new PaymentService().charge({ idempotencyKey: 'k1', amount: 640 });
    expect(r.ok).toBe(true);
  });

  it('retries a declined payment and then succeeds', async () => {
    const r = await new PaymentService().charge({ idempotencyKey: 'decline-once', amount: 640 });
    expect(r.ok).toBe(true);
  });
});
`);

put('integration/payment-sim.test.ts', `
import { describe, it, expect } from 'vitest';
import settings from '../config/payment.json';
import { PaymentSimulator } from '../src/payment/simulator';

describe('payment retry limit', () => {
  it('succeeds when the gateway fails 2 times', async () => {
    const sim = new PaymentSimulator(2);
    expect((await sim.charge(640, settings)).ok).toBe(true);
  });

  it('gives up when the gateway fails 3 times', async () => {
    const sim = new PaymentSimulator(3);
    expect((await sim.charge(640, settings)).ok).toBe(false);
  });

  it('accepts an answer at 10000 ms', async () => {
    const sim = new PaymentSimulator(0, 10000);
    expect((await sim.charge(640, settings)).ok).toBe(true);
  });

  it('times out an answer at 10001 ms', async () => {
    const sim = new PaymentSimulator(0, 10001);
    expect((await sim.charge(640, settings)).ok).toBe(false);
  });
});
`);

put('integration/purchase.test.ts', `
import { describe, it, expect } from 'vitest';
import { connect } from './helpers/db';
import { NotificationService } from '../src/notify/notification';

describe('purchase', () => {
  it('sends the policy document after a purchase', async () => {
    await connect();
    const service = new NotificationService();
    const r = await service.afterPurchase({ policyId: 'p9', customerId: 'c9', email: 'c@example.com', premium: 640 });
    expect(r.document).toBe('policy-p9.pdf');
  });
});
`);

put('integration/eligibility.test.ts', `
import { describe, it, expect } from 'vitest';
import { connect } from './helpers/db';
import { isEligible } from '../src/eligibility';

describe('postcode eligibility', () => {
  it('offers a quote in the service area', async () => {
    await connect();
    expect(isEligible('2000')).toBe(true);
  });

  it('refuses a postcode outside the service area', () => {
    expect(isEligible('9999')).toBe(false);
  });
});
`);

put('e2e/quote.spec.ts', (() => {
  const ages = [[1, 540], [5, 600], [9, 720], [10, 720], [15, 900], [16, 900], [20, 900], [25, 900], [30, 900]];
  return `import { test, expect } from '@playwright/test';

test.describe('quote page premium', () => {
${ages.map(([a, p]) => `  test('shows the premium for a vehicle aged ${a}', async ({ page }) => {
    await page.goto('/quote');
    await page.fill('#vehicle-age', '${a}');
    await page.click('text=Get quote');
    await expect(page.locator('#premium')).toHaveText('$${p}.00');
  });`).join('\n\n')}
});
`;
})());

put('e2e/retrieve.spec.ts', `
import { test, expect } from '@playwright/test';

test('a saved quote can be opened again within its retention', async ({ page }) => {
  await page.goto('/quotes/saved-30-days-ago');
  await expect(page.locator('#premium')).toBeVisible();
});

test('a saved quote past its retention is gone', async ({ page }) => {
  await page.goto('/quotes/saved-31-days-ago');
  await expect(page.locator('h1')).toHaveText('Quote not found');
});
`);

put('e2e/buy.spec.ts', `
import { test, expect } from '@playwright/test';

test('buying a policy shows the policy document', async ({ page }) => {
  await page.goto('/quote/q1/buy');
  await page.click('text=Pay');
  await expect(page.locator('#document-link')).toBeVisible();
});
`);

// Filler: tests of helpers no rule describes, so the counts match the mock (376 tests in 74 files).
const FILLER = ['text', 'dates', 'money-format', 'ids', 'forms', 'urls', 'colors', 'layout'];
for (const name of FILLER) put(`src/util/${name}.ts`, `export const ${name.replace(/-(\w)/g, (_, c) => c.toUpperCase())}Label = (n: number): string => \`${name} \${n}\`;\n`);

// ---- CI and runner configs ---------------------------------------------------------------------------------------
put('.github/workflows/pr.yml', `
name: pr
on:
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Lint
        run: npm run lint
      - name: Type check
        run: npm run typecheck
      - name: Unit and component tests
        run: npm test -- --coverage
      - name: Build
        run: npm run build
      - name: Upload coverage
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level=high
        continue-on-error: true
`);

put('.github/workflows/nightly.yml', `
name: nightly
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx vitest run --config vitest.integration.config.ts
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npx playwright install --with-deps
      - run: npx playwright test
`);

put('vitest.config.ts', `
import { defineConfig } from 'vitest/config';

// PR run: unit and component tests.
// The integration config (vitest.integration.config.ts) runs
// the database tests nightly.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'unit/**/*.test.ts',
      'component/**/*.test.ts',
    ],
    exclude: [
      'unit/refund.test.ts', // starts a database
    ],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 70,
      },
      exclude: [
        'src/pricing/**',
      ],
    },
  },
});
`);

put('vitest.integration.config.ts', `
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['integration/**/*.test.ts', 'unit/refund.test.ts'] } });
`);

put('playwright.config.ts', `
import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: './e2e', use: { baseURL: 'http://localhost:3000' } });
`);

put('tsconfig.json', '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "resolveJsonModule": true } }\n');

// filler test files: 61 files, cases spread so the total is 376
function fillerTests() {
  const ruleCases = Object.entries(FILES).filter(([p]) => /\.(test|spec)\.ts$/.test(p)).reduce((s, [, t]) => s + (t.match(/^\s*(?:it|test)(?:\.skip)?\(/gm) || []).length, 0);
  const files = 74 - Object.keys(FILES).filter((p) => /\.(test|spec)\.ts$/.test(p)).length;
  let left = 376 - ruleCases;
  for (let k = 0; k < files; k++) {
    const n = Math.round(left / (files - k));
    left -= n;
    const util = FILLER[k % FILLER.length], fn = util.replace(/-(\w)/g, (_, c) => c.toUpperCase()) + 'Label';
    put(`unit/util/${util}-${String(k + 1).padStart(2, '0')}.test.ts`, `import { describe, it, expect } from 'vitest';
import { ${fn} } from '../../src/util/${util}';

describe('${fn}', () => {
${Array.from({ length: n }, (_, i) => `  it('labels item ${k * 10 + i + 100}', () => {
    expect(${fn}(${k * 10 + i + 100})).toBe('${util} ${k * 10 + i + 100}');
  });`).join('\n')}
});
`);
  }
}
fillerTests();

// ---- build and check -----------------------------------------------------------------------------------------------
const CITED = [
  ['docs/requirements.md', 13, 'Payment should be retried where possible'], ['docs/requirements.md', 19, 'Discounts never exceed 20%'],
  ['docs/requirements.md', 23, 'Sessions must expire in a reasonable time'], ['docs/requirements.md', 25, 'Concession card holders get 10% off'],
  ['docs/requirements.md', 27, 'Refund is pro rata minus a $50 fee'], ['docs/design.md', 88, 'up to 25%'], ['docs/design.md', 101, 'RefundService.post'],
  ['src/routes/admin.ts', 12, "router.post('/admin/rates', requireLogin"], ['src/notify/crm.ts', 22, 'await fetch('], ['src/notify/crm.ts', 40, 'return true'],
  ['src/payment/service.ts', 18, 'async charge('], ['src/refund/service.ts', 30, 'async post('],
  ['unit/excess.test.ts', 9, '1000'], ['unit/excess.test.ts', 15, '10000'], ['unit/session.test.ts', 18, 'it.skip('], ['unit/session.test.ts', 24, 'it.skip('],
  ['unit/refund.test.ts', 2, "from 'pg'"], ['component/notification.test.ts', 8, 'vi.mock('], ['component/notification.test.ts', 27, 'expect(sent.document)'],
  ['integration/payment-sim.test.ts', 3, 'PaymentSimulator'], ['vitest.config.ts', 14, 'unit/refund.test.ts'], ['vitest.config.ts', 19, 'lines: 70'], ['vitest.config.ts', 22, 'src/pricing/**'],
  ['.github/workflows/pr.yml', 14, 'npm run lint'], ['.github/workflows/pr.yml', 16, 'npm run typecheck'], ['.github/workflows/pr.yml', 18, 'npm test'], ['.github/workflows/pr.yml', 31, 'npm audit'],
  ['.github/workflows/nightly.yml', 12, 'vitest run --config'], ['.github/workflows/nightly.yml', 30, 'playwright test'],
];

function build(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [p, text] of Object.entries(FILES)) { fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  check(dir);
  return dir;
}

function check(dir) {
  for (const [p, n, want] of CITED) {
    const line = fs.readFileSync(path.join(dir, p), 'utf8').split('\n')[n - 1] || '';
    if (!line.includes(want)) throw new Error(`fixture: ${p}:${n} should contain "${want}" but is "${line}"`);
  }
  const size = fs.statSync(path.join(dir, 'docs/legacy-rules.md')).size;
  if (Math.round(size / 1024) !== 84) throw new Error(`fixture: legacy-rules.md is ${size} bytes`);
}

module.exports = { build, check, FILES };
