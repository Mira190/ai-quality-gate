'use strict';
// A unified diff (git diff -U0 or with context) → per file: hunks with their removed and added lines, old and new line
// numbers. Renames keep the new path; deleted files keep the old path with no added lines.
function parseDiff(text) {
  const files = new Map();
  let cur = null, h = null, oldN = 0, newN = 0;
  for (const line of String(text || '').split('\n')) {
    let m;
    if (line.startsWith('diff --git ')) { cur = null; h = null; continue; }
    if ((m = /^--- (?:a\/)?(.+)$/.exec(line)) && !h?.open) { cur = { from: m[1] === '/dev/null' ? null : m[1].replace(/\t.*$/, ''), path: null, hunks: [] }; continue; }
    if ((m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)) && cur && !cur.path) {
      const p = m[1] === '/dev/null' ? cur.from : m[1].replace(/\t.*$/, '');
      cur.path = p; cur.deleted = m[1] === '/dev/null'; cur.added = cur.from === null;
      files.set(p, cur); continue;
    }
    if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)) && cur) {
      h = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], removed: [], added: [], open: true };
      cur.hunks.push(h); oldN = h.oldStart; newN = h.newStart; continue;
    }
    if (!h || !cur) continue;
    if (line.startsWith('-')) h.removed.push({ line: oldN++, text: line.slice(1) });
    else if (line.startsWith('+')) h.added.push({ line: newN++, text: line.slice(1) });
    else if (line.startsWith(' ')) { oldN++; newN++; }
    else if (line.startsWith('\\')) continue;
    if (oldN >= h.oldStart + h.oldLines && newN >= h.newStart + h.newLines) h.open = false;
  }
  for (const f of files.values()) for (const x of f.hunks) delete x.open;
  return files;
}

/** True when lines [from, to] of the new file were added or changed, or lines were removed between them. */
function touchesRange(file, from, to) {
  if (!file) return false;
  return file.hunks.some((h) => h.added.some((a) => a.line >= from && a.line <= to) || (h.removed.length && !h.added.length && h.newStart >= from && h.newStart <= to));
}

module.exports = { parseDiff, touchesRange };
