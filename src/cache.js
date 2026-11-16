'use strict';
// A content-addressed store, kept between runs (actions/cache in CI, a directory on a developer's machine).
//   - "index" entries: what was parsed out of a file, keyed by the file's git blob hash. A pull request re-parses only
//     the files it changed.
//   - "verdict" entries: one model verdict per judged item, keyed by everything the model saw. The same input gets the
//     same verdict on every run, which is what makes a model-backed gate repeatable.
// Entries not touched for `keepRuns` runs are dropped, so the store follows the repository instead of growing.
const path = require('node:path');
const { readJson, writeAtomic } = require('./util');

const VERSION = 3;

class Cache {
  constructor(dir, { keepRuns = 20 } = {}) {
    this.dir = dir;
    this.keepRuns = keepRuns;
    this.spaces = {};
    this.stats = {};
    this.run = 0;
    if (dir) {
      const meta = readJson(path.join(dir, 'meta.json'));
      if (meta?.version === VERSION) this.run = meta.run || 0;
      else this.reset = true;
    }
    this.run++;
  }
  space(name) {
    if (!this.spaces[name]) {
      const data = this.dir && !this.reset ? readJson(path.join(this.dir, `${name}.json`), {}) : {};
      this.spaces[name] = { data: data && typeof data === 'object' ? data : {}, dirty: false };
      this.stats[name] = { hit: 0, miss: 0 };
    }
    return this.spaces[name];
  }
  get(name, key) {
    const s = this.space(name), e = s.data[key];
    if (!e) { this.stats[name].miss++; return undefined; }
    this.stats[name].hit++;
    if (e.r !== this.run) { e.r = this.run; s.dirty = true; }
    return e.v;
  }
  set(name, key, value) {
    const s = this.space(name);
    s.data[key] = { r: this.run, v: value };
    s.dirty = true;
  }
  save() {
    if (!this.dir) return;
    for (const [name, s] of Object.entries(this.spaces)) {
      if (!s.dirty && !this.reset) continue;
      const kept = {};
      for (const k of Object.keys(s.data).sort()) if (this.run - s.data[k].r < this.keepRuns) kept[k] = s.data[k];
      writeAtomic(path.join(this.dir, `${name}.json`), JSON.stringify(kept));
    }
    writeAtomic(path.join(this.dir, 'meta.json'), JSON.stringify({ version: VERSION, run: this.run }));
  }
}

module.exports = { Cache };
