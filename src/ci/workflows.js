'use strict';
// CI configuration → a flat list of steps, each with the facts that decide whether it gates a pull request:
// does its workflow run on pull requests, can its failure be ignored, what command does it really run.
// GitHub Actions is parsed in full (reusable workflows and local composite actions are followed). Other CI systems
// are read as text: their commands are found, their triggers are not, and the report says so.
const path = require('node:path');
const YAML = require('yaml');
const { readText } = require('../util');

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const PR_EVENTS = ['pull_request', 'pull_request_target', 'merge_group'];

function triggersOf(on) {
  const t = { pr: false, push: false, schedule: false, manual: false, call: false, paths: null, prBranches: null };
  const events = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [e, null])) : on && typeof on === 'object' ? on : {};
  for (const [ev, cfg] of Object.entries(events)) {
    if (PR_EVENTS.includes(ev)) {
      const types = asList(cfg?.types);
      // a workflow that only reacts to "closed" or "labeled" does not check the change
      if (types.length && !types.some((x) => ['opened', 'synchronize', 'reopened', 'ready_for_review', 'checks_requested'].includes(x))) continue;
      t.pr = true;
      if (cfg?.paths || cfg?.['paths-ignore']) t.paths = asList(cfg.paths || cfg['paths-ignore']).map(String);
      if (cfg?.branches) t.prBranches = asList(cfg.branches).map(String);
    } else if (ev === 'push') t.push = true;
    else if (ev === 'schedule') t.schedule = true;
    else if (ev === 'workflow_dispatch') t.manual = true;
    else if (ev === 'workflow_call') t.call = true;
  }
  return t;
}

const NOT_PR_IF = /github\.event_name\s*==\s*'(push|schedule|workflow_dispatch|release)'|github\.event_name\s*!=\s*'pull_request'|github\.ref\s*==\s*'refs\/(heads|tags)\/|startsWith\(\s*github\.ref\s*,\s*'refs\/tags|^\s*(\$\{\{\s*)?false(\s*\}\})?\s*$/;
const truthy = (v) => v === true || v === 'true';

function lineOf(text, needle) {
  if (!needle) return 1;
  const first = String(needle).split('\n').find((l) => l.trim()) || '';
  const idx = text.indexOf(first.trim());
  return idx < 0 ? 1 : text.slice(0, idx).split('\n').length;
}

