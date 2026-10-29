#!/usr/bin/env node
'use strict';
// Writes tests/fixture/quote-service.cassette.json: the model replies for the fixture repository, as the mock report
// shows them. The golden test replays it, so it checks everything code does (finding, counting, linking, checking,
// ranking, numbering, grouping, rendering) against the mock with the model's part held fixed.
// The written cells are taken from the mock's rows; the judgments are written out here, one per rule.
// Run: node tests/fixture/make-cassette.js   (after a change to the fixture or the mock)
const fs = require('node:fs');
const path = require('node:path');
const { FILES } = require('./quote-service');

const MOCK = path.join(__dirname, '../../mock-report-summary (2).md');
const OUT = path.join(__dirname, 'quote-service.cassette.json');
const lineOf = (file, needle, nth = 1) => { let k = 0; const i = FILES[file].split('\n').findIndex((l) => l.includes(needle) && ++k === nth); if (i < 0) throw new Error(`${file}: "${needle}" not found`); return i + 1; };

// ---- sections 1 and 2 judgments ---------------------------------------------------------------------------------
const none = { fails: [], restates: '', adds_behaviour: true, boundary: 'none' };
const R = (id, o) => ({ id, ...none, logic_kind: 'other', limits: [], terms: [], ...o });
const fail = (measure, why, o = {}) => ({ why, readings: [], raised_by: '', conflict_with: '', part: '', measure, ...o });
const requirements = [
  R('REQ-01', { logic_kind: 'calculation', limits: [3, 7, 12].map((v) => ({ value: v, unit: 'years', source: 'src/pricing/rates.json' })), terms: ['premium', 'vehicle age', 'premiumFor'] }),
  R('REQ-02', { logic_kind: 'validation', limits: [{ value: 500, unit: '$', source: 'text' }, { value: 5000, unit: '$', source: 'text' }], terms: ['validateExcess', 'excess'] }),
  R('REQ-03', { logic_kind: 'validation', terms: ['isEligible', 'postcode'] }),
  R('REQ-04', { logic_kind: 'date', limits: [{ value: 30, unit: 'days', source: 'text' }], terms: ['QuoteRepository', 'retention', '30 days'] }),
  R('REQ-05', { logic_kind: 'io', fails: [fail('Testable', 'no retry count, no timing, no errors named')], terms: ['retries', 'declined payment'] }),
  R('REQ-06', { logic_kind: 'io', terms: ['policy document', 'CRM', 'event log'] }),
  R('REQ-07', { logic_kind: 'ui', fails: [fail('Testable', '"easy to use" has no expected result')], terms: ['quote page'] }),
  R('REQ-08', { logic_kind: 'calculation', limits: [{ value: 20, unit: '%', source: 'text' }], fails: [fail('Testable', 'does not say what happens above the cap'), fail('Consistent', 'DEC-11 allows 25%', { conflict_with: 'DEC-11' })], terms: ['discount cap', 'total discount'] }),
  R('REQ-09', { logic_kind: 'ui', fails: [fail('Specific', '"fast" has no number'), fail('Testable', 'no load-time limit')], terms: ['load time'] }),
  R('REQ-10', { logic_kind: 'date', fails: [fail('Testable', '"a reasonable time" gives no limit')], terms: ['isExpired', 'expire'] }),
  R('REQ-11', { logic_kind: 'calculation', limits: [{ value: 10, unit: '%', source: 'text' }], fails: [fail('Complete', 'does not say how it combines with other discounts', { part: 'the stacking case only', raised_by: 'DEC-11' })], terms: ['applyDiscount', 'concession'] }),
  R('REQ-12', { logic_kind: 'calculation', limits: [{ value: 50, unit: '$', source: 'text' }], fails: [fail('Clear', 'pro rata by day or by month gives two refunds', { readings: ['pro rata by days left in the term', 'pro rata by whole months left'] })], terms: ['computeRefund', 'cancellation fee'] }),
];
const restates = (id, req, o = {}) => R(id, { restates: req, adds_behaviour: false, ...o });
const decisions = [
  restates('DEC-01', 'REQ-01', { logic_kind: 'calculation' }),
  restates('DEC-02', 'REQ-02', { logic_kind: 'validation' }),
  restates('DEC-03', 'REQ-04', { logic_kind: 'date', boundary: 'stored_data' }),
  R('DEC-04', { logic_kind: 'calculation', terms: ['roundPremium', 'half up'] }),
  R('DEC-05', { logic_kind: 'count', boundary: 'outside_call', limits: [{ value: 10000, unit: 'ms', source: 'config/payment.json' }, { value: 2, unit: '', source: 'config/payment.json' }], terms: ['PaymentSimulator', 'retry limit', 'timeout'] }),
  R('DEC-06', { logic_kind: 'io', boundary: 'stored_data', terms: ['idempotency', 'same key'] }),
  R('DEC-07', { logic_kind: 'io', boundary: 'outside_call', terms: ['CRM', 'notifyCrm', 'timeout'] }),
  R('DEC-08', { logic_kind: 'access', terms: ['admin role', '/admin/rates'] }),
  restates('DEC-09', 'REQ-06', { logic_kind: 'io' }),
  restates('DEC-10', 'REQ-09', { logic_kind: 'ui' }),
  restates('DEC-11', 'REQ-08', { logic_kind: 'calculation', fails: [fail('Trade-off', 'conflicts with the 20% cap in REQ-08 and does not say which wins', { conflict_with: 'REQ-08' })] }),
  restates('DEC-12', 'REQ-03', { logic_kind: 'validation', fails: [fail('Simple', 'the second in-memory copy serves no requirement')] }),
  R('DEC-13', { logic_kind: 'io', boundary: 'outside_call', fails: [fail('Failure behaviour', 'nothing on a refund the gateway rejects or does not answer')], terms: ['RefundService'] }),
];

