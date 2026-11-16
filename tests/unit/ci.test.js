'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { triggersOf, expandCommand } = require('../../src/ci/workflows');

test('GATE-13 only a trigger that runs on the change counts as a pull-request trigger', () => {
  assert.equal(triggersOf('pull_request').pr, true);
  assert.equal(triggersOf(['push', 'pull_request']).pr, true);
  assert.equal(triggersOf({ push: { branches: ['main'] }, schedule: [{ cron: '0 3 * * *' }] }).pr, false);
  assert.equal(triggersOf({ pull_request: { types: ['closed'] } }).pr, false);
  assert.equal(triggersOf({ merge_group: null }).pr, true);
  assert.deepEqual(triggersOf({ pull_request: { paths: ['src/**'] } }).paths, ['src/**']);
});

test('GATE-14 a package script or a make target is replaced by what it runs', () => {
  const scripts = {
    npm: new Map([['lint', [{ dir: '', body: 'eslint . && npm run lint:types' }]], ['lint:types', [{ dir: '', body: 'tsc --noEmit' }]], ['test', [{ dir: '', body: 'jest tests/unit' }]], ['pretest', [{ dir: '', body: 'prettier --check .' }]]]),
    make: new Map([['check', 'make lint\npytest -q'], ['lint', 'ruff check .']]),
  };
  assert.match(expandCommand('npm run lint', scripts), /eslint \.[\s\S]*tsc --noEmit/);
  assert.match(expandCommand('pnpm test', scripts), /jest tests\/unit[\s\S]*prettier --check/);
  assert.match(expandCommand('make check', scripts), /pytest -q[\s\S]*ruff check/);
  assert.match(expandCommand('turbo run lint test', scripts), /eslint[\s\S]*jest/);
  assert.equal(expandCommand('npm ci', scripts), 'npm ci');
  // a script that calls itself does not loop
  const loop = { npm: new Map([['a', [{ dir: '', body: 'npm run a' }]]]), make: new Map() };
  assert.equal(expandCommand('npm run a', loop), 'npm run a\nnpm run a');
});
