'use strict';
// Golden test: build the fixture repository quote-service, run the whole pipeline with the model's replies replayed
// from the cassette, and check that the report equals the mock. Only the mock's own label is stripped: " (MOCK)" in
// the title and the blockquote under it, which describe the mock and are not part of any report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('./fixture/quote-service');
const { run } = require('../src/pipeline');
const { LLM } = require('../src/llm');

const MOCK = path.join(__dirname, '../mock-report-summary (2).md');
const CASSETTE = path.join(__dirname, 'fixture/quote-service.cassette.json');

const expected = () => fs.readFileSync(MOCK, 'utf8').replace(' (MOCK)\n', '\n').replace(/\n(> .*\n)+\n/, '\n');

test('the quote-service report equals the mock', async () => {
  const dir = build(fs.mkdtempSync(path.join(os.tmpdir(), 'quote-service-')));
  const llm = new LLM({ mode: 'replay', cassette: CASSETTE });
  const { report, ledger } = await run({ root: dir, repo: 'acme/quote-service', sha: 'a1b2c3d', date: '2026-10-22', llm });
  if (process.env.WRITE_ACTUAL) fs.writeFileSync(process.env.WRITE_ACTUAL, report);
  assert.deepStrictEqual(ledger.dropped, [], 'no model output was dropped');
  assert.strictEqual(report, expected());
});
