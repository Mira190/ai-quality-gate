'use strict';
// .quality-gate.yml: the repository's own settings for the gate. Everything is optional; unknown keys are an error
// (a typo in a gate config must not silently weaken the gate).
//
//   version: 1
//   gate:
//     fail_on: P1            # P0 | P1 | P2 | P3 | never
//     basis: [E, S, V]       # evidence that may block (E executed, S code, V model + code check, M model)
//     new_only: true         # only findings missing from the baseline block
//     min_agreement:         # vote agreement a V/M finding needs to block (scripts/calibrate.js prints these)
//       default: 0.67
//       Asserts the rule: 1
//     probation: [Placement] # checks that inform but never block (scripts/usefulness.js suggests these)
//   documents: { include: [globs], exclude: [globs], budget_kb: 60 }
//   critical:                # extra strong words per area (added to the built-in lists)
//     money: [premium]
//     access control: [tenant]
//   execute:                 # opt-in mutation probe; runs this repository's own tests
//     test_command: "npx vitest run {files}"
//     timeout_s: 120
//     max_mutants: 60
//   model: { name: claude-haiku-5-5, votes: 3, max_usd: 2 }
//   suppress:
//     - fingerprint: 3f2a…    # or rule: REQ-07 + check: Placement
//       reason: "Covered by the contract test suite in another repository"
//       until: 2027-03-31
//       by: alice
const fs = require('node:fs');
const YAML = require('yaml');

const SHAPE = {
  version: 'number',
  gate: { fail_on: 'string', basis: 'array', new_only: 'boolean', min_agreement: 'object', probation: 'array' },
  documents: { include: 'array', exclude: 'array', budget_kb: 'number' },
  critical: 'object',
  execute: { test_command: 'string', timeout_s: 'number', max_mutants: 'number' },
  model: { name: 'string', votes: 'number', max_usd: 'number' },
  suppress: 'array',
};

function validate(o, shape, at, errs) {
  for (const [k, v] of Object.entries(o || {})) {
    const want = shape[k];
    if (!want) { errs.push(`${at}${k}: unknown key`); continue; }
    if (typeof want === 'object') { if (typeof v !== 'object' || Array.isArray(v)) errs.push(`${at}${k}: must be a mapping`); else validate(v, want, `${at}${k}.`, errs); continue; }
    const ok = want === 'array' ? Array.isArray(v) : want === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === want;
    if (!ok) errs.push(`${at}${k}: must be ${want === 'array' ? 'a list' : `a ${want}`}`);
  }
}

function loadConfig(file) {
  if (!file || !fs.existsSync(file)) return { config: {}, errors: [] };
  let config;
  try { config = YAML.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return { config: {}, errors: [`${file}: ${e.message}`] }; }
  const errors = [];
  validate(config, SHAPE, '', errors);
  const fo = config.gate?.fail_on;
  if (fo && !/^(P[0-3]|never)$/.test(fo)) errors.push('gate.fail_on: must be P0, P1, P2, P3 or never');
  for (const b of config.gate?.basis || []) if (!['E', 'S', 'V', 'M'].includes(b)) errors.push(`gate.basis: unknown evidence "${b}"`);
  for (const [k, v] of Object.entries(config.gate?.min_agreement || {})) if (typeof v !== 'number' || v < 0 || v > 1) errors.push(`gate.min_agreement.${k}: must be a number from 0 to 1`);
  return { config, errors };
}

/** Gate policy from the config, with CLI overrides. */
const policyOf = (config, o = {}) => ({
  failOn: o.failOn || config.gate?.fail_on || 'P1',
  basis: o.basis || config.gate?.basis || ['E', 'S', 'V'],
  newOnly: o.newOnly ?? config.gate?.new_only ?? true,
  minAgreement: config.gate?.min_agreement || {},
  probation: config.gate?.probation || [],
});

module.exports = { loadConfig, policyOf };
