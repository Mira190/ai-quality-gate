'use strict';
// Stage 2, extract: requirements and design decisions out of the repository's documents. Entirely deterministic.
//
// Why no model here: a rule's identity must not move between runs. The baseline, the verdict cache and every
// suppression hang off the rule ID; a model that splits a paragraph into three rules today and two tomorrow would
// turn the same repository into a different report. So a rule is one of four things code can recognise:
//   1. an item that carries an ID (REQ-12, DEC-04, AC-3 ...) at the start of a heading, list item or table row;
//   2. an architecture decision record (one decision per file);
//   3. a normative sentence (must / shall / should / 必须 ...) in a requirement or design document, without an ID;
//   4. a list item under an "Acceptance criteria" / "Requirements" heading.
// 3 and 4 are "inferred": the ID is a hash of the text, and the model is later asked whether the sentence is a
// behaviour a test could prove (it may only remove an inferred rule, never invent one).
const path = require('node:path');
const { sha, clip, matcher, readText } = require('../util');
const { tagRule } = require('./risk');

const PARSER_VERSION = 4; // bump when parseDoc changes: cached parses of unchanged documents are then redone
const REQ_PREFIXES = ['REQ', 'FR', 'NFR', 'AC', 'US', 'UC', 'BR', 'SR', 'RULE', 'INV', 'SEC'];
const DEC_PREFIXES = ['DEC', 'ADR', 'DR', 'AD', 'DD'];

function idPattern(config = {}) {
  const dec = new Set([...DEC_PREFIXES, ...(config.rules?.decision_prefixes || [])].map((s) => s.toUpperCase()));
  const all = [...new Set([...REQ_PREFIXES, ...dec, ...(config.rules?.id_prefixes || []).map((s) => s.toUpperCase())])].sort((a, b) => b.length - a.length);
  const src = `(?<![A-Za-z0-9_-])(${all.join('|')})[-_](\\d+(?:\\.\\d+)*)(?![A-Za-z0-9_]|[-.]\\d)`;
  return { src, re: () => new RegExp(src, 'gi'), isDecision: (id) => dec.has(id.split('-')[0].toUpperCase()), grep: `(${all.join('|')})[-_][0-9]+` };
}
/** REQ_007 and req-7 are the same rule. */
const normId = (prefix, num) => `${prefix.toUpperCase()}-${num.split('.').map((n) => String(Number(n))).join('.')}`;
const idsIn = (text, idp) => [...String(text).matchAll(idp.re())].map((m) => normId(m[1], m[2]));

