'use strict';
// Change impact: what a pull request does to the rules, decided by code from the diff and the ledger's rule → code →
// test map. This is where a gate is most useful (Meta's Infer: the same analysis that nobody fixed overnight got a fix
// rate above 70% once it reported on the diff), and every check here is deterministic:
//
//   Unguarded change    the change edits the body of a rule's implementing function, and no test that meets the
//                       standard (linked, asserting, running on PR) guards that rule. The change ships unchecked.
//   Code drifts from spec  a changed line in the implementation or in a file the rule names replaces the rule's
//                       stated limit with another number (30 → 45) and the rule's document is not part of the change.
//   Spec drifts from code  the change rewrites a number in the rule's own line in its document, and the
//                       implementation still holds the old number and not the new one.
//
// Also: the rules the change touches and the tests that guard them (affected.json: what to run on this pull request).
const { readText, linesOf, numbersIn } = require('./util');
const { bodyAt } = require('./placement');
const { touchesRange } = require('./diff');

const lit = (v) => new RegExp(`(?<![\\w.])${String(v).replace('.', '\\.')}(?![\\w.])`);

function implRange(root, r) {
  if (!r.impl) return null;
  const lines = linesOf(readText(root, r.impl.path) || '');
  const body = bodyAt(lines, r.impl.line, r.impl.path);
  return body ? [r.impl.line, r.impl.line + linesOf(body).length - 1] : null;
}

// pairs of (removed, added) lines in one hunk, by position: the usual shape of an edited line
const pairs = (h) => h.removed.map((r, k) => [r, h.added[k]]).filter(([, a]) => a);

function analyzeImpact(rules, diff, { root, testIndex }) {
  const findings = [], affected = [];
  if (!diff || !diff.size) return { findings, affected };
  const named = (r) => [...`${r.title} ${r.text}`.matchAll(/`([^`\s]+\.[a-z0-9]+)`/gi)].map((m) => m[1].replace(/^\.\//, ''));
  for (const r of rules) {
    const range = implRange(root, r);
    const implChanged = range && touchesRange(diff.get(r.impl.path), range[0], range[1]);
    const docFile = diff.get(r.path);
    const docChanged = !!docFile && docFile.hunks.some((h) => h.added.some((a) => a.line === r.line));
    const files = [...new Set([r.impl?.path, ...named(r)].filter(Boolean))];
    if (implChanged || docChanged || files.some((f) => diff.has(f))) {
      const tests = (r.links || []).map((l) => l.path);
      affected.push({ rule: r.id, title: r.title, critical: !!r.critical, implChanged: !!implChanged, docChanged, tests, level: r.evidence?.level || null });
    }
    const pri = (hi) => (r.critical ? hi : 'P2');
    if (implChanged && r.evidence && r.evidence.level !== 'Meets') {
      const changed = diff.get(r.impl.path).hunks.flatMap((h) => h.added).filter((a) => a.line >= range[0] && a.line <= range[1]).map((a) => a.line);
      findings.push({ section: 6, rule: r, check: 'Unguarded change', priority: pri('P1'), basis: r.links?.length && r.links.every((l) => l.source === 'tag') ? 'S' : 'V',
        facts: { path: r.impl.path, line: changed[0] || r.impl.line, symbol: r.impl.symbol, changedLines: changed, level: r.evidence.level, tests: (r.links || []).map((l) => l.path) } });
    }
    // code drifts from the spec: the rule's limit replaced in a changed line, the document untouched
    if (!docFile && r.limits?.length) {
      for (const f of files) {
        const fd = diff.get(f);
        if (!fd) continue;
        for (const h of fd.hunks) for (const [rem, add] of pairs(h)) {
          for (const l of r.limits) {
            if (!lit(l.value).test(rem.text) || lit(l.value).test(add.text)) continue;
            const before = [...numbersIn(rem.text)], after = [...numbersIn(add.text)];
            const to = after.find((x) => !before.includes(x));
            if (to === undefined) continue;
            findings.push({ section: 6, rule: r, check: 'Code drifts from spec', priority: pri('P1'), basis: named(r).includes(f) ? 'S' : 'V',
              facts: { path: f, line: add.line, from: l.value, to, unit: l.unit || '', said: `${r.path}:${r.line}`, removed: rem.text.trim(), added: add.text.trim() } });
          }
        }
      }
    }
    // the spec drifts from the code: the rule's line now says a new number, the implementation still holds the old one
    if (docChanged) {
      for (const h of docFile.hunks) for (const [rem, add] of pairs(h)) {
        if (add.line !== r.line) continue;
        const oldN = [...numbersIn(rem.text)].filter((x) => !numbersIn(add.text).has(x));
        const newN = [...numbersIn(add.text)].filter((x) => !numbersIn(rem.text).has(x));
        if (!oldN.length || !newN.length) continue;
        for (const f of files) {
          const text = readText(root, f) || '', fl = linesOf(text);
          // in the implementation file: the function body and the constants it uses (`DAYS * 86400000`)
          let scope = fl.map((_, k) => k + 1);
          if (range && f === r.impl?.path) {
            const body = fl.slice(range[0] - 1, range[1]).join('\n');
            const consts = [...new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]))];
            scope = fl.map((x, k) => k + 1).filter((n) => (n >= range[0] && n <= range[1]) || consts.some((c) => new RegExp(`\\b${c}\\b\\s*(?::[^=]+)?=`).test(fl[n - 1])));
          }
          const where = scope.map((n) => fl[n - 1]).join('\n');
          const stale = oldN.find((v) => lit(v).test(where));
          if (stale === undefined || newN.some((v) => lit(v).test(where))) continue;
          const at = scope.find((n) => lit(stale).test(fl[n - 1]));
          findings.push({ section: 6, rule: r, check: 'Spec drifts from code', priority: pri('P1'), basis: named(r).includes(f) ? 'S' : 'V',
            facts: { path: f, line: at, from: stale, to: newN[0], said: `${r.path}:${r.line}` } });
          break;
        }
      }
    }
  }
  return { findings, affected, testsToRun: [...new Set(affected.flatMap((a) => a.tests))].filter((t) => testIndex.tests.some((x) => x.path === t)).sort() };
}

/** Rules whose implementing function the diff edits (for mutation scoped to the change). */
const implChanged = (r, diff, root) => { const range = implRange(root, r); return !!(range && diff && touchesRange(diff.get(r.impl.path), range[0], range[1])); };

// One plain sentence per finding, for the comment, SARIF and the details file.
function impactText(f) {
  const x = f.facts;
  if (f.check === 'Unguarded change') return `\`${x.path}:${x.line}\` changes \`${x.symbol}\`, which implements ${f.rule.id}, and no test that meets the standard guards it (level: ${x.level}${x.tests.length ? `; linked: ${x.tests.map((t) => `\`${t}\``).join(', ')}` : '; no linked test'}). Add or fix the test in this change`;
  if (f.check === 'Code drifts from spec') return `\`${x.path}:${x.line}\` changes ${x.from} to ${x.to}${x.unit ? ` ${x.unit}` : ''}, but ${f.rule.id} (\`${x.said}\`) still says ${x.from}. Change the document in this pull request, or keep ${x.from}`;
  return `${f.rule.id} (\`${x.said}\`) now says ${x.to}, but \`${x.path}:${x.line}\` still uses ${x.from}. Change the code in this pull request, or revert the document`;
}

module.exports = { analyzeImpact, implChanged, impactText };
