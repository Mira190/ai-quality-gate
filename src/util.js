'use strict';
// Small shared helpers. No I/O except readText.
const fs = require('node:fs');
const path = require('node:path');

const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
const linesOf = (text) => String(text).replace(/\r\n?/g, '\n').split('\n');

// Natural rule-ID order: requirements before decisions, then by number (REQ-2 before REQ-10).
const KIND_RANK = { requirement: 0, decision: 1 };
const idNum = (id) => Number((String(id).match(/(\d+)(?!.*\d)/) || [0, 0])[1]);
const idPrefix = (id) => String(id).replace(/[-_.]?\d+$/, '');
function compareRules(a, b) {
  const k = (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2);
  if (k) return k;
  const p = idPrefix(a.id).localeCompare(idPrefix(b.id));
  return p || idNum(a.id) - idNum(b.id);
}

// Greedy word wrap for one paragraph; width in characters (the report hard-wraps only the run line).
function wrap(text, width) {
  const out = []; let line = '';
  for (const w of text.split(/ +/)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out.join('\n');
}

// Minimal glob → RegExp: ** (any dirs), * (no slash), ?, {a,b}. Paths use forward slashes.
function globToRegExp(glob) {
  let re = '', i = 0;
  const g = glob.replace(/^\.\//, '');
  while (i < g.length) {
    const c = g[i];
    if ('?@+*!'.includes(c) && g[i + 1] === '(') { // extglob: ?(a|b) @(a|b) +(a|b) *(a|b)
      const j = g.indexOf(')', i), alt = g.slice(i + 2, j).split('|').map((s) => s.replace(/[.+^$|\\]/g, '\\$&')).join('|');
      re += `(?:${alt})${{ '?': '?', '@': '', '+': '+', '*': '*', '!': '' }[c]}`; i = j + 1; continue;
    }
    if (c === '*' && g[i + 1] === '*') { i += 2; if (g[i] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; continue; }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const j = g.indexOf(']', i); re += g.slice(i, j + 1); i = j; }
    else if (c === '{') { const j = g.indexOf('}', i); re += '(?:' + g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$');
}
const globMatch = (glob, p) => globToRegExp(glob).test(p);

// Numeric literals in source text (1,000 and 5_000 forms included), as numbers.
function numbersIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?<![\w.])(\d{1,3}(?:[,_]\d{3})+|\d+)(\.\d+)?(?![\w])/g)) out.add(Number((m[1] + (m[2] || '')).replace(/[,_]/g, '')));
  return out;
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const base = (p) => p.split('/').pop();

module.exports = { readText, linesOf, compareRules, idNum, wrap, globToRegExp, globMatch, numbersIn, plural, cell, base };