// ---- tracing: implementation and tests ---------------------------------------------------------------------------
const impl = (id, p, needle, symbol, tests = []) => ({ id, impl_path: p, impl_line: lineOf(p, needle), impl_symbol: symbol, tests });
const noImpl = (id) => ({ id, impl_path: '', impl_line: 0, impl_symbol: '', tests: [] });
const trace = [
  impl('REQ-01', 'src/pricing/premium.ts', 'export function premiumFor', 'premiumFor', ['e2e/quote.spec.ts']),
  impl('REQ-02', 'src/pricing/excess.ts', 'export function validateExcess', 'validateExcess', ['unit/excess.test.ts']),
  impl('REQ-03', 'src/eligibility.ts', 'export function isEligible', 'isEligible', ['integration/eligibility.test.ts']),
  impl('REQ-04', 'src/quote/repo.ts', 'export function isPastRetention', 'isPastRetention', ['integration/quote-repo.test.ts', 'e2e/retrieve.spec.ts']),
  impl('REQ-05', 'src/payment/gateway-adapter.ts', 'for (let attempt', 'GatewayAdapter.charge', ['integration/payment.test.ts']),
  impl('REQ-06', 'src/notify/notification.ts', 'async afterPurchase', 'NotificationService.afterPurchase', ['component/notification.test.ts', 'integration/purchase.test.ts', 'e2e/buy.spec.ts']),
  noImpl('REQ-07'),
  impl('REQ-08', 'src/pricing/discount.ts', 'Math.min(total', 'applyDiscount'),
  noImpl('REQ-09'),
  impl('REQ-10', 'src/auth/session.ts', 'export function isExpired', 'isExpired', ['unit/session.test.ts']),
  impl('REQ-11', 'src/pricing/discount.ts', 'export function applyDiscount', 'applyDiscount'),
  impl('REQ-12', 'src/refund/amount.ts', 'export function computeRefund', 'computeRefund', ['unit/refund.test.ts']),
  impl('DEC-01', 'src/pricing/premium.ts', 'export function premiumFor', 'premiumFor', ['e2e/quote.spec.ts']),
  impl('DEC-02', 'src/pricing/excess.ts', 'export function validateExcess', 'validateExcess', ['unit/excess.test.ts']),
  impl('DEC-03', 'src/quote/repo.ts', 'export function isPastRetention', 'isPastRetention', ['integration/quote-repo.test.ts']),
  impl('DEC-04', 'src/pricing/round.ts', 'export function roundPremium', 'roundPremium', ['unit/rounding.test.ts']),
  impl('DEC-05', 'src/payment/gateway-adapter.ts', 'async charge(', 'GatewayAdapter.charge', ['integration/payment-sim.test.ts']),
  impl('DEC-06', 'src/payment/service.ts', 'async charge(', 'PaymentService.charge'),
  impl('DEC-07', 'src/notify/crm.ts', 'async sendUpdate', 'CrmClient.sendUpdate', ['component/notification.test.ts']),
  impl('DEC-08', 'src/routes/admin.ts', "router.post('/admin/rates'", 'router.post /admin/rates'),
  impl('DEC-09', 'src/notify/notification.ts', 'async afterPurchase', 'NotificationService.afterPurchase', ['component/notification.test.ts']),
  noImpl('DEC-10'),
  impl('DEC-11', 'src/pricing/discount.ts', 'Math.min(total', 'applyDiscount'),
  impl('DEC-12', 'src/eligibility.ts', 'const index', 'index'),
  impl('DEC-13', 'src/refund/service.ts', 'async post(', 'RefundService.post'),
];

