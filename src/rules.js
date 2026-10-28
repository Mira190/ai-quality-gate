'use strict';
// Stage 3: rules from the documents read. An item with an ID is parsed by code; a document with no ID items is split
// into atomic rules by the model, and code checks every cited line. Each item is classified by what it says (its ID
// prefix, or the model's reading), not by where it lives: one file can give requirements and design decisions.
const { linesOf } = require('./util');

const REQ_PREFIX = /^(REQ|FR|NFR|BR|UR|SR|US|AC|R)$/i;
const DEC_PREFIX = /^(DEC|ADR|AD|DD|D)$/i;
const ID_SRC = '(?:REQ|FR|NFR|BR|UR|SR|US|AC|DEC|ADR|AD|DD)[-_]?\\d{1,4}';
const HEADING = new RegExp(`^(#{1,6})\\s+(?:\\*\\*)?(${ID_SRC})(?:\\*\\*)?\\s*[:.\\-–—]?\\s*(.*?)\\s*$`);
const BOLD_ITEM = new RegExp(`^\\s*(?:[-*+]|\\d+[.)])?\\s*\\*\\*(${ID_SRC})\\s+([^*]+?)\\.?\\*\\*\\s*(.*)$`);
const PLAIN_ITEM = new RegExp(`^\\s*(?:[-*+]|\\d+[.)])?\\s*(${ID_SRC})\\s*[:.)\\-–—]\\s*(.+)$`);
const META = /^\s*(?:[-*]\s*)?(?:\*\*)?(serves|reason|status|owner|date)(?:\*\*)?\s*:\s*(.*)$/i;

const kindOf = (id, hint) => {
  const p = id.replace(/[-_]?\d+$/, '');
  if (REQ_PREFIX.test(p)) return 'requirement';
  if (DEC_PREFIX.test(p)) return 'decision';
  return hint === 'design' ? 'decision' : 'requirement';
};
const normId = (id) => id.toUpperCase().replace(/^([A-Z]+)[-_]?(\d+)$/, (_, a, n) => `${a}-${n.padStart(2, '0')}`);
const shortTitle = (t) => t.replace(/[.:;].*$/, '').split(/\s+/).slice(0, 6).join(' ');

function parseDoc(doc) {
  const lines = linesOf(doc.text), items = [];
  for (let i = 0; i < lines.length; i++) {
    let m;
    if ((m = HEADING.exec(lines[i]))) {
      const level = m[1].length, body = [];
      let serves = null, reason = null, first = null;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (/^#{1,6}\s/.test(l) && (l.match(/^#+/)[0].length <= level || HEADING.test(l))) break;
        if (BOLD_ITEM.test(l) || PLAIN_ITEM.test(l)) break; // the next rule starts, as a list item
        if (!l.trim()) continue;
        const meta = META.exec(l);
        if (meta) { if (/serves/i.test(meta[1])) serves = meta[2].trim(); if (/reason/i.test(meta[1])) reason = meta[2].trim(); continue; }
        if (first == null) first = j + 1;
        body.push(l.trim());
      }
      items.push({ id: normId(m[2]), title: m[3] || shortTitle(body.join(' ')), text: body.join(' '), line: first || i + 1, path: doc.path, serves, reason });
    } else if ((m = BOLD_ITEM.exec(lines[i]))) {
      items.push({ id: normId(m[1]), title: m[2].trim(), text: m[3].trim(), line: i + 1, path: doc.path });
    } else if ((m = PLAIN_ITEM.exec(lines[i]))) {
      items.push({ id: normId(m[1]), title: shortTitle(m[2]), text: m[2].trim(), line: i + 1, path: doc.path });
    }
  }
  if (!items.length) return structuredItems(doc, lines);
  return items.map((it) => ({ ...it, kind: kindOf(it.id, doc.kindHint), hasSourceId: true, servesIds: (it.serves || '').match(new RegExp(ID_SRC, 'g'))?.map(normId) || [] }));
}

