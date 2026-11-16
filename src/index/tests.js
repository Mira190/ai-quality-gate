'use strict';
// Stage 3, index: every test case in the repository, with the facts later stages need. Deterministic, per file, cached
// by content hash. Tests are read, never run.
//
// A test case record: its name (with the groups around it), where it is, whether it is skipped, how many assertions
// it holds, how many parameter rows it runs, the rule IDs it names and the words in it.
// A test file record: what the file needs to run. The level is read from what the test does (Google's test sizes:
// a small test stays in one process, a medium one talks to localhost, a large one drives the whole system), and
// separately from where the team put it. A disagreement between the two is a placement finding.
const path = require('node:path');
const { tokenize, uniq, sha, readText, pool } = require('../util');
const { idsIn } = require('../extract/rules');

const PARSER_VERSION = 6;
const LEVELS = ['unit', 'component', 'integration', 'e2e'];
const rank = (l) => LEVELS.indexOf(l);

const NEEDS = {
  e2e: /@playwright\/test|\bcy\.(visit|get|request|contains)\(|from ['"]cypress['"]|\bpuppeteer\b|selenium|webdriver|\bpage\.goto\(|\bbrowser\.(newPage|url|get)\(|\bdetox\b|\bappium\b|sync_playwright|async_playwright|chromedp|Capybara|testWidgets\(.*IntegrationTestWidgetsFlutterBinding|XCUIApplication/,
  integration: /\bsupertest\b|\brequest\(\s*app\s*\)|testcontainers|new PrismaClient|createConnection\(|mongoose\.connect|MongoMemoryServer|new (?:pg\.)?(?:Pool|Client)\(|\bknex\(|new Sequelize\(|new DataSource\(|create_engine\(|psycopg|TestClient\(|httptest\.NewServer|sql\.Open\(|@SpringBootTest|WebApplicationFactory|@Testcontainers|\blocalhost:\d+|127\.0\.0\.1|redis\.createClient|new Redis\(|amqplib|kafkajs|django\.test|APIClient\(|rails_helper|type:\s*:request|child_process|subprocess\.(run|Popen|check_)|exec\.Command\(|\bspawnSync\(|\bexecFileSync\(|\bexecSync\(|docker[- ]compose|@QuarkusTest|@MicronautTest|HttpClient\(|axios\.create\(\{\s*baseURL/,
  component: /@testing-library\/|\brender\(\s*<|\bmount\(|shallowMount\(|@vue\/test-utils|\benzyme\b|@WebMvcTest|@DataJpaTest|@JsonTest|TestBed\.|ComponentFixture|react-test-renderer|composeTestRule|pumpWidget\(/,
};
const MOCKS = /jest\.mock\(|vi\.mock\(|\bsinon\.|\bnock\(|\bmsw\b|jest\.fn\(|vi\.fn\(|jest\.spyOn\(|vi\.spyOn\(|mock\.method\(|mock\.fn\(|unittest\.mock|@patch\b|\bmocker\.|MagicMock|Mockito|@MockBean|@Mock\b|@MockK|\bmockk\(|gomock|testify\/mock|WireMock|\bresponses\.(add|activate)|httpretty|instance_double\(|\.to receive\(|new Mock<|NSubstitute|Substitute\.For|\bmock[A-Z]\w*\(|\bfake[A-Z]\w*\b|\bstub[A-Z]\w*\b|InMemory\w+/;
// Touching the real file system is a boundary a test crosses, without making it need more than one process.
const FS = /\bmkdtemp(Sync)?\(|os\.tmpdir\(|tempfile\.|\btmp_path\b|t\.TempDir\(|Files\.createTemp|@TempDir|Dir\.mktmpdir/;
const ASSERT = /\bexpect\s*\(|\bassert\w*\s*[.(]|^\s*assert\s|\.should\b|\bshould\.|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\(|\brequire\.\w+\(|\bverify\(|pytest\.raises|\bXCTAssert\w*\(|\bAssert\.\w+|\bassertThat\(|\.toThrow|^\s*(Then|And then)\b|\bexpectLater\(|\bcheck\(/;

/** @type {[string, RegExp][]} */
const DECLARED = [
  ['e2e', /(^|\/)(e2e|end[-_]to[-_]end|acceptance|cypress|playwright|ui[-_]tests?|system[-_]tests?|smoke|journeys)\/|\.(e2e|cy)\.[cm]?[jt]sx?$|[-_.]e2e[-_.]|\.feature$/i],
  ['integration', /(^|\/)(integration|integ|it|contract|api[-_]tests?|functional)\/|\.(int|integration|it)\.(test|spec)\.|(IT|ITCase|IntegrationTests?)\.(java|kt|groovy|cs)$|_integration_test\.|test_integration_|_integration_spec\./i],
  ['component', /(^|\/)component[-_]?tests?\/|\.component\.(test|spec)\./i],
  ['unit', /(^|\/)unit[-_]?(tests?)?\/|\.unit\.(test|spec)\.|UnitTests?\.(java|kt|cs)$/i],
];

function declaredLevel(p, levelGlobs = []) {
  for (const [level, match] of levelGlobs) if (match(p)) return level;
  return DECLARED.find(([, re]) => re.test(p))?.[0] || null;
}

const indentOf = (l) => { const m = /^[ \t]*/.exec(l)[0]; return m.replace(/\t/g, '    ').length; };
const firstString = (s) => /(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(s)?.[2];

/** Per-language recognisers: line → {type: 'case'|'group', name, skipped, params?} or null. */
const STARTS = {
  js(lines, i) {
    const m = /^\s*(?:(x|f)?(describe|context|suite|group)|(x|f)?(it|test|specify|testWidgets|scenario))((?:\.\w+)*)\s*(\(|`)/.exec(lines[i]);
    if (!m) return null;
    const mods = m[5] || '';
    const group = Boolean(m[2]) || /\.describe\b/.test(mods);
    const skipped = m[1] === 'x' || m[3] === 'x' || /\.(skip|todo|fixme)\b/.test(mods);
    const rest = lines[i].slice(m[0].length - 1);
    let params = 0, name, nameLine = null;
    if (/\.each\b/.test(mods) || m[6] === '`') {
      // it.each(table)('name', ...): the name follows the table, the table rows are the parameter rows
      let j = i, depthLine = null;
      for (; j < Math.min(lines.length, i + 40); j++) { const nm = /\)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(j === i ? rest : lines[j]); if (nm) { name = nm[2]; depthLine = j; nameLine = j; break; } }
      params = depthLine === null ? 2 : Math.max(2, depthLine > i ? depthLine - i - 1 : (rest.match(/\]\s*,|\}\s*,/g) || []).length + 1);
    } else name = firstString(rest);
    if (name === undefined) return null;
    return { type: group ? 'group' : 'case', name, skipped, params, at: nameLine ?? undefined };
  },
  python(lines, i) {
    const g = /^\s*class\s+(Test\w*|\w+Tests?)\b/.exec(lines[i]);
    const c = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(lines[i]);
    if (!g && !c) return null;
    // decorators above the function, which may span lines: walk up to the topmost "@" line of this block
    let top = i;
    for (let j = i - 1; j >= 0 && lines[j].trim() && !/^\s*(def|class|async def)\b/.test(lines[j]); j--) if (/^\s*@/.test(lines[j]) && indentOf(lines[j]) === indentOf(lines[i])) top = j;
    const deco = lines.slice(top, i);
    const d = deco.join('\n');
    const params = /parametrize/.test(d) ? Math.max(2, (d.match(/^\s*(\(|\[|pytest\.param)/gm) || []).length || (d.match(/\(/g) || []).length - 1) : 0;
    return { type: g ? 'group' : 'case', name: (g || c)[1], skipped: /@(pytest\.mark\.(skip|skipif|xfail)|unittest\.skip|skip\b)/.test(d), params, above: deco.length };
  },
  go(lines, i) {
    const m = /^func\s+(Test\w+)\s*\(/.exec(lines[i]);
    return m ? { type: 'case', name: m[1], skipped: false, go: true } : null;
  },
  java(lines, i) {
    if (!/^\s*@(Test|ParameterizedTest|RepeatedTest|TestFactory|Property)\b/.test(lines[i])) return null;
    let name, display, skipped = false, params = /ParameterizedTest|Property/.test(lines[i]) ? 2 : 0, at = i;
    let first = i;
    while (first > 0 && /^\s*@/.test(lines[first - 1])) first--;   // the annotations of this method only
    for (let j = first; j < Math.min(lines.length, i + 10); j++) {
      const l = lines[j];
      if (/@(Disabled|Ignore)\b/.test(l)) skipped = true;
      const dn = /@DisplayName\(\s*"((?:\\.|[^"\\])*)"/.exec(l); if (dn) display = dn[1];
      if (params && /@(ValueSource|CsvSource|EnumSource|MethodSource)/.test(l)) params = Math.max(2, (l.match(/"/g) || []).length / 2 | 0, (l.match(/,/g) || []).length + 1);
      const fn = j > i - 1 && /(?:void|fun|def)\s+`?([^`(]+?)`?\s*\(/.exec(l);
      if (fn && !/^\s*@/.test(l)) { name = fn[1].trim(); at = j; break; }
    }
    return name ? { type: 'case', name: display ? `${display} (${name})` : name, skipped, params, at } : null;
  },
  csharp(lines, i) {
    if (!/^\s*\[(Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b/.test(lines[i])) return null;
    if (i > 0 && /^\s*\[(Fact|Theory|Test|TestMethod|TestCase|DataTestMethod|InlineData|DataRow)\b/.test(lines[i - 1])) return null;
    let skipped = false, params = 0;
    for (let j = i; j < Math.min(lines.length, i + 30); j++) {
      const l = lines[j];
      if (/Skip\s*=|\[Ignore\b/.test(l)) skipped = true;
      if (/^\s*\[(InlineData|TestCase|DataRow)\b/.test(l)) params++;
      const fn = !/^\s*\[/.test(l) && /\b(\w+)\s*\(/.exec(l);
      if (fn) return { type: 'case', name: fn[1], skipped, params: params > 1 ? params : 0, at: j };
    }
    return null;
  },
  ruby(lines, i) {
    const m = /^\s*(x?)(describe|context|feature|RSpec\.describe)\s*\(?\s*(.+?)\s*(?:do\b|\{|$)/.exec(lines[i]);
    if (m) return { type: 'group', name: firstString(m[3]) ?? m[3].split(',')[0], skipped: m[1] === 'x' };
    const c = /^\s*(x?)(it|specify|scenario|example|test)\s*[( ]\s*(['"])(.+?)\3/.exec(lines[i]);
    return c ? { type: 'case', name: c[4], skipped: c[1] === 'x' || /\b(skip|pending):\s*true|:skip\b/.test(lines[i]) } : null;
  },
  rust(lines, i) {
    if (!/^\s*#\[(\w+::)?test\b/.test(lines[i])) return null;
    let skipped = false;
    for (let j = i; j < Math.min(lines.length, i + 6); j++) {
      if (/#\[ignore/.test(lines[j])) skipped = true;
      const fn = /\bfn\s+(\w+)\s*\(/.exec(lines[j]);
      if (fn) return { type: 'case', name: fn[1], skipped, at: j };
    }
    return null;
  },
  php(lines, i) {
    const m = /^\s*public\s+function\s+(\w+)\s*\(/.exec(lines[i]);
    if (!m || !(m[1].startsWith('test') || /@test\b|#\[Test\]/.test(lines.slice(Math.max(0, i - 6), i).join('\n')))) return null;
    return { type: 'case', name: m[1], skipped: false };
  },
  swift(lines, i) {
    const m = /^\s*(?:@Test.*\s)?func\s+(test\w*|\w+)\s*\(/.exec(lines[i]);
    return m && (m[1].startsWith('test') || /@Test/.test(lines[i]) || /@Test/.test(lines[i - 1] || '')) ? { type: 'case', name: m[1], skipped: false } : null;
  },
  gherkin(lines, i) {
    const f = /^\s*(Feature|功能):\s*(.+)$/.exec(lines[i]);
    const m = /^\s*(Scenario(?: Outline| Template)?|Example|场景|场景大纲):\s*(.+)$/.exec(lines[i]);
    if (!f && !m) return null;
    let tags = '', above = 0;
    for (let j = i - 1; j >= 0 && /^\s*@/.test(lines[j]); j--) { tags += ' ' + lines[j]; above++; }
    if (f) return { type: 'group', name: `${f[2].trim()}${tags}`, skipped: /@(skip|wip|ignore|pending|disabled)\b/i.test(tags), flat: true };
    let params = 0;
    for (let j = i + 1, ex = false; j < lines.length && !/^\s*(Scenario|Example:|Feature|场景)/.test(lines[j]); j++) {
      if (/^\s*(Examples|例子):/.test(lines[j])) { ex = true; params--; } else if (ex && /^\s*\|/.test(lines[j])) params++;
    }
    return { type: 'case', name: m[2].trim() + tags, skipped: /@(skip|wip|ignore|pending|disabled)\b/i.test(tags), params: Math.max(0, params), above };
  },
};
STARTS.dart = STARTS.js;

/** Parse one test file. Pure: the result depends only on the arguments, so it is cached by content hash. */
function parseTestFile(p, text, lang, idp) {
  const lines = text.split(/\r?\n/);
  const start = STARTS[lang];
  const cases = [], stack = [];
  const marks = [];
  if (start) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 2000) continue;
      const s = start(lines, i);
      if (s) marks.push({ ...s, line: i, indent: s.flat ? -1 : indentOf(lines[i]) });
    }
  }
  const firstMark = marks.length ? marks[0].line - (marks[0].above || 0) : lines.length;
  const headerIds = idsIn(lines.slice(0, Math.min(firstMark, 40)).filter((l) => /^\s*(\/\/|#|\*|\/\*|--|@)/.test(l)).join('\n'), idp);
  const classSkip = (lang === 'java' || lang === 'csharp') && /@(Disabled|Ignore)\b[^\n]*\n(\s*@[^\n]*\n)*\s*(public\s+|final\s+|abstract\s+|internal\s+|open\s+)*class\b/.test(text);

  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    while (stack.length && stack[stack.length - 1].indent >= m.indent) stack.pop();
    if (m.type === 'group') { stack.push(m); continue; }
    // the body runs to the next case or group that is not nested deeper, or to where the indentation closes
    const from = m.line - (m.above || 0);
    let end = lines.length - 1;
    for (let j = k + 1; j < marks.length; j++) if (marks[j].indent <= m.indent || marks[j].flat) { end = marks[j].line - (marks[j].above || 0) - 1; break; }
    // comment lines directly above the next test belong to that test
    while (end > (m.at ?? m.line) && /^\s*(\/\/|#|\/\*|\*)/.test(lines[end])) end--;
    const bodyStart = (m.at ?? m.line) + 1;
    for (let j = bodyStart; j <= end; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const ind = indentOf(l);
      if (lang === 'python' ? ind <= m.indent && !/^\s*[)\]]/.test(l) : ind < m.indent || (ind === m.indent && /^\s*[})\]]/.test(l) && lang !== 'gherkin')) { end = lang === 'python' || ind < m.indent ? j - 1 : j; break; }
    }
    end = Math.min(end, m.line + 600);
    const body = lines.slice(from, end + 1);
    const bodyText = body.join('\n');
    const name = [...stack.map((g) => g.name), m.name].join(' › ');
    let skipped = m.skipped || classSkip || stack.some((g) => g.skipped);
    if (m.go && /^\s*t\.Skip(f|Now)?\(/.test(lines[m.line + 1] || '')) skipped = true;
    if (lang === 'js' && /^\s*(test|it)\.(skip|fixme)\(\s*\)/.test(lines[m.line + 1] || '')) skipped = true;
    let params = m.params || 0;
    if (m.go) { const rows = (bodyText.match(/\bt\.Run\(/g) || []).length > 0 ? (bodyText.match(/^\s*\{\s*(name:|")/gm) || []).length : 0; params = rows > 1 ? rows : 0; }
    const nameTokens = uniq(tokenize(name));
    const nameSet = new Set(nameTokens);
    cases.push({
      name, line: from + 1, end: end + 1, skipped, params,
      asserts: body.reduce((n, l) => n + (ASSERT.test(l) ? 1 : 0), 0),
      ids: uniq(idsIn(`${name}\n${lines.slice(Math.max(0, from - 3), from).filter((l) => /^\s*(\/\/|#|\*|\/\*|@|--)/.test(l)).join('\n')}\n${bodyText}`, idp)),
      nt: nameTokens,
      bt: uniq(tokenize(bodyText)).filter((t) => !nameSet.has(t)).slice(0, 300),
    });
  }

  const needs = {};
  for (const [level, re] of Object.entries(NEEDS)) { const m = re.exec(text); if (m) needs[level] = m[0].slice(0, 40); }
  const observed = needs.e2e ? 'e2e' : needs.integration ? 'integration' : needs.component ? 'component' : lang === 'gherkin' ? 'e2e' : 'unit';
  const mock = MOCKS.exec(text);
  const imports = [];
  if (lang === 'js') for (const m of text.matchAll(/(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|^\s*import\s+)(['"])([^'"\n]+)\1/gm)) imports.push(m[2]);
  else if (lang === 'python') for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import\s+([\w, ]+)|import\s+([\w.]+))/gm)) { imports.push(m[1] || m[3]); if (m[1]) for (const n of m[2].split(',')) imports.push(`${m[1]}.${n.trim().split(' ')[0]}`); }
  return { lang, cases, headerIds, observed, why: needs[observed] || null, fs: FS.test(text), mock: mock ? mock[0].slice(0, 30) : null, imports: uniq(imports).slice(0, 80) };
}

/** Resolve a test file's imports to source files of the repository (one hop). Falls back to the naming convention. */
function resolveImports(file, rec, inventory) {
  const out = new Set();
  const dir = path.posix.dirname(file.path);
  const has = (p) => inventory.byPath.get(p)?.kind === 'source';
  if (rec.lang === 'js') {
    for (const spec of rec.imports) {
      if (!spec.startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(dir, spec)).replace(/\.(js|mjs|cjs)$/, '');
      for (const cand of [path.posix.normalize(path.posix.join(dir, spec)), ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js'].map((e) => base + e)]) if (has(cand)) { out.add(cand); break; }
    }
  } else if (rec.lang === 'python') {
    for (const spec of rec.imports) {
      const rel = spec.replace(/^\.+/, '').replace(/\./g, '/');
      for (const root of ['', 'src/', file.pkg ? file.pkg + '/' : '', file.pkg ? file.pkg + '/src/' : '']) for (const cand of [`${root}${rel}.py`, `${root}${rel}/__init__.py`]) if (has(cand)) out.add(cand);
    }
  } else if (rec.lang === 'go') {
    for (const f of inventory.dirIndex?.get(dir) || []) if (f.kind === 'source' && f.lang === 'go') out.add(f.path);
  }
  if (!out.size) {
    // FooTest.java → Foo.java, test_foo.py → foo.py, foo_spec.rb → foo.rb, foo.test.ts → foo.ts
    const base = path.posix.basename(file.path);
    const stem = base.replace(/\.[^.]+$/, '').replace(/^test_/, '').replace(/[._-]?(tests?|spec|it|itcase|e2e|int|integration|unit)$/i, '').replace(/(Tests?|IT|ITCase|Spec)$/, '');
    if (stem.length > 2) {
      const hits = (inventory.stemIndex?.get(stem.toLowerCase()) || []).filter((f) => f.lang === file.lang);
      const near = hits.filter((f) => f.pkg === file.pkg);
      for (const f of (near.length ? near : hits).slice(0, 3)) out.add(f.path);
    }
  }
  return [...out].sort();
}

/**
 * Returns {files: Array, cases: Array, skippedFiles: Array}. cases carry a stable key `path › name` and a short id.
 */
async function indexTests({ root, inventory, cache, config, idp }) {
  const tests = inventory.byKind.test || [];
  const levelGlobs = Object.entries(config.tests.levels || {}).filter(([l]) => LEVELS.includes(l)).map(([l, globs]) => [l, require('../util').matcher(globs)]);
  // lookups for import resolution, built once
  inventory.stemIndex = new Map(); inventory.dirIndex = new Map();
  for (const f of inventory.byKind.source || []) {
    const stem = path.posix.basename(f.path).replace(/\.[^.]+$/, '').toLowerCase();
    if (!inventory.stemIndex.has(stem)) inventory.stemIndex.set(stem, []);
    inventory.stemIndex.get(stem).push(f);
    const d = path.posix.dirname(f.path);
    if (!inventory.dirIndex.has(d)) inventory.dirIndex.set(d, []);
    inventory.dirIndex.get(d).push(f);
  }
  const cfgKey = sha(idp.src + PARSER_VERSION, 8);
  const skippedFiles = [];
  const records = await pool(tests, 16, async (f) => {
    const key = f.sha && `${f.sha}:${f.lang}:${cfgKey}`;
    let rec = key ? cache.get('tests', key) : undefined;
    if (!rec) {
      const text = readText(path.join(root, f.path), config.tests.max_kb * 1024 + 1);
      if (text === null) return null;
      if (Buffer.byteLength(text) > config.tests.max_kb * 1024) { skippedFiles.push({ path: f.path, why: `over ${config.tests.max_kb} KB` }); return null; }
      rec = parseTestFile(f.path, text, f.lang, idp);
      if (key) cache.set('tests', key, rec);
    }
    return rec;
  });
  const files = [], cases = [];
  tests.forEach((f, i) => {
    const rec = records[i];
    if (!rec || !rec.cases.length) return;
    const declared = declaredLevel(f.path, levelGlobs);
    // The level a test counts at is what it needs when that is known to be higher than its folder says, otherwise
    // what its folder says: a browser test filed under unit/ is still a browser test.
    const level = declared && rank(declared) >= rank(rec.observed) ? declared : rec.observed;
    const tf = { path: f.path, pkg: f.pkg, lang: rec.lang, declared, observed: rec.observed, level, why: rec.why, fs: rec.fs, mock: rec.mock, headerIds: rec.headerIds, imports: resolveImports(f, rec, inventory), cases: [] };
    for (const c of rec.cases) {
      const tc = { ...c, file: tf, key: `${f.path} › ${c.name}`, ids: uniq([...c.ids, ...rec.headerIds]) };
      tf.cases.push(tc); cases.push(tc);
    }
    files.push(tf);
  });
  return { files, cases, skippedFiles };
}

module.exports = { indexTests, parseTestFile, resolveImports, declaredLevel, LEVELS, rank, ASSERT };
