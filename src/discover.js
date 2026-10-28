'use strict';
// Stage 2: find requirement and design documents anywhere in the repository, by content.
// Path and file names only raise a candidate's rank; they never decide. A borderline candidate goes to the model
// (one cheap call, outline only). Over-budget documents are listed as Not read, superseded ones as Skipped.
const { readText, globMatch } = require('./util');
const { sizeOf } = require('./inventory');

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt|feature|org)$/i;
// templates, agent instructions and test data look like specs but state no rule of the product
const NON_SPEC = /(^|\/)(templates?|prompts?|\.github|\.agents?|\.claude|\.cursor|changelogs?|licenses?|fixtures?|__fixtures__|testdata|test-data|node_modules)(\/|$)|(^|\/)(CHANGELOG|LICENSE|CODE_OF_CONDUCT|SECURITY|CONTRIBUTING|SKILL|AGENTS|CLAUDE)[^/]*$/i;
const STRONG_DIR = /(^|\/)(specs?|requirements|design|rfcs?|proposals|adrs?|decisions|prd)\//i;
const STRONG_FILE = /(^|\/)([^/]*[-_.])?(design|specs?|specification|requirements?|prd|srs|acceptance(-criteria)?|architecture)([-_.][a-z0-9]+)*\.[a-z]+$/i;
const ID = /\b(?:REQ|FR|NFR|BR|UR|SR|US|AC|DEC|ADR|AD|DD)[-_]?\d{1,4}\b/g;
const NORMATIVE = /\b(shall|must|must not|is required to|are required to|will not|never)\b|必须|应当|不得/gi;
// a heading format the rules stage parses without the model (OpenSpec/Kiro "### Requirement: x")
const REQ_HEADINGS = /^#{2,6}\s+Requirement(?:\s+\d+(?:\.\d+)*)?\s*[:.\-–—]/gim;
const EARS = /\b(when|while|if|where)\b[^.\n]{0,160}\b(shall|must)\b/gi;
const GHERKIN = /^\s*(Feature|Scenario(?: Outline)?|Given|When|Then)\b/m;
const ADR_SHAPE = /^\s*#+\s*(context|decision|consequences)\b/im;
const SUPERSEDED = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*[:|-]\s*(?:\*\*)?\s*(superseded|deprecated|rejected|obsolete)/im;
const SAMPLE = 16 * 1024;
const ARCHIVED = /(^|\/)(archive|archived|deprecated|obsolete|old)\//i;
// In-flight proposals are not yet the product's rules: they rank below current specs and fall to the budget first.
const PROPOSED = /(^|\/)(changes|proposals?|drafts?|explorations?|initiatives|work|wip|rfcs?)\//i;
const MAX_DOCS = 60, MAX_TOTAL = 800 * 1024;

const count = (re, s) => (s.match(re) || []).length;

function features(file, text) {
  const t = text.slice(0, SAMPLE * 4);
  return {
    ids: count(ID, t),
    structured: count(REQ_HEADINGS, t),
    normative: count(NORMATIVE, t),
    ears: count(EARS, t),
    gherkin: GHERKIN.test(t),
    adr: ADR_SHAPE.test(t) && /^\s*(?:[-*]\s*)?(?:\*\*)?status/im.test(t),
    hint: STRONG_DIR.test(file) || STRONG_FILE.test(file),
  };
}

// Score in [0, ~10]. >= 3 admits, 1.5..3 asks the model, below 1.5 rejects.
function score(f, size) {
  let s = 0;
  if (f.ids >= 3 || f.structured) s += 3;
  s += Math.min(3, f.normative / 2);
  s += Math.min(2, f.ears);
  if (f.gherkin) s += 3;
  if (f.adr) s += 3;
  if (f.hint) s += 1.5;
  if (f.normative && size && f.normative * 600 >= Math.min(size, SAMPLE * 4)) s += 1; // dense normative prose
  return s;
}

/**
 * @param {object} o root, files, external [{path,text,kindHint}], budgetKb, include[], exclude[], llm (optional classifier)
 */
