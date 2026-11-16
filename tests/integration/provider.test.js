'use strict';
// The Copilot CLI provider against a stand-in executable: the real CLI is not needed to prove how the gate calls it.
// covers: DEC-5
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeProvider } = require('../../src/ai/provider');
const { loadConfig } = require('../../src/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-provider-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake `copilot`: records how it was called, then behaves as the script says. */
function fakeCopilot(name, body) {
  const bin = path.join(tmp, name), log = path.join(tmp, `${name}.log`);
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.400'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), files: fs.readdirSync('.'), env: Object.keys(process.env), token: process.env.COPILOT_GITHUB_TOKEN }) + '\\n');
${body}
`, { mode: 0o755 });
  return { bin, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}
const withEnv = async (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const cfg = (ai = {}) => loadConfig(null, { ai: { provider: 'copilot', ...ai } }).config;

test('DEC-5 the Copilot CLI is called in programmatic mode, with no tool allowed, in an empty directory, with a minimal environment', async () => {
  const fake = fakeCopilot('copilot-ok', "console.log('{\"verdicts\":[]}');");
  await withEnv({ AQG_COPILOT_BIN: fake.bin, COPILOT_GITHUB_TOKEN: 'github_pat_test', AWS_SECRET_ACCESS_KEY: 'do-not-leak', GITHUB_TOKEN: 'ghs_do_not_leak' }, async () => {
    const p = makeProvider(cfg({ model: 'gpt-5' }));
    assert.deepEqual([p.name, p.available, p.version], ['copilot', true, '0.0.400']);
    assert.equal((await p.complete('the prompt')).trim(), '{"verdicts":[]}');
    const call = fake.calls()[0];
    assert.deepEqual(call.args.slice(0, 2), ['-p', 'the prompt']);
    for (const flag of ['-s', '--no-ask-user', '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url', '--model=gpt-5']) assert.ok(call.args.includes(flag), flag);
    assert.ok(!call.args.some((a) => a.startsWith('--allow')), 'no tool is ever allowed');
    assert.deepEqual(call.files, [], 'the model runs in an empty directory, not in the repository');
    assert.notEqual(call.cwd, process.cwd());
    assert.equal(call.token, 'github_pat_test');
    assert.ok(!call.env.includes('AWS_SECRET_ACCESS_KEY') && !call.env.includes('GITHUB_TOKEN'), 'other secrets of the job are not passed on');
  });
});

test('a CLI that does not know a flag is called again with the two flags that define the mode', async () => {
  const fake = fakeCopilot('copilot-old', "if (args.includes('--no-ask-user')) { console.error(\"error: unknown option '--no-ask-user'\"); process.exit(1); }\nconsole.log('ok');");
  await withEnv({ AQG_COPILOT_BIN: fake.bin, COPILOT_GITHUB_TOKEN: 'github_pat_test' }, async () => {
    const p = makeProvider(cfg());
    assert.equal((await p.complete('x')).trim(), 'ok');
    assert.deepEqual(fake.calls().map((c) => c.args), [['-p', 'x', '-s', '--no-ask-user', '--no-auto-update', '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url'], ['-p', 'x', '-s']]);
  });
});

test('GATE-19 a failing or hanging CLI is an error with the token redacted, never a crash', async () => {
  const fail = fakeCopilot('copilot-fail', "console.error('401 bad credentials for github_pat_abcdefgh12345678'); process.exit(1);");
  const hang = fakeCopilot('copilot-hang', 'setTimeout(() => {}, 60000);');
  await withEnv({ AQG_COPILOT_BIN: fail.bin, COPILOT_GITHUB_TOKEN: 'github_pat_abcdefgh12345678' }, async () => {
    await assert.rejects(makeProvider(cfg()).complete('x'), (e) => /exit 1: 401 bad credentials for github_pat_\*\*\*/.test(e.message) && !e.message.includes('abcdefgh'));
  });
  await withEnv({ AQG_COPILOT_BIN: hang.bin, COPILOT_GITHUB_TOKEN: 'github_pat_test' }, async () => {
    await assert.rejects(makeProvider(cfg({ timeout_s: 1 })).complete('x'), /timed out after 1 s/);
  });
});

test('auto: without the CLI or without a token the gate runs with no model and says why', async () => {
  await withEnv({ AQG_COPILOT_BIN: path.join(tmp, 'not-installed'), COPILOT_GITHUB_TOKEN: 'github_pat_test' }, async () => {
    const p = makeProvider(cfg({ provider: 'auto' }));
    assert.deepEqual([p.name, p.available], ['none', false]);
    assert.match(p.note, /not installed/);
  });
  const fake = fakeCopilot('copilot-notoken', "console.log('ok');");
  await withEnv({ AQG_COPILOT_BIN: fake.bin, COPILOT_GITHUB_TOKEN: '' }, async () => {
    assert.match(makeProvider(cfg({ provider: 'auto' })).note, /COPILOT_GITHUB_TOKEN is not set/);
    // an answers file turns "auto" into the handoff provider
    const answers = path.join(tmp, 'answers.json');
    fs.writeFileSync(answers, '{}');
    assert.equal(makeProvider(cfg({ provider: 'auto' }), { answersFile: answers }).name, 'handoff');
  });
});