// ---- asserts the rule; suspected not built --------------------------------------------------------------------------
const A = (id, file, needle, asserts = true, what = '') => ({ id, asserts, cite_path: file, cite_line: lineOf(file, needle), what });
const asserts = [
  A('REQ-01', 'e2e/quote.spec.ts', "toHaveText('$540.00')"), A('REQ-02', 'unit/excess.test.ts', 'validateExcess(1000)'), A('REQ-03', 'integration/eligibility.test.ts', "isEligible('2000')"),
  A('REQ-04', 'integration/quote-repo.test.ts', 'not.toBeNull()'), A('REQ-05', 'integration/payment.test.ts', 'expect(r.ok)', true), A('REQ-06', 'component/notification.test.ts', 'expect(sent.document)', false, 'only the policy document name; nothing checks the CRM update or the event log'),
  A('REQ-10', 'unit/session.test.ts', 'lastSeen + 1'), A('REQ-12', 'unit/refund.test.ts', 'toBe(950)'), A('DEC-01', 'e2e/quote.spec.ts', "toHaveText('$540.00')"), A('DEC-02', 'unit/excess.test.ts', 'validateExcess(1000)'),
  A('DEC-03', 'integration/quote-repo.test.ts', 'not.toBeNull()'), A('DEC-04', 'unit/rounding.test.ts', 'toBe(10.01)'), A('DEC-05', 'integration/payment-sim.test.ts', 'toBe(true)'),
  A('DEC-07', 'component/notification.test.ts', 'expect(sent.document)', false, 'only the policy document name: no timeout case and no error case'), A('DEC-09', 'component/notification.test.ts', 'expect(sent.document)'),
];
const built = [
  { id: 'DEC-04', verdict: 'built', path: 'src/pricing/round.ts', line: lineOf('src/pricing/round.ts', 'Math.round'), why: 'rounds to cents' },
  { id: 'DEC-05', verdict: 'unsure', path: 'src/payment/gateway-adapter.ts', line: lineOf('src/payment/gateway-adapter.ts', 'await fetch'), why: 'retries up to maxRetries; no timeout is visible on the fetch, but it may be set elsewhere' },
  { id: 'DEC-06', verdict: 'built', path: 'src/payment/service.ts', line: lineOf('src/payment/service.ts', 'if (seen) return seen'), why: 'returns the stored result for a key seen before' },
  { id: 'DEC-07', verdict: 'not_built', path: 'src/notify/crm.ts', line: 22, why: 'the CRM fetch sets no timeout, and notifyCrm swallows errors (line 40)' },
  { id: 'DEC-08', verdict: 'not_built', path: 'src/routes/admin.ts', line: 12, why: 'the route checks the login only, not the admin role' },
  { id: 'DEC-13', verdict: 'unsure', path: 'src/refund/service.ts', line: lineOf('src/refund/service.ts', 'this.gateway.refund'), why: 'the gateway answer is not checked, but the decision does not say what should happen' },
];

