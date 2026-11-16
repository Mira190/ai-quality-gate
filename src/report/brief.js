'use strict';
// fix-brief.md: the blocking findings as a work list, written to be handed to a coding agent (or a person) as is.
// The gate finds; this turns what it found into the next action, with the test already sketched: its name carries the
// rule ID (so the link is a fact once it exists), its level is the one the rule needs, and its cases are the
// boundary values the rule states. Rendered by code from the ledger; no model writes it.
const path = require('node:path');
const { clip, groupBy } = require('../util');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

function boundaryRows(limits) {
  const rows = [];
  for (const l of limits.slice(0, 2)) {
    const n = Number(l.value);
    if (!Number.isFinite(n)) continue;
    const step = l.value.includes('.') ? Number((10 ** -l.value.split('.')[1].length).toFixed(6)) : 1;
    rows.push([+(n - step).toFixed(6), `below the limit (${l.raw})`], [n, `the limit (${l.raw})`], [+(n + step).toFixed(6), `above the limit (${l.raw})`]);
  }
  return rows;
}

/** A test to fill in, in the language of the repository's tests. The name and the cases are decided; the body is not. */
function skeleton(rule, lang) {
  const title = `${rule.id} ${rule.title}`.replace(/'/g, "\\'");
  const rows = boundaryRows(rule.limits);
  if (lang === 'python') {
    const name = `test_${slug(`${rule.id} ${rule.title}`)}`;
    return rows.length
      ? `import pytest\n\n# covers: ${rule.id}\n@pytest.mark.parametrize("value, expected", [\n${rows.map(([v, why]) => `    (${v}, ...),  # ${why}`).join('\n')}\n])\ndef ${name}(value, expected):\n    assert ... == expected`
      : `# covers: ${rule.id}\ndef ${name}():\n    # arrange the situation the rule describes, act, then:\n    assert ...  # fails when the rule is broken`;
  }
  if (lang === 'go') {
    const name = `Test${rule.id.replace(/[^A-Za-z0-9]/g, '')}`;
    return `// covers: ${rule.id}\nfunc ${name}(t *testing.T) {\n${rows.length ? `\tcases := []struct{ name string; value float64 }{\n${rows.map(([v, why]) => `\t\t{"${why}", ${v}},`).join('\n')}\n\t}\n\tfor _, c := range cases {\n\t\tt.Run(c.name, func(t *testing.T) { /* assert the outcome for c.value */ })\n\t}` : '\t// arrange, act, then t.Fatalf when the rule is broken'}\n}`;
  }
  if (lang === 'java') {
    return `// covers: ${rule.id}\n${rows.length ? `@ParameterizedTest\n@ValueSource(doubles = {${rows.map(([v]) => v).join(', ')}})\nvoid ${slug(rule.title).replace(/_(\w)/g, (_, c) => c.toUpperCase())}(double value) {` : `@Test\n@DisplayName("${rule.id} ${rule.title}")\nvoid ${slug(rule.title).replace(/_(\w)/g, (_, c) => c.toUpperCase())}() {`}\n    // assert the outcome the rule promises\n}`;
  }
  if (lang !== 'js') return `// covers: ${rule.id}\n// one test named "${rule.id} ${rule.title}"${rows.length ? `, with cases ${rows.map(([v]) => v).join(', ')}` : ''}`;
  return rows.length
    ? `it.each([\n${rows.map(([v, why]) => `  [${v}, /* expected */],  // ${why}`).join('\n')}\n])('${title}: %s', (value, expected) => {\n  expect(/* call the code with value */).toBe(expected);\n});`
    : `it('${title}', () => {\n  // arrange the situation the rule describes, act, then:\n  expect(/* outcome */).toBe(/* what the rule promises */);  // fails when the rule is broken\n});`;
}

function whereToPut(p, tests, level) {
  const near = p.candidates[0]?.case.file || p.links[0]?.case.file;
  if (near && near.level === level) return `add to \`${near.path}\``;
  const peer = tests.files.find((f) => f.level === level && (!p.rule.pkg || f.pkg === p.rule.pkg)) || tests.files.find((f) => f.level === level);
  return peer ? `a new file next to \`${peer.path}\` (\`${path.posix.dirname(peer.path)}/\`)` : `a new ${level} test file`;
}

function renderBrief(ledger, { max = 15 } = {}) {
  const blocking = ledger.findings.filter((f) => f.blocking);
  const lang = [...groupBy(ledger.tests?.files || [], (f) => f.lang)].sort((a, b) => b[1].length - a[1].length)[0]?.[0] || 'js';
  const byRule = new Map(ledger.proofs.map((p) => [p.rule.id, p]));
  const out = ['# Fix brief', `${blocking.length ? `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} in ${ledger.run.name}${ledger.run.sha ? ` @ ${ledger.run.sha}` : ''}, most severe first.` : 'Nothing blocks.'} Each task names the evidence, the change to make, and how the gate will know it is done.`];
  blocking.slice(0, max).forEach((f, i) => {
    const p = byRule.get(f.subject);
    const lines = [`## ${i + 1}. ${f.priority} ${f.title}`, `- **Evidence:** ${f.detail}`, `- **Do:** ${f.fix}`];
    if (p && ['proof.unproven', 'proof.limit', 'proof.skipped', 'proof.no-assert', 'placement.too-high', 'placement.boundary-mocked'].includes(f.check)) {
      const level = f.check === 'placement.boundary-mocked' || f.check === 'placement.too-high' ? p.placement?.expected || p.rule.lowest : p.modelLevel || p.rule.lowest;
      lines.push(`- **Where:** ${whereToPut(p, ledger.tests || { files: [] }, level)} (${level} level)`, `- **Rule:** "${clip(p.rule.text, 200)}" (\`${p.rule.path}:${p.rule.line}\`)`);
      if (f.check !== 'proof.skipped') lines.push('', `\`\`\`${{ js: 'ts', python: 'python', go: 'go', java: 'java' }[lang] || ''}`, skeleton(p.rule, lang), '```');
    }
    lines.push(`- **Done when:** \`${f.check}\` for \`${f.subject}\` is gone from the next report.`);
    out.push(lines.join('\n'));
  });
  if (blocking.length > max) out.push(`…and ${blocking.length - max} more blocking findings in \`findings.json\`.`);
  return out.join('\n\n') + '\n';
}

module.exports = { renderBrief, skeleton, boundaryRows };
