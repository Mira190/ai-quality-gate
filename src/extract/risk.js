'use strict';
// What a rule is about, decided by word lists: its risk areas (a rule in one is critical), its nature (which test
// level can prove it at the lowest cost) and the limits it states (the boundary values a test must exercise).
// Word lists are crude, and that is the point: the same text gets the same tags on every run, in any repository,
// for free. A team tunes them in .quality-gate.yml (risk.extra_terms, risk.critical_ids).

const AREAS = {
  money: /\b(pric(?:e|es|ing)|premiums?|fees?|charg(?:e|es|ed|ing)|discounts?|refunds?|payments?|pay(?:s|ing)?|paid|invoic(?:e|es|ing)|tax(?:es)?|currenc(?:y|ies)|billing|balances?|credits?|debits?|payouts?|surcharges?|vouchers?|coupons?)\b|价格|金额|支付|付款|退款|折扣|费用|账单|余额|计费|税/i,
  auth: /\b(authenticat\w*|authori[sz]\w*|permissions?|roles?|admins?|administrators?|log(?:s|ged)? ?in|login|sign(?:s|ed)? ?in|passwords?|sessions?|access control|privileges?|2fa|mfa|oauth|sso|api keys?|tokens?|tenants?)\b|登录|权限|认证|鉴权|授权|密码|会话|租户/i,
  data: /\b(personal data|pii|gdpr|customer (?:data|records?)|retention|retain(?:ed|s)?|delet(?:e|ed|es|ion)|consent|encrypt\w*|privacy|anonymi[sz]\w*|audit (?:log|trail))\b|个人信息|隐私|删除|保留期|加密|脱敏|审计/i,
  external: /\b(gateways?|webhooks?|third[- ]party|external (?:service|api|system)s?|crm|queues?|message broker|idempoten\w*|retr(?:y|ies|ied)|time ?outs?|circuit breaker|rate limit\w*)\b|外部系统|第三方|回调|重试|超时|幂等|限流/i,
  safety: /\b(data loss|corrupt\w*|irreversibl\w*|migrations?|roll ?backs?|double[- ](?:charge|spend|booking)|race condition)\b|数据丢失|回滚|迁移|重复扣款/i,
};
const MARKED = /\[(?:critical|p0)\]|\(critical\)|\bcriticality:\s*(?:high|critical)\b|【关键】/i;

/** @type {[string, RegExp][]} */
const NATURE = [
  // Order matters: the first list that matches names the lowest test level that can prove the rule.
  ['flow', /\b(end[- ]to[- ]end|journey|user flow|checkout flow|sign[- ]?up flow|across (?:services|pages)|whole flow)\b|全流程|端到端/i],
  ['ui', /\b(pages?|screens?|buttons?|click(?:s|ed|ing)?|display(?:s|ed)?|shown?|visible|hidden|forms?|modals?|dialogs?|navigat\w*|redirect\w*|render\w*|tooltips?|banners?|dropdowns?)\b|页面|按钮|点击|显示|弹窗|跳转|表单/i],
  ['boundary', /\b(databases?|db|persist\w*|stor(?:e|es|ed|age)|saved?|queues?|webhooks?|gateways?|https?|endpoints?|apis?|(?:http|api) requests?|status codes?|retr(?:y|ies|ied)|time ?outs?|cach(?:e|ed|ing)|e-?mails?|sms|third[- ]party|external|crm|event[- ]log|publish\w*|subscrib\w*|transactions?|migrations?|sent?|sends?|exit codes?|command line|child process(?:es)?|file system|on disk)\b|数据库|接口|外部|超时|重试|缓存|邮件|短信|消息队列|持久化|子进程|命令行|退出码|文件系统/i],
];
const LOWEST = { logic: 'unit', ui: 'component', boundary: 'integration', flow: 'e2e' };

const COMPARATOR = '(?:at most|at least|up to|no more than|not exceed(?:s|ing)?|never exceeds?|exceeds?|maximum(?: of)?|minimum(?: of)?|max\\.?|min\\.?|within|after|under|over|below|above|less than|more than|greater than|fewer than|from|to|≤|>=|<=|≥|<|>|不超过|至少|最多|最少|超过|少于|大于|小于|不少于|不大于)';
const UNIT = '(?:%|percent|ms|milliseconds?|secs?|seconds?|mins?|minutes?|hours?|hrs?|days?|weeks?|months?|years?|kb|mb|gb|items?|characters?|chars?|times|attempts?|retries|requests?|digits?|s|天|秒|分钟|小时|次|个|元|条|位)';
const LIMIT = new RegExp(`(?:(${COMPARATOR})\\s*)?([$€£¥]?)(?<![\\w.-])(\\d[\\d,]*(?:\\.\\d+)?)(?:\\s?(${UNIT})(?![a-z]))?`, 'gi');

/** Limits stated in a text: [{value, unit, raw}]. A bare number with no comparator, unit or currency is not a limit. */
function limitsOf(text) {
  const out = [], seen = new Set();
  for (const m of String(text).matchAll(LIMIT)) {
    const [raw, cmp, cur, num, unit] = m;
    if (!cmp && !cur && !unit) continue;
    const value = num.replace(/,/g, '').replace(/\.$/, '');
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, unit: (unit || (cur ? cur : '')).toLowerCase(), raw: raw.trim() });
  }
  return out.slice(0, 6);
}

/** Does a test body exercise the limit? The number itself, or its fraction for a percentage (20% → 0.2). */
function exercisesLimit(body, limit) {
  const forms = [limit.value];
  if (limit.value.length > 3 && /^\d+$/.test(limit.value)) forms.push(limit.value.replace(/\B(?=(\d{3})+$)/g, '_'), limit.value.replace(/\B(?=(\d{3})+$)/g, ','));
  if (limit.unit === '%' || limit.unit === 'percent') { const f = String(Number(limit.value) / 100); forms.push(f, f.replace(/^0\./, '.')); }
  return forms.some((f) => new RegExp(`(?<![\\d.])${f.replace(/[.]/g, '\\.')}(?![\\d])`).test(body));
}

function tagRule(rule, config = {}) {
  const text = `${rule.title} ${rule.text}`;
  const tags = [];
  for (const [area, re] of Object.entries(AREAS)) {
    const m = re.exec(text);
    if (m) { tags.push({ area, word: m[0].toLowerCase() }); continue; }
    const extra = (config.risk?.extra_terms?.[area] || []).find((w) => text.toLowerCase().includes(String(w).toLowerCase()));
    if (extra) tags.push({ area, word: String(extra).toLowerCase() });
  }
  if (MARKED.test(text) || (config.risk?.critical_ids || []).some((id) => String(id).toUpperCase() === rule.id.toUpperCase())) tags.push({ area: 'marked', word: 'critical' });
  rule.tags = tags;
  rule.critical = tags.length > 0;
  rule.nature = NATURE.find(([, re]) => re.test(text))?.[0] || 'logic';
  rule.lowest = LOWEST[rule.nature];
  rule.limits = limitsOf(rule.text);
  return rule;
}

module.exports = { tagRule, limitsOf, exercisesLimit, LOWEST, AREAS };
