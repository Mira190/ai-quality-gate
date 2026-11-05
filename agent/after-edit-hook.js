#!/usr/bin/env node
'use strict';
// Claude Code PostToolUse hook (Edit|Write|MultiEdit): after the agent edits a file, tell it which rules that file
// carries, their limits and the tests that guard them, so the test lands in the same change instead of in a CI failure.
// Reads the hook JSON on stdin; prints { hookSpecificOutput: { hookEventName, additionalContext } } or nothing.
// Ledger: AQG_LEDGER, else .quality-gate/ledger.json in the project. Any problem: exit 0 silently (never block an edit).
const fs = require('node:fs');
const path = require('node:path');
const q = require('../src/ledger-query');

let input = '';
process.stdin.on('data', (c) => { input += c; }).on('end', () => {
  try {
    const ev = JSON.parse(input);
    const file = ev.tool_input?.file_path;
    const cwd = ev.cwd || process.cwd();
    const ledgerPath = path.resolve(cwd, process.env.AQG_LEDGER || '.quality-gate/ledger.json');
    if (!file || !fs.existsSync(ledgerPath)) return;
    const text = q.contextFor(q.loadLedger(ledgerPath), path.relative(cwd, path.resolve(cwd, file)), '');
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
  } catch { /* never block the agent */ }
});