/** Parse the repository's CI files. Returns {steps, workflows, systems, errors}. */
function parseCI({ root, inventory }) {
  const ciFiles = inventory.byKind.ci || [];
  const parsed = new Map(), errors = [], workflows = [];
  /** @type {any[]} */
  const steps = [];
  const systems = [...new Set(ciFiles.map((f) => f.system).filter((s) => s !== 'github-action'))].sort();

  for (const f of ciFiles) {
    const text = readText(path.join(root, f.path), 1 << 20);
    if (text === null) continue;
    if (f.system === 'github' || f.system === 'github-action') {
      try { parsed.set(f.path, { text, doc: YAML.parse(text, { merge: true }) || {} }); } catch (e) { errors.push(`${f.path}: ${e.message.split('\n')[0]}`); }
    } else {
      // text-only: every line that is not a comment is a possible command; the trigger is unknown
      const run = text.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
      steps.push({ file: f.path, system: f.system, job: '(all)', name: '', run, uses: '', line: 1, pr: null, nonBlocking: false, notPr: false, paths: null });
      workflows.push({ file: f.path, system: f.system, name: f.path, pr: null });
    }
  }

  const stepsOfAction = (file, depth) => {
    const a = parsed.get(file);
    return a && depth < 3 ? asList(a.doc?.runs?.steps).map((s) => ({ s, text: a.text, file })) : [];
  };
  const localAction = (uses) => {
    const dir = path.posix.normalize(String(uses).replace(/^\.\//, ''));
    return [`${dir}/action.yml`, `${dir}/action.yaml`].find((p) => parsed.has(p));
  };

  const addJobs = (file, trig, inherit, depth) => {
    const wf = parsed.get(file);
    if (!wf || depth > 3) return;
    for (const [jobId, job] of Object.entries(wf.doc.jobs || {})) {
      if (!job || typeof job !== 'object') continue;
      const jobSoft = truthy(job['continue-on-error']) || inherit.nonBlocking;
      const jobNotPr = (typeof job.if === 'string' || typeof job.if === 'boolean') && NOT_PR_IF.test(String(job.if)) || inherit.notPr;
      if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
        // a reusable workflow of this repository runs under the caller's triggers
        addJobs(path.posix.normalize(job.uses.replace(/^\.\//, '')), trig, { nonBlocking: jobSoft, notPr: jobNotPr, via: file }, depth + 1);
        continue;
      }
      const expand = (list, depthA) => {
        for (const { s, text, file: sf } of list) {
          if (!s || typeof s !== 'object') continue;
          const uses = typeof s.uses === 'string' ? s.uses : '';
          const local = uses.startsWith('./') && localAction(uses);
          if (local) { expand(stepsOfAction(local, depthA + 1), depthA + 1); continue; }
          const run = typeof s.run === 'string' ? s.run : '';
          steps.push({
            file: inherit.via || sf, definedIn: sf, system: 'github', job: jobId, name: String(s.name || ''), run, uses,
            with: s.with && typeof s.with === 'object' ? Object.entries(s.with).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
            line: lineOf(text, run || uses), pr: trig.pr, push: trig.push, schedule: trig.schedule, paths: trig.paths,
            nonBlocking: jobSoft || truthy(s['continue-on-error']),
            notPr: jobNotPr || (s.if != null && NOT_PR_IF.test(String(s.if))),
            cwd: s['working-directory'] || job.defaults?.run?.['working-directory'] || wf.doc.defaults?.run?.['working-directory'] || '',
          });
        }
      };
      expand(asList(job.steps).map((s) => ({ s, text: wf.text, file })), 0);
    }
  };

  for (const f of ciFiles.filter((x) => x.system === 'github')) {
    const wf = parsed.get(f.path);
    if (!wf) continue;
    const trig = triggersOf(wf.doc.on);
    workflows.push({ file: f.path, system: 'github', name: String(wf.doc.name || path.posix.basename(f.path)), pr: trig.pr, push: trig.push, schedule: trig.schedule, callOnly: trig.call && !trig.pr && !trig.push && !trig.schedule, paths: trig.paths });
    if (trig.call && !trig.pr && !trig.push && !trig.schedule && !trig.manual) continue; // reached through its callers
    addJobs(f.path, trig, { nonBlocking: false, notPr: false }, 0);
  }
  return { steps, workflows, systems, errors };
}

/** Scripts a CI command can call by name: package.json scripts and Makefile targets. */
function loadScripts({ root, inventory }) {
  const npm = new Map();    // script name → [{dir, body}]
  const make = new Map();   // target → body
  const manifests = (inventory.byKind.manifest || []).filter((m) => m.name === 'package.json').sort((a, b) => a.path.split('/').length - b.path.split('/').length).slice(0, 200);
  const deps = new Set();
  for (const m of manifests) {
    let pkg;
    try { pkg = JSON.parse(readText(path.join(root, m.path), 1 << 20) || '{}'); } catch { continue; }
    for (const d of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) deps.add(d);
    for (const [name, body] of Object.entries(pkg.scripts || {})) {
      if (typeof body !== 'string') continue;
      if (!npm.has(name)) npm.set(name, []);
      npm.get(name).push({ dir: path.posix.dirname(m.path) === '.' ? '' : path.posix.dirname(m.path), body });
    }
  }
  for (const m of (inventory.byKind.manifest || []).filter((x) => /^(Makefile|makefile|GNUmakefile|justfile)$/.test(x.name) && !x.path.includes('/'))) {
    const text = readText(path.join(root, m.path), 1 << 20) || '';
    let cur = null;
    for (const l of text.split('\n')) {
      const t = /^([A-Za-z0-9_.-]+)\s*:(?!=)(.*)$/.exec(l);
      if (t) { cur = t[1]; make.set(cur, t[2].trim().split(/\s+/).filter((d) => /^[A-Za-z0-9_.-]+$/.test(d)).map((d) => `make ${d}`).join('\n')); } else if (cur && /^(\t|\s{2,})\S/.test(l)) make.set(cur, `${make.get(cur)}\n${l.trim()}`);
      else if (l.trim() && !l.startsWith('#')) cur = null;
    }
  }
  // Shell scripts of the repository: a workflow that runs `tools/check.sh` runs what that script runs.
  const sh = new Map();
  for (const f of (inventory.files || []).filter((x) => /\.(sh|bash)$/.test(x.path)).slice(0, 80)) {
    const text = readText(path.join(root, f.path), 1 << 18);
    if (text) sh.set(f.path, text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
  }
  return { npm, make, deps, sh };
}

const NPM_CALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(?:run(?:-script)?\s+|run-many\s+|exec\s+)?([\w:.-]+)/g;
const TASK_RUNNER = /\b(?:turbo|nx|lerna|wireit)\s+(?:run(?:-many)?\s+)?(?:(?:-t|--targets?)[= ])?([\w:.,-]+(?:\s+[\w:.-]+)*)/g;
const SH_CALL = /(?:^|[\s;&|(=])(?:\.\/)?((?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash))\b/gm;
const MAKE_CALL = /\b(?:make|just)\s+((?:[A-Za-z0-9_.-]+\s*)+)/g;

/** A command with every script it calls spliced in (three levels deep): what the step really runs. */
function expandCommand(run, scripts, cwd = '', depth = 0, seen = new Set()) {
  if (!run || depth > 3) return run || '';
  let out = run;
  const addNpm = (name) => {
    if (['install', 'ci', 'i', 'add', 'run', 'exec', 'dlx', 'cache', 'config', 'publish', 'audit', 'workspaces', 'workspace'].includes(name)) return;
    const defs = scripts.npm.get(name);
    if (!defs || seen.has('npm:' + name)) return;
    seen.add('npm:' + name);
    const chosen = defs.filter((d) => d.dir === cwd.replace(/^\.\//, '').replace(/\/$/, ''));
    for (const d of (chosen.length ? chosen : defs).slice(0, 8)) out += '\n' + expandCommand(d.body, scripts, d.dir, depth + 1, seen);
    for (const hook of ['pre' + name, 'post' + name]) if (scripts.npm.has(hook)) addNpm(hook);
  };
  for (const m of run.matchAll(NPM_CALL)) addNpm(m[1]);
  for (const m of run.matchAll(TASK_RUNNER)) for (const t of m[1].split(/[\s,]+/)) addNpm(t);
  for (const m of run.matchAll(MAKE_CALL)) for (const t of m[1].trim().split(/\s+/)) {
    if (!scripts.make.has(t) || seen.has('make:' + t)) continue;
    seen.add('make:' + t);
    out += '\n' + expandCommand(scripts.make.get(t), scripts, cwd, depth + 1, seen);
  }
  for (const m of run.matchAll(SH_CALL)) {
    const dir = cwd.replace(/^\.\//, '').replace(/\/$/, '');
    const file = [dir ? `${dir}/${m[1]}` : null, m[1]].find((p) => p && scripts.sh?.has(p));
    if (!file || seen.has('sh:' + file)) continue;
    seen.add('sh:' + file);
    out += '\n' + expandCommand(scripts.sh.get(file), scripts, cwd, depth + 1, seen);
  }
  return out;
}

/**
 * Script-style tests: programs CI runs to check the product that use no test framework (`node tools/game_check.js`).
 * A file is one when a CI step runs it and its name says check, test, verify, smoke, probe or e2e.
 */
function scriptTests(steps, inventory) {
  const out = new Set();
  for (const s of steps) for (const m of (s.full || '').matchAll(/(?:^|[\s"'=(])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|py|rb))\b/gm)) {
    const p = m[1].replace(/^\.\//, '');
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!/(^|[_.-])(checks?|tests?|verify|smoke|probe|e2e)([_.-]|$)/i.test(base)) continue;
    const rec = inventory.byPath.get(p);
    if (rec && (rec.kind === 'source' || rec.kind === 'support')) out.add(p);
  }
  return out;
}

module.exports = { parseCI, loadScripts, expandCommand, scriptTests, triggersOf };
