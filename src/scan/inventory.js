'use strict';
// Stage 1, scan: list the repository and sort every path into a kind, by path alone. No file is read here.
// Later stages read only the kinds they need (documents, tests, CI files, manifests): on a large repository that is
// a few percent of the files, and the per-file results are cached by content hash.
const path = require('node:path');
const { matcher } = require('../util');

const VENDORED = /(^|\/)(node_modules|vendor|third_party|third-party|bower_components|Pods|dist|build|out|target|\.next|\.nuxt|coverage|\.venv|venv|__pycache__|\.gradle|\.terraform|__snapshots__|site-packages)(\/|$)/;
const GENERATED = /(\.min\.(js|css)|\.bundle\.js|\.pb\.go|_pb2(_grpc)?\.py|\.generated\.\w+|\.g\.(cs|dart)|\.snap|\.lock|-lock\.(json|yaml)|\.map|\.d\.ts)$/;

const LANG = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'python', go: 'go', java: 'java', kt: 'java', kts: 'java', groovy: 'java', scala: 'java',
  cs: 'csharp', rb: 'ruby', rs: 'rust', php: 'php', swift: 'swift', dart: 'dart', feature: 'gherkin',
};
const TS_EXT = new Set(['ts', 'tsx', 'mts', 'cts']);
const DOC_EXT = new Set(['md', 'mdx', 'rst', 'adoc', 'txt']);

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|integration|it|acceptance|features)(\/|$)/;
const IS_TEST = {
  js: (p, b) => /\.(test|spec|cy|e2e|it|int|integration)\.[cm]?[jt]sx?$/.test(b) || /(^|\/)__tests__\//.test(p) || (TEST_DIR.test(p) && !/(^|\/)(fixtures?|helpers?|support|mocks?|__mocks__|utils?|setup|factories|data)(\/|$)/.test(p) && !/\.(config|setup)\.[cm]?[jt]s$/.test(b)),
  python: (p, b) => /^test_.*\.py$/.test(b) || /_test\.py$/.test(b),
  go: (p, b) => b.endsWith('_test.go'),
  java: (p, b) => /(Tests?|IT|ITCase|Spec)\.(java|kt|groovy|scala)$/.test(b),
  csharp: (p, b) => /Tests?\.cs$/.test(b) || /Spec\.cs$/.test(b),
  ruby: (p, b) => /_(spec|test)\.rb$/.test(b),
  rust: (p) => /(^|\/)tests\/[^/]+\.rs$/.test(p),
  php: (p, b) => /Test\.php$/.test(b),
  swift: (p, b) => /Tests?\.swift$/.test(b),
  dart: (p, b) => /_test\.dart$/.test(b),
  gherkin: () => true,
};

/** @type {[RegExp, string][]} */
const CI_FILE = [
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'github'],
  [/^\.github\/actions\/.+\/action\.ya?ml$/, 'github-action'],
  [/^\.gitlab-ci\.ya?ml$/, 'gitlab'], [/^\.circleci\/config\.ya?ml$/, 'circleci'], [/(^|\/)Jenkinsfile[^/]*$/, 'jenkins'],
  [/^azure-pipelines[^/]*\.ya?ml$/, 'azure'], [/^bitbucket-pipelines\.ya?ml$/, 'bitbucket'], [/^\.buildkite\/[^/]+\.ya?ml$/, 'buildkite'],
  [/^\.travis\.ya?ml$/, 'travis'], [/^\.drone\.ya?ml$/, 'drone'],
];
const MANIFEST = /^(package\.json|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|noxfile\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Makefile|makefile|GNUmakefile|justfile|Taskfile\.ya?ml|Gemfile|Rakefile|composer\.json|[^/]+\.csproj|pubspec\.yaml|Package\.swift)$/;
// Tool configuration: its presence says the team chose the tool; CI decides whether the choice is enforced.
const TOOL_CONFIG = /^(\.?eslint(rc|\.config)[^/]*|biome\.jsonc?|tsconfig[^/]*\.json|jsconfig\.json|\.prettierrc[^/]*|prettier\.config\.[^/]+|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|\.golangci\.ya?ml|\.rubocop\.yml|rustfmt\.toml|clippy\.toml|\.editorconfig|\.pre-commit-config\.ya?ml|lefthook\.ya?ml|jest\.config\.[^/]+|vitest\.config\.[^/]+|playwright\.config\.[^/]+|cypress\.config\.[^/]+|karma\.conf\.[^/]+|\.mocharc[^/]*|pytest\.ini|conftest\.py|\.gitleaks\.toml|\.secrets\.baseline|codecov\.ya?ml|\.codecov\.ya?ml|\.nycrc[^/]*|\.c8rc[^/]*|sonar-project\.properties|\.semgrep\.ya?ml|renovate\.json5?|\.renovaterc[^/]*|\.stylelintrc[^/]*|phpstan\.neon[^/]*|\.swiftlint\.yml|detekt\.ya?ml|checkstyle\.xml|\.husky)$/;