const SKIP_DOC = /(^|\/)(CHANGELOG|CHANGES|HISTORY|LICEN[SC]E|CODE_OF_CONDUCT|SECURITY|NOTICE|AUTHORS|CONTRIBUTORS|RELEASE[-_ ]?NOTES)[^/]*$|(^|\/)(templates?|prompts?|\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE))(\/|\.md$)|(^|\/)PULL_REQUEST_TEMPLATE/i;
/** @type {[string, RegExp][]} */
const TYPE_BY_PATH = [
  ['adr', /(^|\/)(adrs?|decisions|architecture[-_]decisions?)\/[^/]+$/i],
  ['requirement', /(^|\/)(requirements?|reqs?|specs?|specifications?|prd|srs|acceptance|user[-_]?stories|stories|openspec)(\/|[-_.])|(^|\/)[^/]*(requirements?|[-_.]spec|prd|srs|acceptance|需求)[^/]*\.\w+$|(^|\/)\.kiro\/specs\//i],
  ['design', /(^|\/)(design|designs|architecture|arch|rfcs?|tech[-_]?specs?|proposals?)(\/|[-_.])|(^|\/)[^/]*(design|architecture|rfc|设计|架构)[^/]*\.\w+$/i],
];
// A document under a top-level docs/ folder that no pattern above names is read as a design document: that is where
// a project that writes prose instead of numbered requirements keeps how it is meant to work.
const docType = (p) => TYPE_BY_PATH.find(([, re]) => re.test(p))?.[0] || (/^docs?\/(?!images\/|assets\/)/i.test(p) ? 'design' : 'general');

const INACTIVE = /\b(superseded|deprecated|rejected|withdrawn|obsolete|dropped|proposed|draft)\b|已废弃|已取代|已拒绝|草案/i;
// A numbered rule is retired only by an explicit marker: "Status: superseded", "[deprecated]", "(rejected)" or a strike-through.
const RETIRED = /\b(?:status|state)\s*[:=]\s*(?:superseded|deprecated|rejected|withdrawn|obsolete|dropped)|[[(（【](?:superseded|deprecated|rejected|withdrawn|obsolete|dropped|已废弃|已取代)\b/i;
// Words that state an obligation or an invariant. "cannot" and "can only" are left out: in prose they describe a
// limitation of the world ("the photographs cannot tell the two apart") far more often than a rule of the software.
const MODAL = /\b(must|shall|should|may not|is required to|are required to|never|always|is not allowed|are not allowed)\b|必须|不得|禁止|应当|应该|不能|不允许|只能/i;
const DECIDED = /\b(we (?:chose|choose|decided|will use|adopt(?:ed)?|use)\b|decision:)/i;
const PROCESS = /\b(you|developers?|contributors?|reviewers?|maintainers?|prs?|pull requests?|commits?|the team|engineers?)\s+(must|should|shall|need)|\b(install|run `|npm |pip |checkout)\b/i;
const CRITERIA_HEADING = /acceptance criteria|requirements?$|business rules?|functional requirements?|non-functional|验收标准|需求|业务规则/i;

const DEF = (idSrc) => new RegExp(`^(\\s*)(#{1,6}\\s+|[-*+]\\s+(?:\\[[ xX]\\]\\s+)?|\\d+[.)]\\s+|\\|\\s*|>\\s*)?((?:\\*\\*|__|\`|\\[|~~)*)${idSrc}`, 'i');
const unmark = (s) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

/** Choose which documents to read: typed by path, or carrying an ID somewhere (found by git grep, not by reading). */
function chooseDocs(inventory, idHits, config) {
  const include = matcher(config.docs.include), exclude = matcher(config.docs.exclude);
  const withIds = new Set(idHits.map((h) => h.path));
  const picked = [], skipped = [];
  for (const f of inventory.byKind.doc || []) {
    if (exclude(f.path)) continue;
    const forced = include(f.path);
    if (!forced && SKIP_DOC.test(f.path)) continue;
    const type = docType(f.path);
    const hasId = idHits.grepRan ? withIds.has(f.path) : null;
    if (!forced && type === 'general' && hasId === false) continue;
    if (f.ext === 'txt' && type === 'general' && !forced) continue;
    picked.push({ file: f, type: forced && type === 'general' ? 'requirement' : type, score: (forced ? 100 : 0) + (hasId ? 10 : 0) + (type === 'general' ? 0 : 5) });
  }
  picked.sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1));
  const max = config.docs.max_files;
  for (const d of picked.slice(max)) skipped.push({ path: d.file.path, why: `over the ${max}-document limit` });
  return { docs: picked.slice(0, max), skipped };
}

/** Parse one document into rules. Pure: (path, text, type) → rules. This is what the per-file cache stores. */
function parseDoc(p, text, type, idp, config = {}) {
  const lines = text.split(/\r?\n/);
  const def = DEF(idp.src);
  /** @type {any[]} */
  const rules = [];
  let fence = false;
  // the headings above each line: a rule read without its section ("The cap applies after tax") is half a rule
  const chain = [], above = [];
  for (let i = 0, f = false; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) f = !f;
    above.push(chain.filter(Boolean).slice(-2).join(' › '));
    const h = !f && /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (h) { chain.length = h[1].length - 1; chain[h[1].length - 1] = unmark(h[2]).slice(0, 60); }
  }
  const isBreak = (l) => !l.trim() || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|~~~|---+\s*$)/.test(l);

  // pass 1: items with an ID
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    const m = def.exec(l);
    if (!m) continue;
    const marker = (m[2] || '').trim();
    const id = normId(m[4], m[5]);
    let rest = l.slice(m[0].length);
    const body = [];
    if (marker.startsWith('|')) rest = rest.split('|').map((c) => c.trim()).filter(Boolean).join(' — ');
    else if (marker.startsWith('#')) {
      // a heading: the rule text is the paragraph under it
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      for (; j < lines.length && body.length < 6 && lines[j].trim() && !/^\s*(#{1,6}\s|```|~~~)/.test(lines[j]); j++) body.push(lines[j].replace(/^\s*[-*+]\s+/, ''));
    } else for (let j = i + 1; j < lines.length && body.length < 6 && !isBreak(lines[j]); j++) body.push(lines[j]);
    rest = rest.replace(/^[\s:：.)\]|–—-]+/, '');
    const titleEnd = /^(.*?)(\*\*|__)/.exec(rest);   // "**REQ-1 Title.** text": the bold part is the title
    const full = unmark([rest, ...body].join(' '));
    if (full.length < 3) continue;
    const title = clip(unmark(m[3] && titleEnd ? titleEnd[1] : full.split(/(?<=[.。:：])\s/)[0]).replace(/[.。:：]$/, ''), 80);
    const struck = /~~/.test(l);
    rules.push({
      id, kind: idp.isDecision(id) ? 'decision' : 'requirement', title, text: clip(full, 600), path: p, line: i + 1, inferred: false,
      active: !(struck || RETIRED.test(unmark(l))),
    });
  }

  // pass 2: one decision per architecture decision record
  const looksAdr = type === 'adr' || (/^#{1,3}\s*Decision\b/im.test(text) && /^(#{1,3}\s*Status\b|\**Status\**\s*:)/im.test(text));
  if (!rules.length && looksAdr) {
    const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
    const num = /(?:^|\/)(?:adr[-_]?)?(\d{1,5})[-_.]/i.exec(path.posix.basename(p));
    const section = (name) => {
      const s = lines.findIndex((l) => new RegExp(`^#{1,4}\\s*${name}\\b`, 'i').test(l));
      if (s < 0) return '';
      const out = [];
      for (let j = s + 1; j < lines.length && !/^#{1,4}\s/.test(lines[j]) && out.join(' ').length < 600; j++) out.push(lines[j]);
      return unmark(out.join(' '));
    };
    const status = section('Status') || (/^\**Status\**\s*:\s*(.+)$/im.exec(text)?.[1] ?? '');
    const title = h1 >= 0 ? unmark(lines[h1].replace(/^#\s+/, '')).replace(/^(adr[-_ ]?)?\d+[.:)\s-]+/i, '') : path.posix.basename(p);
    const decision = section('Decision') || section('决策');
    if (title && (decision || h1 >= 0)) {
      rules.push({
        id: num ? `ADR-${Number(num[1])}` : `D-${sha(title, 6).toUpperCase()}`, kind: 'decision', title: clip(title, 80), text: clip(decision || title, 600), path: p,
        line: h1 >= 0 ? h1 + 1 : 1, inferred: false, active: !INACTIVE.test(status), status: status ? clip(status, 40) : undefined,
      });
    }
  }

  // pass 3: sentences that state a rule without an ID. Only in a document with no IDs at all: a document that
  // numbers its rules has told us which sentences are rules.
  if (!rules.length && !looksAdr && type !== 'general' && config.rules?.infer !== false) {
    // Prose is wrapped at a column, so a line is not a sentence: paragraphs and list items are put back together
    // first, and only then cut at sentence ends. A fragment is worse than nothing: nobody can test half a sentence.
    const blocks = [];
    fence = false;
    let cur = null;
    const flush = () => { if (cur) blocks.push(cur); cur = null; };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(```|~~~)/.test(l)) { fence = !fence; flush(); continue; }
      if (fence) continue;
      if (!l.trim() || /^\s*(#{1,6}\s|\||>|<!--|!\[|---+\s*$)/.test(l)) { flush(); continue; }
      const item = /^\s*([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
      if (item) { flush(); cur = { line: i + 1, text: item[2], item: true }; } else if (cur) cur.text += ' ' + l.trim(); else cur = { line: i + 1, text: l.trim(), item: false };
    }
    flush();
    const seen = new Set();
    for (const b of blocks) {
      const underCriteria = b.item && CRITERIA_HEADING.test(above[b.line - 1] || '');
      for (const s of unmark(b.text).split(/(?<=[.。！!])\s+(?=[\p{Lu}\p{Lo}`"'(\d])|(?<=[。；])/u)) {
        const sentence = s.trim();
        if (sentence.length < 25 || sentence.length > 400 || /[?？:：]$/.test(sentence)) continue;
        if (!/^[\p{Lu}\p{Lo}`"'\d]/u.test(sentence)) continue;                                         // starts mid-sentence
        if ((sentence.match(/\(/g) || []).length !== (sentence.match(/\)/g) || []).length) continue;     // cut inside brackets
        const decided = type === 'design' && DECIDED.test(sentence);
        if (!(MODAL.test(sentence) || decided || underCriteria) || PROCESS.test(sentence)) continue;
        const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = type === 'design' ? 'decision' : 'requirement';
        rules.push({ id: `${kind === 'decision' ? 'D' : 'R'}-${sha(key, 6).toUpperCase()}`, kind, title: clip(sentence.replace(/[.。]$/, ''), 80), text: clip(sentence, 600), path: p, line: b.line, inferred: true, active: true });
      }
    }
  }
  for (const r of rules) { r.refs = idsIn(r.text, idp).filter((x) => x !== r.id); r.section = above[r.line - 1] || undefined; }
  return rules;
}

/**
 * Returns {rules, docs, notRead, duplicates}. rules sorted by document then line; the first definition of an ID wins.
 */
function extractRules({ root, inventory, idHits, cache, config }) {
  const idp = idPattern(config);
  const { docs, skipped } = chooseDocs(inventory, idHits, config);
  const notRead = [...skipped], docStats = [], duplicates = [];
  const byId = new Map();
  const cfgKey = sha(JSON.stringify([PARSER_VERSION, idp.src, config.rules.infer]), 8);
  for (const d of docs) {
    const key = d.file.sha && `${d.file.sha}:${d.type}:${cfgKey}`;
    let parsed = key ? cache.get('docs', key) : undefined;
    if (!parsed) {
      const text = readText(path.join(root, d.file.path), config.docs.max_kb * 1024 + 1);
      if (text === null) continue;
      if (Buffer.byteLength(text) > config.docs.max_kb * 1024) { notRead.push({ path: d.file.path, why: `over ${config.docs.max_kb} KB` }); continue; }
      parsed = parseDoc(d.file.path, text, d.type, idp, config).map(({ path: _p, ...r }) => r);
      if (key) cache.set('docs', key, parsed);
    }
    let n = 0;
    for (const r of parsed) {
      const rule = { ...r, path: d.file.path, pkg: d.file.pkg };
      if (byId.has(rule.id)) { duplicates.push({ id: rule.id, path: rule.path, line: rule.line, first: `${byId.get(rule.id).path}:${byId.get(rule.id).line}` }); continue; }
      byId.set(rule.id, tagRule(rule, config));
      n++;
    }
    if (n) docStats.push({ path: d.file.path, type: d.type, rules: n });
  }
  let rules = [...byId.values()];
  let truncated = 0;
  if (rules.length > config.rules.max) {
    // keep what matters most: critical first, then rules with a real ID
    const rank = (r) => (r.critical ? 0 : 2) + (r.inferred ? 1 : 0);
    rules.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
    truncated = rules.length - config.rules.max;
    rules = rules.slice(0, config.rules.max);
  }
  rules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { rules, docs: docStats, notRead, duplicates, truncated, idp };
}

module.exports = { extractRules, parseDoc, idPattern, normId, idsIn, docType, chooseDocs };
