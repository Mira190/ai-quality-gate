'use strict';
// The model behind the gate, behind one small interface: complete(prompt) → text.
//
//   copilot   GitHub Copilot CLI in programmatic mode, authenticated by a fine-grained personal access token with the
//             "Copilot Requests" permission (COPILOT_GITHUB_TOKEN). This is the production provider.
//   command   any program that reads the prompt on stdin and writes the answer on stdout.
//   handoff   no model in the loop: prompts the run could not answer are written to ai-requests.json, and answers are
//             read from ai-answers.json. Whoever stands in for the model (a person, a coding agent, a recorded
//             cassette in a test) fills that file; the next run picks the answers up. Runs are deterministic.
//   none      code-decided findings only.
//
// The model gets no tools and no repository: it runs in an empty directory, with a minimal environment, sees only
// the excerpts in the prompt, and its answer is data that code checks before anything is believed.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sha, readJson, writeAtomic } = require('../util');

class Pending extends Error {
  constructor(id) { super('awaiting an answer (handoff)'); this.pending = true; this.id = id; }
}

const PASS_ENV = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'COPILOT_GITHUB_TOKEN', 'COPILOT_HOME', 'COPILOT_MODEL', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA'];
const cleanEnv = (extra = {}) => Object.fromEntries([...PASS_ENV.map((k) => [k, process.env[k]]), ...Object.entries(extra)].filter(([, v]) => v !== undefined));
const redact = (s) => String(s).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '$1***');

function run(cmd, args, { input = '', timeoutMs, cwd, env, shell = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    child.on('error', (e) => finish(reject, new Error(/** @type {any} */ (e).code === 'ENOENT' ? `${cmd}: not installed` : e.message)));
    child.on('close', (code) => (code === 0 ? finish(resolve, out) : finish(reject, new Error(`exit ${code}: ${redact((err || out).trim().split('\n').slice(-2).join(' ')).slice(0, 300)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

function copilotProvider(config) {
  const bin = process.env.AQG_COPILOT_BIN || 'copilot';
  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.AQG_COPILOT_TOKEN;
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (probe.error || probe.status !== 0) return { name: 'copilot', available: false, note: 'the Copilot CLI is not installed (npm install -g @github/copilot)' };
  if (!token) return { name: 'copilot', available: false, note: 'COPILOT_GITHUB_TOKEN is not set (a fine-grained token with the "Copilot Requests" permission)' };
  const model = config.ai.model || '';
  // No --allow-* flag: in programmatic mode every tool call that needs approval is denied. The explicit denials say
  // the same thing twice, on purpose.
  const strict = ['-s', '--no-ask-user', '--no-auto-update', '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url'];
  let flags = [...strict, ...(model ? [`--model=${model}`] : []), ...config.ai.copilot_args];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-model-'));
  const env = cleanEnv({ COPILOT_GITHUB_TOKEN: token, NO_COLOR: '1', CI: '1' });
  return {
    name: 'copilot', available: true, model: model || 'copilot default', version: probe.stdout.trim().split('\n')[0],
    async complete(prompt) {
      try {
        return await run(bin, ['-p', prompt, ...flags], { timeoutMs: config.ai.timeout_s * 1000, cwd, env });
      } catch (e) {
        // an older or newer CLI that does not know one of the flags: fall back to the two that define the mode
        if (!/unknown option|unknown argument|unrecognized|invalid option/i.test(e.message) || flags.length <= 1) throw e;
        flags = ['-s', ...(model ? [`--model=${model}`] : [])];
        return run(bin, ['-p', prompt, ...flags], { timeoutMs: config.ai.timeout_s * 1000, cwd, env });
      }
    },
  };
}

function commandProvider(config) {
  const command = config.ai.command || process.env.AQG_AI_COMMAND;
  if (!command) return { name: 'command', available: false, note: 'ai.command is empty' };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-model-'));
  return {
    name: 'command', available: true, model: config.ai.model || command.split(/\s+/)[0],
    complete: (prompt) => run(command, [], { input: prompt, timeoutMs: config.ai.timeout_s * 1000, cwd, env: { ...process.env }, shell: true }),
  };
}

function handoffProvider(config, /** @type {any} */ { answersFile, requestsFile } = {}) {
  const answers = (answersFile && readJson(answersFile)) || {};
  const pending = new Map();
  return {
    name: 'handoff', available: true, model: config.ai.model || answers._model || 'stand-in', deterministic: true, pending,
    async complete(prompt) {
      const id = sha(prompt, 12);
      const a = answers[id];
      if (a === undefined) { pending.set(id, prompt); throw new Pending(id); }
      return typeof a === 'string' ? a : JSON.stringify(a);
    },
    flush() {
      if (!requestsFile) return;
      if (pending.size) writeAtomic(requestsFile, JSON.stringify([...pending].map(([id, prompt]) => ({ id, prompt })), null, 2) + '\n');
      else if (fs.existsSync(requestsFile)) fs.rmSync(requestsFile);
    },
  };
}

/** Pick the provider. "auto": Copilot when it can run, else handoff when an answers file exists, else none. */
function makeProvider(config, /** @type {any} */ files = {}) {
  const want = config.ai.provider;
  const none = (note) => ({ name: 'none', available: false, note });
  if (want === 'none') return none('switched off (ai.provider: none)');
  if (want === 'handoff') return handoffProvider(config, files);
  if (want === 'command') { const p = commandProvider(config); return p.available ? p : none(p.note); }
  const copilot = copilotProvider(config);
  if (copilot.available) return copilot;
  if (want === 'copilot') return none(copilot.note);
  if (config.ai.command || process.env.AQG_AI_COMMAND) return commandProvider(config);
  if (files.answersFile && fs.existsSync(files.answersFile)) return handoffProvider(config, files);
  return none(`no model available: ${copilot.note}`);
}

module.exports = { makeProvider, Pending, handoffProvider, redact };