/** Kind of a path, by the path alone. Returns a record with at least `kind`. */
function classify(p) /** @type {any} */ {
  const base = path.posix.basename(p);
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  for (const [re, system] of CI_FILE) if (re.test(p)) return { kind: 'ci', system };
  if (p === '.github/dependabot.yml' || p === '.github/dependabot.yaml') return { kind: 'config', tool: base };
  if (/^\.husky\//.test(p)) return { kind: 'config', tool: '.husky' };
  if (VENDORED.test(p)) return { kind: 'ignored', why: 'vendored' };
  if (TOOL_CONFIG.test(base)) return { kind: 'config', tool: base, lang: LANG[ext] };
  if (MANIFEST.test(base)) return { kind: 'manifest', name: base };
  if (GENERATED.test(base)) return { kind: 'ignored', why: 'generated' };
  const lang = LANG[ext];
  if (lang) {
    if (IS_TEST[lang]?.(p, base)) return { kind: 'test', lang, ts: TS_EXT.has(ext) };
    if (lang === 'java' && /(^|\/)src\/test\//.test(p)) return { kind: 'support', lang };
    return { kind: TEST_DIR.test(p) && lang !== 'go' ? 'support' : 'source', lang, ts: TS_EXT.has(ext) };
  }
  if (DOC_EXT.has(ext)) return { kind: 'doc', ext };
  if (ext === 'tla' || (ext === 'cfg' && /(^|\/)(specs?|tla|models?|formal)\//i.test(p))) return { kind: 'spec', ext };
  return { kind: 'other' };
}

/**
 * Returns {files: Array, byPath: Map, byKind: Object, packages: string[], langs: Object, stats: Object}.
 * A package is a directory with a manifest; every file belongs to the nearest one above it ('' is the root).
 */
function buildInventory(listed, config = {}) {
  const excluded = matcher(config.exclude || []);
  const forcedTest = matcher(config.tests?.include || []);
  const files = [], byPath = new Map(), byKind = {}, langs = {};
  const pkgDirs = new Set(['']);
  let ignored = 0;
  for (const f of listed) {
    if (excluded(f.path)) { ignored++; continue; }
    let c = classify(f.path);
    if (forcedTest(f.path) && c.lang) c = { ...c, kind: 'test' };
    if (c.kind === 'ignored') { ignored++; continue; }
    /** @type {any} */
    const rec = { path: f.path, sha: f.sha, ...c };
    files.push(rec);
    byPath.set(rec.path, rec);
    (byKind[c.kind] ||= []).push(rec);
    if (c.kind === 'manifest' && !/^(Makefile|makefile|GNUmakefile|justfile|Taskfile\.ya?ml|tox\.ini|setup\.cfg|noxfile\.py|Rakefile)$/.test(c.name)) pkgDirs.add(path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path));
    if ((c.kind === 'source' || c.kind === 'test') && c.lang !== 'gherkin') { langs[c.lang] = (langs[c.lang] || 0) + 1; if (c.ts) langs.ts = (langs.ts || 0) + 1; }
  }
  const packages = [...pkgDirs].sort();
  const pkgOf = (p) => {
    let d = path.posix.dirname(p);
    for (;;) {
      if (d === '.') return '';
      if (pkgDirs.has(d)) return d;
      d = path.posix.dirname(d);
    }
  };
  for (const f of files) f.pkg = pkgOf(f.path);
  const stats = { listed: listed.length, ignored };
  for (const k of Object.keys(byKind)) stats[k] = byKind[k].length;
  return { files, byPath, byKind, packages, langs, stats, pkgOf };
}

module.exports = { classify, buildInventory };