async function discover({ root, files, external = [], budgetKb = 60, include = [], exclude = [], classify, maxDocs = MAX_DOCS }) {
  const budget = budgetKb * 1024;
  const read = [], notRead = [], skipped = [], ask = [];
  const forced = (p) => include.some((g) => globMatch(g, p));
  const excluded = (p) => exclude.some((g) => globMatch(g, p));
  for (const file of files) {
    if (!DOC_EXT.test(file) || excluded(file)) continue;
    const isForced = forced(file);
    if (!isForced && NON_SPEC.test(file)) continue;
    const size = sizeOf(root, file);
    const text = readText(root, file);
    if (text == null) continue;
    const f = features(file, text);
    const s = isForced ? 10 : score(f, size);
    if (s < 1.5) continue;
    if (!isForced && ARCHIVED.test(file)) { skipped.push({ path: file, reason: 'archived' }); continue; }
    if (SUPERSEDED.test(text.slice(0, SAMPLE))) { skipped.push({ path: file, reason: 'superseded' }); continue; }
    if (size > budget) { notRead.push({ path: file, reason: `${Math.round(size / 1024)} KB, over the ${budgetKb} KB read budget` }); continue; }
    const rank = s - (!isForced && PROPOSED.test(file) ? 3 : 0);
    if (s >= 3) read.push({ path: file, text, score: rank, size }); else ask.push({ path: file, text, score: rank, size });
  }
  if (ask.length && classify) {
    const verdicts = await classify(ask.map((c) => ({ path: c.path, outline: outline(c.text) })));
    for (const c of ask) {
      const v = verdicts.find((x) => x.path === c.path);
      if (!v || v.kind === 'none') continue;
      if (v.status === 'superseded') skipped.push({ path: c.path, reason: 'superseded' });
      else read.push({ path: c.path, text: c.text, score: c.score, size: c.size, kindHint: v.kind });
    }
  }
  // Budget: the best-ranked documents first; the rest are listed as Not read so a reader knows what the answer misses.
  read.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  let total = 0;
  const kept = [];
  for (const d of read) {
    if (kept.length >= maxDocs || total + d.size > MAX_TOTAL) { notRead.push({ path: d.path, reason: `over the ${maxDocs}-document, ${MAX_TOTAL / 1024} KB budget` }); continue; }
    total += d.size; kept.push(d);
  }
  read.length = 0; read.push(...kept);
  for (const e of external) {
    if (Buffer.byteLength(e.text) > budget) notRead.push({ path: e.path, reason: `${Math.round(Buffer.byteLength(e.text) / 1024)} KB, over the ${budgetKb} KB read budget` });
    else read.push({ path: e.path, text: e.text, score: 10, kindHint: e.kindHint, external: true });
  }
  return { read, notRead, skipped };
}

// Headings plus the first 2 KB: enough to tell a spec from a tutorial, cheap to send.
function outline(text) {
  const heads = text.split('\n').filter((l) => /^#{1,4}\s/.test(l)).slice(0, 40).join('\n');
  return `${heads}\n---\n${text.slice(0, 2048)}`;
}

// ID reverse lookup: a rule ID that code or tests mention but no read document defines points at a document the
// content scan missed. Returns the text files (any extension) that define such an ID at the start of a line or heading.
function reverseLookup({ root, files, mentioned, defined, already }) {
  const missing = [...mentioned].filter((id) => !defined.has(id));
  if (!missing.length) return [];
  const found = new Set();
  for (const file of files) {
    if (already.has(file) || !/\.(md|mdx|markdown|rst|adoc|txt|feature|org|ya?ml|json)$/i.test(file)) continue;
    const text = readText(root, file);
    if (!text) continue;
    if (missing.some((id) => new RegExp(`^\\s*(?:[-*#]+\\s*)?(?:\\*\\*)?${id}\\b`, 'm').test(text))) found.add(file);
  }
  return [...found];
}

module.exports = { discover, reverseLookup, features, score, SUPERSEDED, ID };
