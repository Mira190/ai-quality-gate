#!/usr/bin/env node
'use strict';
// MCP server (stdio, newline-delimited JSON-RPC 2.0, protocol 2025-06-18) over a ledger.json from the gate, so a coding
// agent can ask which rules a file carries, which tests guard them and what a change touches, while it writes code.
//   node agent/mcp-server.js --ledger path/to/ledger.json
// Register for a project (.mcp.json): { "mcpServers": { "quality-gate": { "command": "node",
//   "args": ["<path>/agent/mcp-server.js", "--ledger", ".quality-gate/ledger.json"] } } }
// Nothing but JSON-RPC goes to stdout; logs go to stderr.
const path = require('node:path');
const readline = require('node:readline');
const q = require('../src/ledger-query');

const i = process.argv.indexOf('--ledger');
const ledgerPath = path.resolve(i >= 0 ? process.argv[i + 1] : process.env.AQG_LEDGER || '.quality-gate/ledger.json');
let L = null;
const ledger = () => (L ||= q.loadLedger(ledgerPath));

const TOOLS = [
  { name: 'rules_for_file', description: 'Requirements and design decisions a file implements, states or tests, with their limits, linked tests, test level and open issues. Call before editing a file.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Repository-relative path' } }, required: ['path'] } },
  { name: 'rule', description: 'One rule by ID (REQ-07, DEC-03): text, source line, limits, implementation, tests, status and open issues.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'impact', description: 'Rules a set of changed files touches, and the test files to run for them.', inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } },
];

function call(name, args) {
  if (name === 'rules_for_file') return q.rulesForFile(ledger(), args.path);
  if (name === 'rule') return q.rule(ledger(), args.id) || { error: `no rule ${args.id}` };
  if (name === 'impact') return q.impact(ledger(), args.files || []);
  return undefined;
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  if (m.id === undefined) return; // notifications (notifications/initialized) need no answer
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ai-quality-gate', version: require('../package.json').version } } });
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const { name, arguments: args = {} } = m.params || {};
    if (!TOOLS.some((t) => t.name === name)) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
    try { return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(call(name, args), null, 1) }], isError: false } }); } catch (e) { return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ledger error: ${e.message}` }], isError: true } }); }
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
});
