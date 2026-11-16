'use strict';
// .quality-gate.yml: defaults, loading, validation. An invalid config is reported and the defaults are used for the
// invalid keys; a typo must never switch the gate off silently, and never crash it either.
const fs = require('node:fs');
const YAML = require('yaml');

const DEFAULTS = {
  exclude: [],                      // globs never looked at
  docs: {
    include: [],                    // globs always read as rule documents
    exclude: [],
    max_kb: 2048,                   // a larger document is listed as not read
    max_files: 300,                 // the highest-scoring documents are read first
  },
  rules: {
    id_prefixes: [],                // extra ID prefixes, e.g. ["PAY", "SEC"]
    decision_prefixes: [],          // which of them are design decisions
    infer: true,                    // rules without an ID: normative sentences in requirement and design documents
    max: 3000,
  },
  risk: {
    critical_ids: [],               // rule IDs that are critical whatever their text says
    extra_terms: {},                // area → extra words, e.g. { money: ["premium"] }
  },
  tests: {
    include: [],                    // globs that are test files whatever their name
    levels: {},                     // level → globs, overrides detection: { e2e: ["apps/web/journeys/**"] }
    max_kb: 2048,
  },
  trace: {
    candidates: 4,                  // nearest tests shown to the model per rule
    min_overlap: 0.34,              // share of a rule's distinctive words a test must contain to be a candidate
    excerpt_lines: 30,
  },
  ci: {
    required: ['tests', 'lint', 'typecheck', 'specs'],   // a gap in one is P0 (tests) or P1; specs: formal models, when the repository has them
    ignore: [],                     // checks this repository chooses not to run, e.g. ["sast"]
  },
  ai: {
    provider: 'auto',               // auto | copilot | command | handoff | none
    model: '',                      // empty: the provider's default
    command: '',                    // provider "command": reads the prompt on stdin, writes the answer on stdout
    copilot_args: [],               // extra arguments for the Copilot CLI
    max_requests: 12,               // model calls per run
    max_rules: 60,                  // rules judged per run, most severe first
    batch: 6,                       // rules per call
    timeout_s: 180,
    retries: 1,
    concurrency: 2,
    scope: 'critical',              // critical | all: which unlinked rules the model is asked about
    confirm: true,                  // a "no proof" the word search does not back is read twice before it may block
    deadline_s: 600,                // no model call starts after this many seconds
    lock: '.quality-gate.lock.json',// verdicts committed to the repository: asked once, a fact from then on
  },
  execute: {
    enabled: false,                 // run rule-targeted mutants: moves a rule's limit in the code and runs its linked tests
    test_command: '',               // runs the given test files; {files} is replaced by them, e.g. "npx vitest run {files}"
    scope: 'critical',              // critical | all
    max_mutants: 12,                // test runs per review; results are cached until rule, code or tests change
    timeout_s: 120,
  },
  gate: {
    fail_on: 'P1',                  // P0 | P1 | P2 | P3 | never
    basis: ['E', 'S', 'V'],         // evidence that may block: E executed, S code-decided, V model-proposed and code-verified
    probation: { min_resolved: 10, max_dismissed: 0.2 },   // a check whose findings people mostly dismiss stops blocking
    new_only: false,                // true: a ratchet. Only findings missing from the default-branch baseline block
  },
  report: {
    max_rows: 25,                   // rows per table; the rest is counted, and kept in findings.json
  },
  suppress: [],                     // [{ id | check | path, reason, until: YYYY-MM-DD }]
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over, at, errors) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    const where = at ? `${at}.${k}` : k;
    if (!(k in base)) { errors.push(`${where}: unknown key`); continue; }
    const b = base[k];
    if (isObj(b) && Object.keys(b).length) {
      if (!isObj(v)) { errors.push(`${where}: must be a mapping`); continue; }
      out[k] = merge(b, v, where, errors);
    } else if (isObj(b)) {
      if (!isObj(v)) errors.push(`${where}: must be a mapping`); else out[k] = v;
    } else if (Array.isArray(b)) {
      if (!Array.isArray(v)) errors.push(`${where}: must be a list`); else out[k] = v;
    } else if (typeof b !== typeof v) errors.push(`${where}: must be a ${typeof b}`);
    else out[k] = v;
  }
  return out;
}

function validate(c, errors) {
  if (!/^(P[0-3]|never)$/.test(c.gate.fail_on)) { errors.push('gate.fail_on: must be P0, P1, P2, P3 or never'); c.gate.fail_on = DEFAULTS.gate.fail_on; }
  const basis = c.gate.basis.filter((b) => ['E', 'S', 'V', 'A'].includes(b));
  if (basis.length !== c.gate.basis.length) errors.push('gate.basis: the evidence levels are E, S, V and A');
  c.gate.basis = basis.length ? basis : DEFAULTS.gate.basis;
  if (!['auto', 'copilot', 'command', 'handoff', 'none'].includes(c.ai.provider)) { errors.push('ai.provider: must be auto, copilot, command, handoff or none'); c.ai.provider = 'auto'; }
  if (!['critical', 'all'].includes(c.execute.scope)) { errors.push('execute.scope: must be critical or all'); c.execute.scope = 'critical'; }
  if (!['critical', 'all'].includes(c.ai.scope)) { errors.push('ai.scope: must be critical or all'); c.ai.scope = 'critical'; }
  const today = new Date().toISOString().slice(0, 10);
  c.suppress = c.suppress.filter((s, i) => {
    if (!isObj(s) || !(s.id || s.check || s.path)) { errors.push(`suppress[${i}]: needs id, check or path`); return false; }
    if (!s.reason) { errors.push(`suppress[${i}]: needs a reason`); return false; }
    if (s.until && String(s.until).slice(0, 10) < today) { errors.push(`suppress[${i}]: expired on ${String(s.until).slice(0, 10)}, no longer applied`); return false; }
    return true;
  });
  return c;
}

function loadConfig(file, overrides = {}) {
  const errors = [];
  let raw = {};
  if (file && fs.existsSync(file)) {
    try { raw = YAML.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { errors.push(`${file}: ${e.message.split('\n')[0]}`); }
    if (!isObj(raw)) { errors.push(`${file}: must be a mapping`); raw = {}; }
  }
  let config = merge(DEFAULTS, raw, '', errors);
  config = merge(config, overrides, '', errors);
  return { config: validate(config, errors), errors };
}

module.exports = { loadConfig, DEFAULTS };