// Known spec formats without IDs, parsed by code (IDs are assigned later, in document order):
//   OpenSpec / Kiro "### Requirement: title" or "### Requirement 3: title" (text = the paragraph under it)
//   ADR (Nygard / MADR): one decision per file, text = the first paragraph of "## Decision"
//   Gherkin: one requirement per Scenario
const REQ_HEAD = /^(#{2,6})\s+Requirement(?:\s+\d+(?:\.\d+)*)?\s*[:.\-–—]?\s*(.*?)\s*$/i;
function structuredItems(doc, lines) {
  const out = [];
  const para = (from) => { const body = []; let first = null; for (let j = from; j < lines.length; j++) { const l = lines[j]; if (/^#{1,6}\s/.test(l)) break; if (!l.trim()) { if (body.length) break; continue; } if (META.test(l)) continue; if (first == null) first = j + 1; body.push(l.trim()); } return { text: body.join(' '), line: first }; };
  // the scenarios under a requirement (up to the next heading of the same or a higher level) are its acceptance detail
  const detailOf = (i, level) => { const d = []; for (let j = i + 1; j < lines.length; j++) { const h = /^(#{1,6})\s/.exec(lines[j]); if (h && h[1].length <= level) break; if (lines[j].trim()) d.push(lines[j].trim()); } return d; };
  lines.forEach((l, i) => {
    const m = REQ_HEAD.exec(l);
    if (!m) return;
    const p = para(i + 1);
    if (!p.text) return;
    const rest = detailOf(i, m[1].length), at = rest.findIndex((x) => /^#{1,6}\s/.test(x));
    out.push({ title: m[2] || shortTitle(p.text), text: p.text, line: p.line, kind: doc.kindHint === 'design' ? 'decision' : 'requirement', detail: at >= 0 ? rest.slice(at).join('\n').slice(0, 1500) : '' });
  });
  if (!out.length && /^\s*(?:[-*]\s*)?(?:\*\*)?status/im.test(doc.text)) {
    const d = lines.findIndex((l) => /^#{1,3}\s+Decision(\s+Outcome)?\s*$/i.test(l));
    if (d >= 0) { const p = para(d + 1); const h1 = lines.find((l) => /^#\s/.test(l)) || ''; if (p.text) out.push({ title: h1.replace(/^#\s+/, '').replace(/^(ADR|RFC)[-\s]*\d+\s*[:.\-–—]\s*/i, '') || shortTitle(p.text), text: p.text, line: p.line, kind: 'decision' }); }
  }
  if (!out.length && /\.feature$/i.test(doc.path)) {
    lines.forEach((l, i) => {
      const m = /^\s*Scenario(?: Outline)?:\s*(.+)$/.exec(l);
      if (!m) return;
      const steps = []; for (let j = i + 1; j < lines.length && !/^\s*(Scenario|Feature|Rule)\b/.test(lines[j]); j++) if (/^\s*(Given|When|Then|And|But)\b/.test(lines[j])) steps.push(lines[j].trim());
      out.push({ title: m[1].trim(), text: steps.join(' '), line: i + 1, kind: 'requirement' });
    });
  }
  return out.map((it) => ({ ...it, id: null, path: doc.path, hasSourceId: false, servesIds: [] }));
}

/**
 * All rules from the documents read. Documents with no ID items go to `atomize` (the model), whose items must quote
 * a line that exists in the document, or they are dropped.
 */
async function extractRules(docs, { atomize } = {}) {
  const rules = [], seen = new Set(), dropped = [], perDoc = new Map();
  const add = (r) => { if (seen.has(r.id)) { dropped.push({ id: r.id, reason: `duplicate ID (first at ${rules.find((x) => x.id === r.id).path})` }); return; } seen.add(r.id); rules.push(r); };
  const noIds = [], unnumbered = [];
  for (const doc of docs) {
    const items = parseDoc(doc);
    if (!items.length) { noIds.push(doc); continue; }
    for (const it of items) (it.id ? add(it) : unnumbered.push(it));
  }
  const next = { requirement: maxNum(rules, 'REQ'), decision: maxNum(rules, 'DEC') };
  for (const it of unnumbered) add({ ...it, id: it.kind === 'decision' ? `DEC-${String(++next.decision).padStart(2, '0')}` : `REQ-${String(++next.requirement).padStart(2, '0')}` });
  if (noIds.length && atomize) {
    for (const doc of noIds) {
      const lines = linesOf(doc.text);
      const out = await atomize(doc);
      for (const it of out) {
        const at = lines[it.line - 1] || '';
        if (!it.quote || !norm(at).includes(norm(it.quote).slice(0, 40))) { dropped.push({ id: '(atomized)', reason: `quote not found at ${doc.path}:${it.line}` }); continue; }
        const kind = it.kind === 'decision' ? 'decision' : doc.kindHint === 'design' && it.kind !== 'requirement' ? 'decision' : 'requirement';
        const id = kind === 'decision' ? `DEC-${String(++next.decision).padStart(2, '0')}` : `REQ-${String(++next.requirement).padStart(2, '0')}`;
        add({ id, kind, title: it.title, text: it.text, line: it.line, path: doc.path, hasSourceId: false, servesIds: [], reason: it.reason || null });
      }
    }
  }
  for (const r of rules) perDoc.set(r.path, perDoc.get(r.path) || { requirements: 0, decisions: 0 }), perDoc.get(r.path)[r.kind === 'decision' ? 'decisions' : 'requirements']++;
  return { rules, dropped, perDoc };
}

const maxNum = (rules, p) => Math.max(0, ...rules.filter((r) => r.id.startsWith(p + '-')).map((r) => Number(r.id.split('-')[1])));
const norm = (s) => String(s).toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

module.exports = { parseDoc, extractRules, kindOf, normId, ID_SRC };
