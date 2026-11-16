'use strict';
// Findings as SARIF 2.1.0 (GitHub code scanning) and as workflow annotations.
const LEVEL = { P0: 'error', P1: 'error', P2: 'warning', P3: 'note' };

function toSarif(ledger) {
  const rules = new Map();
  const results = [];
  for (const f of ledger.findings) {
    if (f.suppressed) continue;
    if (!rules.has(f.check)) rules.set(f.check, { id: f.check, shortDescription: { text: f.check }, defaultConfiguration: { level: LEVEL[f.priority] } });
    results.push({
      ruleId: f.check, level: f.blocking ? 'error' : LEVEL[f.priority] === 'error' ? 'warning' : LEVEL[f.priority],
      message: { text: `${f.priority} ${f.title}. ${f.detail} Fix: ${f.fix}` },
      partialFingerprints: { aqg: f.fingerprint },
      locations: f.loc ? [{ physicalLocation: { artifactLocation: { uri: f.loc.path }, region: { startLine: Math.max(1, f.loc.line || 1) } } }] : [],
      properties: { priority: f.priority, evidence: f.basis, blocking: f.blocking },
    });
  }
  return { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{ tool: { driver: { name: 'ai-quality-gate', informationUri: 'https://github.com/Mira190/ai-quality-gate', rules: [...rules.values()] } }, results }] };
}

const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** GitHub workflow commands: blocking findings as errors on the line, at most `max` (GitHub shows ten per step). */
function annotations(ledger, max = 10) {
  return ledger.findings.filter((f) => f.blocking).slice(0, max).map((f) => `::error ${f.loc ? `file=${escProp(f.loc.path)},line=${Math.max(1, f.loc.line || 1)},` : ''}title=${escProp(`${f.priority} ${f.check}`)}::${escData(`${f.title}. ${f.fix}`)}`);
}

module.exports = { toSarif, annotations };
