'use strict';
// Vote thresholds from labelled data, with a precision guarantee (Learn then Test, Angelopoulos et al., arXiv
// 2110.01052). Unanimous votes are not proof of correctness (correlated errors: arXiv 2506.07962), so the vote agreement a
// model judgment needs before it may block is measured, not guessed.
//
// For one check: findings with their vote agreement (0..1) and whether gold marks them correct. Thresholds are tested
// strictest first (fixed-sequence testing, no multiplicity correction needed). At each threshold, H0 is "precision of
// the findings at or above it ≤ target", tested with an exact binomial tail. The answer is the loosest threshold whose
// H0 is rejected at level delta, before the first one that is not; null when even unanimous findings are not precise
// enough (the check should not block on model votes at all: put it on probation).

// log n! by summation (n is small: findings of one check)
const logFact = (() => { const c = [0]; return (n) => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n]; }; })();
const logChoose = (n, k) => logFact(n) - logFact(k) - logFact(n - k);

/** P(X ≥ k) for X ~ Binomial(n, p). */
function binomTail(n, k, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}

/**
 * pairs: [{ agreement, correct }] → { threshold, table: [{ threshold, n, correct, precision, pValue, rejected }] }
 */
function calibrate(pairs, { target = 0.9, delta = 0.1 } = {}) {
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const levels = [...new Set(pairs.map((p) => r3(p.agreement)))].sort((a, b) => b - a);
  const table = [];
  let threshold = null, open = true;
  for (const t of levels) {
    const sub = pairs.filter((p) => r3(p.agreement) >= t), k = sub.filter((p) => p.correct).length;
    const pValue = binomTail(sub.length, k, target);
    const rejected = pValue <= delta;
    table.push({ threshold: t, n: sub.length, correct: k, precision: sub.length ? k / sub.length : 0, pValue, rejected });
    if (open && rejected) threshold = t; else open = false;
  }
  return { threshold, table };
}

module.exports = { calibrate, binomTail };
