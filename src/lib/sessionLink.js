// @module lib/sessionLink — build/parse deep links that resume a session.
//
// Link shape:
//   <scheme>://<publisher>.<extension>/resume?agent=<id>&session=<id>&cwd=<abs>&title=<label>
//
// The scheme is whatever editor the user runs (`vscode.env.uriScheme` —
// 'vscode', 'vscodium', 'cursor', …), so a link copied from VSCodium opens in
// VSCodium. The authority MUST be the extension id or VS Code will not route
// the URI to our handler.
//
// Pure functions only — no `vscode` require — so the round-trip is unit
// testable and the handler side can stay thin.

const KNOWN_AGENTS = new Set([
  'claude', 'kiro', 'antigravity', 'codex', 'grok', 'gjc', 'chief',
]);

const RESUME_PATH = '/resume';

// Session ids are file-name-ish (uuid, kiro id, gjc stem). Reject anything with
// a path separator or control char — those are the shapes that could escape a
// directory when threaded into `--resume-id` / a rollout path.
const SESSION_ID_RE = /^[A-Za-z0-9._@:+-]{1,200}$/;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

function isKnownAgent(agent) {
  return typeof agent === 'string' && KNOWN_AGENTS.has(agent);
}

/**
 * Build a resume deep link.
 * @param {{scheme?:string, extensionId?:string, sessionId:string, agent?:string, cwd?:string, title?:string}} o
 * @returns {string|null} the link, or null when the required parts are missing.
 */
function buildSessionLink(o) {
  const opts = o || {};
  const sessionId = opts.sessionId;
  if (!isValidSessionId(sessionId)) return null;

  const scheme = opts.scheme || 'vscode';
  const extensionId = opts.extensionId || 'rockuen.cli-launcher-for-claude';

  const params = [];
  const agent = isKnownAgent(opts.agent) ? opts.agent : 'claude';
  params.push('agent=' + encodeURIComponent(agent));
  params.push('session=' + encodeURIComponent(sessionId));
  if (opts.cwd) params.push('cwd=' + encodeURIComponent(opts.cwd));
  if (opts.title) params.push('title=' + encodeURIComponent(String(opts.title).slice(0, 200)));

  return `${scheme}://${extensionId}${RESUME_PATH}?${params.join('&')}`;
}

// Minimal query parser — `URLSearchParams` would do, but a hand-rolled split
// keeps this working on a plain `{path, query}` object (what vscode.Uri hands
// the handler) without constructing a URL.
function _parseQuery(query) {
  const out = {};
  for (const pair of String(query || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    let key, val;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    } catch (_) {
      continue; // malformed percent-escape — drop that pair, keep the rest
    }
    if (!(key in out)) out[key] = val;
  }
  return out;
}

/**
 * Parse a resume deep link.
 * @param {string|{path?:string, query?:string}} input a link string, or the
 *        `{path, query}` shape of a vscode.Uri.
 * @returns {{sessionId:string, agent:string, cwd:string|null, title:string|null}|null}
 */
function parseSessionLink(input) {
  let pathPart, queryPart;

  if (typeof input === 'string') {
    const s = input.trim();
    const schemeEnd = s.indexOf('://');
    if (schemeEnd === -1) return null;
    const rest = s.slice(schemeEnd + 3);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const afterAuthority = rest.slice(slash);
    const q = afterAuthority.indexOf('?');
    pathPart = q === -1 ? afterAuthority : afterAuthority.slice(0, q);
    queryPart = q === -1 ? '' : afterAuthority.slice(q + 1);
  } else if (input && typeof input === 'object') {
    pathPart = input.path || '';
    queryPart = input.query || '';
  } else {
    return null;
  }

  // Tolerate a trailing slash; anything else is not our route.
  const normalizedPath = pathPart.replace(/\/+$/, '') || '/';
  if (normalizedPath !== RESUME_PATH) return null;

  const q = _parseQuery(queryPart);
  const sessionId = q.session || q.sessionId || '';
  if (!isValidSessionId(sessionId)) return null;

  const agent = isKnownAgent(q.agent) ? q.agent : 'claude';
  const cwd = q.cwd ? q.cwd : null;
  const title = q.title ? q.title : null;

  return { sessionId, agent, cwd, title };
}

module.exports = {
  KNOWN_AGENTS,
  RESUME_PATH,
  isValidSessionId,
  isKnownAgent,
  buildSessionLink,
  parseSessionLink,
};