// ---- test plan -------------------------------------------------------------------------------------------------
const T = (key, level, rules, issues, after = []) => ({ key, level, rules, issues, after });
const plan = [
  T('admin-role', 'component', ['DEC-08'], [21, 22]),
  T('crm-component', 'component', ['DEC-07'], [20, 26, 27]),
  T('premium-band-edges', 'unit', ['REQ-01'], [11, 12]),
  T('excess-limits', 'unit', ['REQ-02'], [13]),
  T('quote-window', 'unit', ['REQ-04'], [14]),
  T('crm-update', 'component', ['REQ-06'], [16], ['crm-component']),
  T('concession-discount', 'unit', ['REQ-11'], [10]),
  T('payment-timeout', 'component', ['DEC-05'], [15, 24]),
  T('charge-once', 'unit', ['DEC-06'], [19]),
  T('retry-count', 'unit', ['REQ-05', 'DEC-05'], [15, 25]),
  T('discount-cap', 'unit', ['REQ-08'], [9]),
  T('session-expiry', 'unit', ['REQ-10'], [17]),
  T('refund-amount', 'unit', ['REQ-12'], [18]),
  T('refund-rejected', 'component', ['DEC-13'], [23]),
];

// ---- written cells, from the mock --------------------------------------------------------------------------------
const mock = fs.readFileSync(MOCK, 'utf8');
const rows = mock.split('\n').filter((l) => /^\| I-\d+ \|/.test(l)).map((l) => l.slice(2, -2).split(' | '));
const cells = new Map(rows.map((c) => [Number(c[0].slice(2)), c[c.length - 1]]));
const actionRows = mock.split('\n').filter((l) => /^\| \d \| \*\*/.test(l)).map((l) => l.slice(2, -2).split(' | '));
const section = (n) => { const m = mock.split(/<a id="s\d"><\/a>/)[n]; return [...m.matchAll(/^\| I-(\d+) \|/gm)].map((x) => Number(x[1])); };
const write = (s) => ({ cells: section(s).map((n) => ({ issue: `I-${n}`, text: cells.get(n) })) });

const all = (key, n, output) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${key}:${i}`, { output, usage: {} }]));
const tape = {
  model: (mock.match(/model `([^`]+)`/) || [])[1],
  note: 'Golden cassette for the quote-service fixture. Generated by tests/fixture/make-cassette.js; the cells come from the mock report.',
  calls: {
    'judge:requirement:0': { output: { rules: requirements }, usage: {} },
    'judge:decision:0': { output: { rules: decisions }, usage: {} },
    ...all('trace', 4, { rules: trace }),
    ...all('asserts', 4, { rules: asserts }),
    'built:0': { output: { decisions: built }, usage: {} },
    'plan-tests': { output: { tests: plan }, usage: {} },
    'write:s1': { output: write(1), usage: {} },
    'write:s2': { output: write(2), usage: {} },
    'write:s3': { output: write(3), usage: {} },
    'write:s4': { output: write(4), usage: {} },
    // the mock's AI usage total is carried on the last call, so the footer reproduces too
    'write:actions': { output: { actions: actionRows.map((c) => ({ action: Number(c[0]), do: c[1], risk: c[2] })) }, usage: { usd: Number((mock.match(/\*\*([\d.]+) AIU\*\*/) || [])[1]) / 100 } },
  },
};
fs.writeFileSync(OUT, JSON.stringify(tape, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(tape.calls).length} calls, ${cells.size} cells, ${actionRows.length} actions`);
