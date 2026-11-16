'use strict';
// How a rule in a document and a test in the code are brought to the same words. Three layers, none of which knows
// anything about a particular repository: they are facts about English and about how programmers write.
//
//   1. word families     walk, walked, walking, walker · configure, configuration, configurable · valid, validate,
//                        validation, validator: one stem each (inflection, then the common derivations).
//   2. short forms       what code abbreviates and prose spells out: msg / message, cfg / configuration.
//                        Only short forms with one usual meaning in software: "res" (response, result, resource) and
//                        "req" (request, requirement) are left out on purpose.
//   3. ideas             the things tests check, each named in many ways and from both sides: "never twice" and
//                        "once", "nothing is lost" and "keeps", "rejects" and "is not allowed". A word of an idea
//                        also yields the idea as a token ("=once").
//
// Rules for changing this file, so that it stays general:
//   - add a word because of what it means in software at large, never because one repository's test was missed;
//   - a word belongs to one idea (tests/unit/lexicon.test.js fails on a word in two);
//   - an idea match is a hint and is weighed as one: half a word when candidates are ranked (trace/link.js);
//   - tests/fixtures/paraphrases.js holds rule/test pairs from unrelated domains; a change must not lower its score.

/** Short form → the word it stands for. Unambiguous in software, or left out. */
const SHORT_FORMS = {
  // messaging and data
  ack: 'acknowledge', nack: 'reject', msg: 'message', evt: 'event', notif: 'notification', recv: 'receive', rcv: 'receive', resp: 'response',
  db: 'database', tbl: 'table', col: 'column', rec: 'record', idx: 'index', txn: 'transaction', tx: 'transaction', seq: 'sequence',
  // configuration and environment
  cfg: 'configuration', config: 'configuration', conf: 'configuration', env: 'environment', opt: 'option', opts: 'option', param: 'parameter', params: 'parameter',
  arg: 'argument', args: 'argument', pref: 'preference', prefs: 'preference', init: 'initialize', cmd: 'command', ver: 'version', rev: 'revision',
  // identity and access
  pwd: 'password', passwd: 'password', cred: 'credential', creds: 'credential', perms: 'permission', cert: 'certificate', tok: 'token', sess: 'session',
  acct: 'account', usr: 'user', org: 'organization', admin: 'administrator', id: 'identifier', addr: 'address',
  // numbers and measures
  max: 'maximum', min: 'minimum', num: 'number', avg: 'average', cnt: 'count', len: 'length', qty: 'quantity', amt: 'amount', pct: 'percent',
  sec: 'second', secs: 'second', ms: 'millisecond', hr: 'hour', hrs: 'hour', freq: 'frequency', approx: 'approximate', est: 'estimate',
  // code structure
  fn: 'function', func: 'function', obj: 'object', str: 'string', bool: 'boolean', char: 'character', val: 'value', var: 'variable', attr: 'attribute',
  pkg: 'package', lib: 'library', repo: 'repository', src: 'source', dest: 'destination', dst: 'destination', impl: 'implementation', util: 'utility', utils: 'utility',
  mgr: 'manager', svc: 'service', srv: 'server', conn: 'connection', hdr: 'header', ctx: 'context', iter: 'iteration', alloc: 'allocate',
  // actions
  del: 'delete', rm: 'remove', upd: 'update', ins: 'insert', calc: 'calculate', exec: 'execute', cmp: 'compare', dup: 'duplicate', dedup: 'duplicate',
  dedupe: 'duplicate', sync: 'synchronize', async: 'asynchronous', sched: 'schedule', nav: 'navigate', auth: 'authenticate', authn: 'authenticate', authz: 'authorize',
  // state and outcome
  err: 'error', prev: 'previous', tmp: 'temporary', info: 'information', stat: 'statistic', stats: 'statistic', perf: 'performance', mem: 'memory',
  diff: 'difference', pos: 'position', coord: 'coordinate', lang: 'language', img: 'image', pic: 'picture', doc: 'document', docs: 'document',
  btn: 'button', lvl: 'level', grp: 'group', tz: 'timezone', ttl: 'expire', expiry: 'expire', eq: 'equal',
  i18n: 'internationalization', l10n: 'localization', a11y: 'accessibility',
};

