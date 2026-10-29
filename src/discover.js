'use strict';
// Stage 2: find requirement and design documents anywhere in the repository, by content.
// Path and file names only raise a candidate's rank; they never decide. A borderline candidate goes to the model
// (one cheap call, outline only). Over-budget documents are listed as Not read, superseded ones as Skipped.
const { readText, globMatch } = require('./util');
const { sizeOf } = require('./inventory');

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt|feature|org)$/i;
// templates, agent instructions and test data look like specs but state no rule of the product
const NON_SPEC = /(^|\/)(templates?|prompts?|\.github|\.agents?|\.claude|\.cursor|changelogs?|licenses?|fixtures?|__fixtures__|testdata|test-data|node_modules|examples?|samples?|demos?|steering)(\/|$)|(^|\/)(CHANGELOG|LICENSE|COPYING|GPL|LGPL|AGPL|NOTICE|INSTALL|CODE_OF_CONDUCT|SECURITY|CONTRIBUTING|SKILL|AGENTS|CLAUDE)[^/]*$|(^|\/)[^/]*(requirements|constraints)[^/]*\.txt$/i; // the last: pip dependency lists
const STRONG_DIR = /(^|\/)(specs?|requirements|design|rfcs?|proposals|adrs?|decisions|prd)\//i;
const STRONG_FILE = /(^|\/)([^/]*[-_.])?(design|specs?|specification|requirements?|prd|srs|acceptance(-criteria)?|architecture)([-_.][a-z0-9]+)*\.[a-z]+$|(^|\/)[^/]*(需求|设计|架构|方案|规格|说明书)[^/]*$/i;
const ID = /\b(?:REQ|FR|NFR|BR|UR|SR|US|AC|DEC|ADR|AD|DD)[-_]?\d{1,4}\b/g;
const NORMATIVE = /\b(shall|must|must not|is required to|are required to|will not|never)\b|必须|应当|不得/gi;
// a heading format the rules stage parses without the model (OpenSpec/Kiro "### Requirement: x")
const REQ_HEADINGS = /^#{2,6}\s+Requirement(?:\s+\d+(?:\.\d+)*)?\s*[:.\-–—]/gim;
const EARS = /\b(when|while|if|where)\b[^.\n]{0,160}\b(shall|must)\b/gi;
// a Gherkin scenario: a "Scenario:" line and its steps (a prose line that starts with "When" is not one)
const GHERKIN = /^\s*(?:Scenario(?: Outline)?|Example):.*\n(?:\s*\n)*\s*(?:Given|When)\b/m;
const ADR_SHAPE = /^\s*#+\s*(context|decision|consequences)\b/im;
// "Status: Accepted", "**Status**: Proposed" or a "## Status" heading (Nygard ADRs, MADR)
const STATUS_LINE = /^\s*(?:#+\s*|[-*]\s*)?(?:\*\*)?status\b/im;
// a first heading that names the genre: "Design Document: x", "RFC 12: x", "Product requirements", "需求文档"
const TITLE = /\b(design (doc(ument)?|proposal|spec)|technical (design|spec(ification)?)|requirements?( (doc(ument)?|spec(ification)?))?|product requirements|prd|srs|rfc|adr|architecture decision|functional spec(ification)?)\b|(^|[:\-–—]\s*)(design|architecture|requirements|data model|specification|system design)\s*$|需求(文档|说明|规格)|设计(文档|方案|说明)|技术方案|架构设计/i;
// User stories and acceptance criteria (Cohn; IEEE 29148 "stakeholder requirements") state behaviour without "shall".
const STORY = /\bas an? [^,.\n]{2,60},? I (want|need|can|should|would like)\b|作为[^，,。\n]{1,30}[，,]?\s*我(希望|想要|需要|可以)/gi;
const ACCEPTANCE = /^\s*(?:#+|\*\*)\s*(acceptance criteria|acceptance tests?|验收标准|验收条件)/im;
// Section headings a requirement or design document is made of. A design document (Google/Uber-style design doc,
// RFC, arc42) is recognised by its parts, not by normative words: three distinct parts make the shape.
const SPEC_HEADS = [
  /functional requirements?|non[- ]functional|requirements|user stories|use cases?|business rules|constraints|scope|功能需求|非功能需求|需求|用户故事|用例|业务规则|约束|范围/,
  /goals?|non[- ]goals|目标|非目标/, /background|context|motivation|why|summary|problem( statement)?|背景|动机|问题/,
  /(proposed |detailed |high[- ]level )?design|what changes|proposed \w+( \w+)?|proposal|solution|implementation plan|architecture|components?( and interfaces)?|设计|方案|架构|模块/,
  /alternatives?( considered)?|options considered|备选|替代方案/,
  /trade[- ]?offs?|drawbacks|risks|error handling|failure modes|权衡|风险|异常处理/, /data models?|schemas?|apis?|interfaces?|数据模型|接口/,
  /decisions?( outcome)?|consequences|impact|rationale|决策|结论|影响/, /open questions|unresolved questions|待定|未决问题/,
  /security|privacy|performance|scalability|安全|性能/,
];
// "Status: Superseded", a "## Status" heading over "Deprecated", or an ADR line "Superseded by [9. x](0009-x.md)"
const SUPERSEDED = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*[:|-]\s*(?:\*\*)?\s*(superseded|superceded|deprecated|rejected|obsolete)|^#+\s*status\s*\n+\s*(superseded|superceded|deprecated|rejected|obsolete)|^\s*(?:[-*]\s*)?(superseded|superceded|replaced) by\b/im;
// a template, not a document: placeholders where the content should be ("STATUS", "{{title}}", "[short title]")
const PLACEHOLDERS = /^\s*(#+\s*)?(NUMBER\.?\s*TITLE|TITLE|DATE|STATUS|Date:\s*DATE)\s*$|\{\{\s*[\w.-]+\s*\}\}|\[(short title|describe|insert|your)[^\]]*\]/gm;
const SAMPLE = 16 * 1024;
const ARCHIVED = /(^|\/)(archive|archived|deprecated|obsolete|old)\//i;
// In-flight proposals are not yet the product's rules: they rank below current specs and fall to the budget first.
const PROPOSED = /(^|\/)(changes|proposals?|drafts?|explorations?|initiatives|work|wip|rfcs?)\//i;
const MAX_DOCS = 60, MAX_TOTAL = 800 * 1024;
// borderline candidates sent to the model, best ranked first; the rest are listed as Not read
const MAX_ASK = 60;

const count = (re, s) => (s.match(re) || []).length;

// Headings of Markdown ("## x"), reStructuredText (a line over "====" or "----") and AsciiDoc ("== x"), in order.
function headingList(t) {
  const lines = t.split('\n'), out = [], rstChars = [];
  for (let i = 0; i < lines.length; i++) {
    let m;
    if ((m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]))) out.push({ level: m[1].length, text: m[2] });
    else if ((m = /^(={1,6})\s+(\S.*)$/.exec(lines[i]))) out.push({ level: m[1].length, text: m[2] });
    else if (i + 1 < lines.length && /^\s*\S/.test(lines[i]) && !/^\s*[-=~^*+#`'"]{3,}\s*$/.test(lines[i]) && (m = /^([=\-~^"'`#*+])\1{2,}\s*$/.exec(lines[i + 1])) && lines[i + 1].trim().length >= lines[i].trim().length - 2) {
      if (!rstChars.includes(m[1])) rstChars.push(m[1]);
      out.push({ level: rstChars.indexOf(m[1]) + 1, text: lines[i].trim() }); i++;
    }
  }
  return out;
}

function features(file, text) {
  const t = text.slice(0, SAMPLE * 4), heads = headingList(t);
  const prose = t.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, '');
  return {
    ids: count(ID, t),
    structured: count(REQ_HEADINGS, t),
    normative: count(NORMATIVE, t),
    ears: count(EARS, t),
    gherkin: GHERKIN.test(t),
    adr: ADR_SHAPE.test(t) && STATUS_LINE.test(t),
    titled: TITLE.test((heads.find((h) => h.level === 1) || heads[0] || { text: '' }).text),
    stories: count(STORY, t),
    acceptance: ACCEPTANCE.test(t),
    ...headings(heads),
    hint: STRONG_DIR.test(file) || STRONG_FILE.test(file),
    template: count(PLACEHOLDERS, prose) >= 2,
  };
}

function headings(list) {
  const heads = list.filter((h) => h.level <= 4).map((h) => h.text.replace(/^[\d.]+\s*/, '').replace(/[*_:：`]/g, '').trim().toLowerCase());
  const parts = SPEC_HEADS.filter((re) => heads.some((h) => h.length <= 60 && new RegExp(`^(${re.source})(?![a-z])`, 'i').test(h))).length;
  return { parts };
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
  if (f.stories >= 2) s += 2;
  if (f.acceptance) s += 1.5;
  if (f.parts >= 3) s += Math.min(3, f.parts - 1); else if (f.parts === 2) s += 0.5;
  if (f.titled) s += 2;
  if (f.normative && size && f.normative * 600 >= Math.min(size, SAMPLE * 4)) s += 1; // dense normative prose
  if (f.template) return 0;
  // "must" is in every kind of prose (governance, admin guides, incident notes): without the structure of a spec, the
  // model decides
  const structure = f.noGate || f.ids >= 3 || f.structured || f.ears >= 2 || f.gherkin || f.adr || f.stories >= 2 || f.acceptance || f.parts >= 3 || f.titled || f.hint;
  if (!structure) s = Math.min(s, 2.9);
  return Math.max(0, s);
}

/**
 * @param {object} o root, files, external [{path,text,kindHint}], budgetKb, include[], exclude[], llm (optional classifier)
 */
async function discover({ root, files, external = [], budgetKb = 60, include = [], exclude = [], classify, maxDocs = MAX_DOCS, ablate = [] }) {
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
    for (const k of ablate) f[k] = k === 'noGate'; // experiments only: switch a feature off
    const s = isForced ? 10 : score(f, size);
    if (s < 1.5) continue;
    if (!isForced && ARCHIVED.test(file)) { skipped.push({ path: file, reason: 'archived' }); continue; }
    if (SUPERSEDED.test(text.slice(0, SAMPLE))) { skipped.push({ path: file, reason: 'superseded' }); continue; }
    if (size > budget) { notRead.push({ path: file, reason: `${Math.round(size / 1024)} KB, over the ${budgetKb} KB read budget` }); continue; }
    const rank = s - (!isForced && PROPOSED.test(file) ? 3 : 0);
    if (s >= 3) read.push({ path: file, text, score: rank, size }); else ask.push({ path: file, text, score: rank, size });
  }
  ask.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  // a borderline document can only be read if it would rank inside the document budget: when the documents code
  // admitted already fill it, ask only about candidates that outrank the last of them (a current doc over a proposal)
  const admitted = [...read].sort((a, b) => b.score - a.score);
  const bar = admitted.length >= maxDocs ? admitted[maxDocs - 1].score : -Infinity;
  for (const c of ask.filter((x) => x.score <= bar)) notRead.push({ path: c.path, reason: `borderline, ranks below the ${maxDocs}-document budget` });
  ask.splice(0, ask.length, ...ask.filter((x) => x.score > bar));
  for (const c of ask.splice(MAX_ASK)) notRead.push({ path: c.path, reason: `borderline, over the ${MAX_ASK}-candidate classification budget` });
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

// Headings (Markdown, rst, AsciiDoc) plus the first 2 KB of the body: enough to tell a spec from a guide, cheap to send.
function outline(text) {
  const heads = headingList(text.slice(0, SAMPLE * 4)).filter((h) => h.level <= 4).slice(0, 40).map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
  return `${heads}\n---\n${text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').slice(0, 2048)}`;
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

module.exports = { discover, reverseLookup, features, score, SUPERSEDED, NON_SPEC, ID };
