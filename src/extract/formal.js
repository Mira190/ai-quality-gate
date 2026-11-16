'use strict';
// Formal models as a source of design decisions. A TLA+ module with a configuration states, by name, the properties
// the design must keep (`INVARIANTS StoredBeforeAck`), and the comment above each definition says it in words
// ("an acknowledged event is on disk"). Those are design decisions in the most exact form a repository can hold.
//
// What proves one is the model checker, not a test: so the question the gate asks of them is whether the checker
// runs where it can stop a change. When CI runs it on pull requests they are proven; when it is run by hand, every
// one of them is as good as the last time someone remembered, and that is one finding (ci.specs), not one per property.
const path = require('node:path');
const { readText, clip } = require('../util');
const { tagRule } = require('./risk');

function parseCfg(text) {
  const names = [];
  let on = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\\\*.*$/, '').trim();
    if (!l) continue;
    const head = /^(INVARIANTS?|PROPERTY|PROPERTIES)\b\s*(.*)$/.exec(l);
    if (head) { on = true; for (const n of head[2].split(/\s+/).filter(Boolean)) names.push(n); continue; }
    if (/^[A-Z_]{4,}\b/.test(l)) { on = false; continue; }
    if (on) for (const n of l.split(/\s+/)) if (/^[A-Za-z_]\w*$/.test(n)) names.push(n);
  }
  return [...new Set(names)];
}

/** Rules from the repository's TLA+ models: one per invariant or property a configuration names. */
function extractFormal({ root, inventory, config }) {
  const specs = (inventory.byKind.spec || []).filter((f) => f.path.endsWith('.tla'));
  const rules = [], models = [];
  for (const f of specs) {
    const text = readText(path.join(root, f.path), 1 << 20);
    if (text === null) continue;
    const dir = path.posix.dirname(f.path), module = path.posix.basename(f.path, '.tla');
    const cfgs = (inventory.byKind.spec || []).filter((c) => c.path.endsWith('.cfg') && path.posix.dirname(c.path) === dir && path.posix.basename(c.path).split('.')[0] === module);
    const names = new Set();
    for (const c of cfgs) for (const n of parseCfg(readText(path.join(root, c.path), 1 << 18) || '')) names.add(n);
    const lines = text.split(/\r?\n/);
    let count = 0;
    for (const name of [...names].sort()) {
      if (/^Type(OK|Invariant)$/i.test(name)) continue;   // the shape of the state, not a decision about behaviour
      const at = lines.findIndex((l) => new RegExp(`^${name}\\s*==`).test(l));
      if (at < 0) continue;
      const comment = [];
      for (let j = at - 1; j >= 0 && /^\s*\\\*/.test(lines[j]); j--) comment.unshift(lines[j].replace(/^\s*\\\*\s?/, ''));
      const said = comment.join(' ').replace(/\s+/g, ' ').trim();
      const rule = { id: `${module}.${name}`, kind: 'decision', formal: true, model: f.path, title: clip(said ? `${name}: ${said.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, '')}` : name, 90), text: clip(said || name, 600), path: f.path, line: at + 1, inferred: false, active: true, pkg: f.pkg, section: `TLA+ model ${module}` };
      // a property someone took the trouble to model-check is critical by that fact
      tagRule(rule, config);
      if (!rule.critical) { rule.critical = true; rule.tags = [{ area: 'invariant', word: 'model-checked' }]; }
      rules.push(rule);
      count++;
    }
    models.push({ path: f.path, module, properties: count, configs: cfgs.length });
  }
  return { rules, models };
}

module.exports = { extractFormal, parseCfg };
