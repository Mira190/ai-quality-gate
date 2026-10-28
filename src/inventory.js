'use strict';
// The file list of the target repository: tracked files when it is a git checkout, else a directory walk.
// Vendored, generated and sample trees are skipped; they are not the team's code or documents.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|out|coverage|target|\.git|\.next|\.venv|venv|__pycache__|bower_components)(\/|$)/;
const MAX_FILES = 20000;

function listFiles(root) {
  let files;
  try {
    files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch { files = null; }
  if (!files || !files.length) {
    files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (SKIP.test(rel + (e.isDirectory() ? '/' : ''))) continue;
        if (e.isDirectory()) walk(rel); else if (e.isFile()) files.push(rel);
        if (files.length > MAX_FILES) return;
      }
    };
    walk('');
  }
  return files.filter((f) => !SKIP.test(f)).sort().slice(0, MAX_FILES);
}

const sizeOf = (root, rel) => { try { return fs.statSync(path.join(root, rel)).size; } catch { return 0; } };

module.exports = { listFiles, sizeOf, SKIP };
