'use strict';
// Stage 4: critical tags from fixed word lists, so every run and every repository tags the same way.
// Strong words tag on their own; weak words only when a strong word of the same area is in the same sentence.
// A decision that restates a requirement takes that requirement's tag. The model may add a tag only with a reason.
const AREAS = [
  { area: 'money', strong: ['price', 'pricing', 'premium', 'fee', 'charge', 'discount', 'refund', 'payment', 'excess', 'tax', 'currency', 'invoice'], weak: ['rate', 'cost', 'total', 'amount'] },
  { area: 'access control', strong: ['authenticate', 'authentication', 'authorization', 'role', 'permission', 'admin', 'session', 'login'], weak: ['token', 'user'] },
  { area: 'customer data', strong: ['personal data', 'customer record', 'retention', 'deletion', 'consent'], weak: ['store', 'keep', 'profile'] },
  { area: 'outside calls', strong: ['gateway', 'CRM', 'webhook', 'HTTP client', 'queue', 'external service'], weak: ['call', 'send', 'sync'] },
];
const SECRETS = { area: 'secrets', strong: ['key', 'password', 'secret', 'credential'], weak: ['token'] };
const AREA_RANK = Object.fromEntries(AREAS.map((a, i) => [a.area, i]));

const wordRe = (w) => new RegExp(`(?<![A-Za-z])${w.replace(/ /g, '[\\s-]+')}(?:s|es)?(?![A-Za-z])`, 'i');

// Earliest strong match in "title. text"; weak words only count with a strong word of the same area in the sentence.
function tagText(s, areas = AREAS) {
  let best = null;
  for (const a of areas) for (const w of a.strong) {
    const m = wordRe(w).exec(s);
    if (m && (!best || m.index < best.index)) best = { area: a.area, word: w, index: m.index };
  }
  return best && { area: best.area, word: best.word };
}

function tagRules(rules) {
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const r of rules) if (r.kind === 'requirement' || !r.restates) r.critical = tagText(`${r.title}. ${r.text}`);
  for (const r of rules) if (r.kind === 'decision' && r.restates) {
    const req = byId.get(r.restates);
    r.critical = req?.critical ? { ...req.critical, inherited: r.restates } : null;
  }
  for (const r of rules) if (!r.critical && r.aiTag?.area && r.aiTag?.reason) r.critical = { area: r.aiTag.area, reason: r.aiTag.reason, ai: true };
  return rules;
}

module.exports = { AREAS, SECRETS, AREA_RANK, tagText, tagRules };