/** Idea → the words that name it, from either side. Whole words; their families follow from the stemmer. */
const IDEAS = {
  // how many times
  once: 'once twice duplicate repeat again idempotent exactly single unique distinct redeliver replay retransmit double resend',
  // nothing goes missing
  lost: 'lost lose loss keep kept survive durable retain preserve intact leak orphan',
  // the process or a dependency goes away
  crash: 'crash die dead kill restart reboot recover outage interrupt abort panic unavailable failover resume offline disconnect reconnect',
  // saying no
  refuse: 'refuse reject deny forbid forbidden disallow block prevent prohibit ban decline unauthorized',
  allow: 'allow accept permit grant approve',
  valid: 'valid invalid malformed illegal legal correct incorrect wellformed sanitize wrong',
  // bounds
  limit: 'limit cap maximum minimum exceed most least bound threshold quota range ceiling floor overflow underflow truncate clamp upper lower capacity budget cutoff',
  // before and after
  order: 'order sort sequence first last before after earlier later follow precede ascending descending chronological priority rank next previous oldest newest',
  // time
  wait: 'wait delay debounce throttle pause timeout expire deadline schedule interval period elapsed duration timer defer postpone stale fresh',
  retry: 'retry reattempt backoff attempt redo',
  // lifecycle of a thing
  remove: 'delete remove purge erase clear destroy discard evict revoke unlink wipe',
  create: 'create add insert new make generate register provision spawn',
  change: 'update modify change edit patch mutate replace overwrite rename alter upsert',
  undo: 'undo rollback revert restore reset',
  // lifecycle of a process
  start: 'start begin launch boot open initialize startup setup',
  stop: 'stop end finish shutdown close terminate exit quit complete done cancel teardown',
  toggle: 'enable disable toggle activate deactivate switch',
  fallback: 'default fallback preset implicit otherwise standby',
  // what a person sees
  show: 'show display render visible appear print list present view reveal expose',
  hide: 'hide hidden invisible secret mask redact conceal private confidential obscure omit strip',
  // outcomes
  error: 'error fail failure throw exception fault raise',
  empty: 'empty none zero nothing blank absent null missing nil undefined',
  same: 'same equal identical match differ different mismatch unchanged consistent inconsistent',
  // where data goes
  store: 'store save persist write disk database record log commit flush journal snapshot backup archive',
  send: 'send deliver post publish emit notify dispatch push broadcast forward transmit reply respond answer',
  receive: 'receive fetch read pull consume subscribe listen poll ingest incoming inbound',
  transfer: 'import export upload download attach',
  convert: 'parse serialize deserialize encode decode format convert transform marshal normalize escape',
  find: 'search find filter query lookup select',
  // who may
  auth: 'login logout signin signout signup lockout authenticate authorize credential password permission role privilege access identity',
  secure: 'encrypt decrypt hash signature tamper inject forge spoof',
  // at the same time
  concurrent: 'concurrent parallel race lock mutex simultaneous atomic deadlock contention interleave',
  // money
  money: 'price cost fee charge pay refund discount tax invoice balance amount currency',
  // how fast
  speed: 'fast slow quick latency performance speed throughput responsive',
};

// ---------------------------------------------------------------------------------------------------- word families

/** @type {[RegExp, string][]} */
const DERIVATIONS = [
  // [ending, what replaces it]: nouns and adjectives back to the verb or root they come from
  [/ification$/, 'ify'], [/(?:is|iz)ation$/, 'iz'], [/ator$/, ''], [/ation$/, ''], [/tion$/, 't'],
  [/ability$/, ''], [/ibility$/, 'ibl'], [/(ist|end)ency$/, '$1'], [/(ist|fer|end)ent$/, '$1'], [/(?:a|e)nce$/, ''],
  [/ment$/, ''], [/ness$/, ''], [/able$/, ''], [/(ov|iv|ev|ew|us|ss)al$/, '$1'], [/ity$/, ''], [/ful$/, ''],
];

/** The stem of a word's family. Crude on purpose: both sides go through it, so only families matter. */
function family(w) {
  let s = w;
  // plural
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && /(s|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  // verb forms and the one who does it
  let verbal = false;
  if (s.length > 4 && s.endsWith('ied')) { s = s.slice(0, -3) + 'y'; verbal = true; }
  else if (s.length > 5 && s.endsWith('ing')) { s = s.slice(0, -3); verbal = true; }
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) { s = s.slice(0, -2); verbal = true; }
  // derivations, twice: "successfully" → "successful" → "success"
  if (s.length > 6 && s.endsWith('ly')) s = s.slice(0, -2);
  for (let pass = 0; pass < 2; pass++) {
    for (const [re, to] of DERIVATIONS) {
      if (!re.test(s)) continue;
      const t = s.replace(re, to);
      if (t.length >= 4) { s = t; break; }
    }
  }
  // the one who does it, after the derivations: differ, different and difference end in the same place
  if (s.length > 5 && s.endsWith('er')) { s = s.slice(0, -2); verbal = true; }
  // -ise and -ize are one spelling; -ate is the verb of -ation
  if (s.length > 5 && /i[sz]e$/.test(s)) s = s.slice(0, -3) + 'iz';
  else if (verbal && s.length > 5 && s.endsWith('is')) s = s.slice(0, -2) + 'iz';
  if (s.length > 6 && s.endsWith('ate')) s = s.slice(0, -3);
  else if (verbal && s.length > 5 && s.endsWith('at')) s = s.slice(0, -2);
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 4 && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ss|ll|ff)$/.test(s)) s = s.slice(0, -1);   // stopp → stop
  return s;
}

