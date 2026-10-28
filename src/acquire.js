'use strict';
// Stage 1: the target repository at a commit, and the documents given by URL.
// The token (TARGET_REPO_PAT, else GITHUB_TOKEN) is passed to git as an extra header, never in the URL or the log.
// Nothing from the target repository is executed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const token = () => process.env.TARGET_REPO_PAT || process.env.GITHUB_TOKEN || '';
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

function parseRepoUrl(url) {
  const m = String(url).trim().match(/^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2], name: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` } : null;
}

function clone(repoUrl, ref, into) {
  const r = parseRepoUrl(repoUrl);
  if (!r) throw new Error(`not a GitHub repository URL: ${repoUrl}`);
  const dir = into || fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-'));
  const auth = token() ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token()}`).toString('base64')}`] : [];
  git([...auth, 'clone', '--quiet', '--filter=blob:limit=2m', '--no-checkout', r.url, dir]);
  git(['-C', dir, ...auth, 'checkout', '--quiet', ref || 'HEAD']);
  return { root: dir, name: r.name, sha: git(['-C', dir, 'rev-parse', '--short=7', 'HEAD']), owner: r.owner, repo: r.repo };
}

// GitHub blob URLs become raw URLs; HTML pages are reduced to text. Returns {path, text} or {path, error}.
async function fetchDoc(url) {
  const raw = url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/');
  const headers = /githubusercontent\.com|api\.github\.com/.test(raw) && token() ? { authorization: `token ${token()}` } : {};
  try {
    const res = await fetch(raw, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { path: url, error: `HTTP ${res.status}` };
    let text = await res.text();
    if (/text\/html/.test(res.headers.get('content-type') || '')) text = htmlToText(text);
    return { path: url, text };
  } catch (e) { return { path: url, error: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
}

function htmlToText(html) {
  return html.replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `).replace(/<li[^>]*>/gi, '\n- ').replace(/<(p|div|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n');
}

async function branchProtection(name, branch) {
  if (!token()) return 'not readable';
  try {
    const res = await fetch(`https://api.github.com/repos/${name}/branches/${encodeURIComponent(branch)}/protection`, { headers: { authorization: `token ${token()}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return 'none';
    if (!res.ok) return 'not readable';
    const j = await res.json();
    const req = j.required_status_checks?.contexts || [];
    return req.length ? `requires ${req.join(', ')}` : 'no required checks';
  } catch { return 'not readable'; }
}

function defaultBranch(root) { try { return git(['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch { return 'main'; } }

module.exports = { clone, fetchDoc, parseRepoUrl, branchProtection, defaultBranch, htmlToText };