// Forms no rule derives: the irregular verbs of everyday test names ("sent once", "kept after a restart").
const IRREGULAR = {
  sent: 'send', kept: 'keep', lost: 'lose', paid: 'pay', payment: 'pay', made: 'make', wrote: 'write', written: 'write', ran: 'run', took: 'take', taken: 'take',
  gave: 'give', given: 'give', held: 'hold', sold: 'sell', bought: 'buy', built: 'build', found: 'find', began: 'begin', begun: 'begin', chose: 'choose', chosen: 'choose',
  threw: 'throw', thrown: 'throw', broke: 'break', broken: 'break', hidden: 'hide', hid: 'hide', shown: 'show', showed: 'show', known: 'know', knew: 'know', got: 'get',
  gotten: 'get', left: 'leave', met: 'meet', read: 'read', said: 'say', seen: 'see', saw: 'see', told: 'tell', went: 'go', gone: 'go', woke: 'wake', woken: 'wake',
  won: 'win', fell: 'fall', fallen: 'fall', grew: 'grow', grown: 'grow', drew: 'draw', drawn: 'draw', led: 'lead', fed: 'feed', sped: 'speed', spent: 'spend',
  bound: 'bind', caught: 'catch', brought: 'bring', thought: 'think', sought: 'seek', froze: 'freeze', frozen: 'freeze', forgot: 'forget', forgotten: 'forget',
  children: 'child', people: 'person', indices: 'index', criteria: 'criterion', data: 'data', media: 'media',
};

const SHORT = new Map();
for (const [short, long] of Object.entries(SHORT_FORMS)) SHORT.set(short, family(long));

/**
 * One token for a word: the stem of its family, of the word an irregular form belongs to, or of the word a short
 * form stands for. A short form is recognised as written (and in the plural), never by its stem: "state" is not "stat".
 */
function stem(w) {
  if (SHORT.has(w)) return SHORT.get(w);
  if (w.length > 2 && w.endsWith('s') && SHORT.has(w.slice(0, -1))) return SHORT.get(w.slice(0, -1));
  if (IRREGULAR[w]) return family(IRREGULAR[w]);
  if (w.length > 3 && w.endsWith('s') && IRREGULAR[w.slice(0, -1)]) return family(IRREGULAR[w.slice(0, -1)]);
  return family(w);
}

// Verb and particle written apart are the compound written together: "times out" is "timeout", "logged in" is
// "login", "rolls back" is "rollback". A list of established compounds, not a rule: "set out" is not "setout".
const COMPOUNDS = ['time out', 'log in', 'log out', 'sign in', 'sign out', 'sign up', 'shut down', 'roll back', 'fall back', 'back off', 'fail over', 'look up',
  'set up', 'clean up', 'start up', 'check out', 'cut off', 'opt in', 'opt out', 'read only', 'write only', 'stand by', 'tear down', 'lock out', 'scale up', 'scale down'];
const COMPOUND_RE = COMPOUNDS.map((c) => { const [v, p] = c.split(' '); return [new RegExp(`\\b${v.replace(/e$/, '')}(?:e|es|s|d|ed|${v.slice(-1)}ed|ing|${v.slice(-1)}ing)?[ -]${p}\\b`, 'gi'), v + p]; });
/** Join the established verb-and-particle compounds of a text. */
const joinCompounds = (text) => COMPOUND_RE.reduce((t, [re, to]) => t.replace(re, ` ${to} `), text);

const IDEA_OF = new Map();
const IDEA_WORDS = new Set();
for (const [idea, words] of Object.entries(IDEAS)) for (const w of words.split(' ')) { IDEA_WORDS.add(w); if (!IDEA_OF.has(stem(w))) IDEA_OF.set(stem(w), `=${idea}`); }
const ideaOf = (stemmed) => IDEA_OF.get(stemmed) || null;

module.exports = { SHORT_FORMS, IDEAS, IRREGULAR, COMPOUNDS, stem, family, ideaOf, joinCompounds, IDEA_WORDS };
