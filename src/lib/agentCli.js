// @module lib/agentCli — the `cli-launcher` command that agents run inside a
// launcher tab, and the local IPC server the extension answers it on.
//
// Why a command and not an MCP server: every agent the launcher hosts (Claude
// Code, Codex, gjc, Kiro, Grok, Chief) has a shell tool that inherits the PTY's
// environment, so one command on PATH works in all of them with no per-agent
// registration and no tool schema riding along in every prompt.
//
// How "this session" is found: each PTY gets CLI_LAUNCHER_TAB (its panel's tab
// id), the IPC endpoint and a per-activation nonce. The command asks the
// extension, which knows the tab's live session id, including the ids Kiro /
// Codex / Grok / gjc assign only after their first transcript write.
//
// Env names avoid KEY / SECRET / TOKEN on purpose: Codex's default
// shell_environment_policy strips variables matching those words.
//
// Pure Node (net / crypto / fs only, no `vscode`) so the protocol, the server
// and the client run unchanged under node --test.

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildSessionLink, parseSessionLink, isValidSessionId, isKnownAgent, isSafeLinkCwd } = require('./sessionLink');

const { NOTIFY_EVENTS: NOTIFY_EVENTS_SET } = require('./agentNotify');

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_TITLE_LENGTH = 200;

const ENV = Object.freeze({
  IPC: 'CLI_LAUNCHER_IPC',
  NONCE: 'CLI_LAUNCHER_NONCE',
  TAB: 'CLI_LAUNCHER_TAB',
  AGENT: 'CLI_LAUNCHER_AGENT',
  CWD: 'CLI_LAUNCHER_CWD',
  SCHEME: 'CLI_LAUNCHER_URI_SCHEME',
  NODE: 'CLI_LAUNCHER_NODE',
});

class AgentCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---- endpoint + environment ----

function newNonce() {
  // 96 bits — enough for a same-user local pipe, short enough not to look like
  // a credential to the transcript secret scanners.
  return crypto.randomBytes(12).toString('hex');
}

/**
 * IPC endpoint for this extension host. Windows: a named pipe. Elsewhere: a
 * unix socket inside a per-user 0700 directory (see prepareSocketPath).
 */
function makeIpcPath(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const id = `${o.pid || process.pid}-${o.rand || crypto.randomBytes(4).toString('hex')}`;
  if (platform === 'win32') return `\\\\.\\pipe\\cli-launcher-${id}`;
  let user = 'u';
  try {
    user = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
  } catch (_) {}
  return path.join(o.tmpdir || os.tmpdir(), `cli-launcher-${user}`, `${id}.sock`);
}

function prepareSocketPath(ipcPath) {
  if (process.platform === 'win32' || ipcPath.startsWith('\\\\.\\pipe\\')) return;
  const dir = path.dirname(ipcPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // In a shared /tmp another user can create this name first. lstat, so a
  // symlink planted there is refused instead of followed (chmod would land on
  // its target).
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`socket directory ${dir} is not a plain directory`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`socket directory ${dir} belongs to another user`);
  }
  fs.chmodSync(dir, 0o700);
  try { fs.unlinkSync(ipcPath); } catch (_) {}
}

/** Drop CLI_LAUNCHER_* inherited from the editor's own environment (e.g. a
 *  window opened by `code .` from inside a tab), so a tab never points at
 *  another window's endpoint. Mutates `env`. */
function stripAgentCliEnv(env) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('CLI_LAUNCHER_')) delete env[key];
  }
  return env;
}

function pathKeys(env, platform) {
  const keys = Object.keys(env).filter((k) => (platform === 'win32' ? k.toUpperCase() === 'PATH' : k === 'PATH'));
  return keys.length ? keys : [platform === 'win32' ? 'Path' : 'PATH'];
}

/** PATH entries with `dir` in front (unchanged when it is already there). */
function prependPath(env, dir, platform) {
  const plat = platform || process.platform;
  const delimiter = plat === 'win32' ? ';' : ':';
  const same = (a, b) => (plat === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const out = {};
  for (const key of pathKeys(env, plat)) {
    const current = env[key] || '';
    const parts = current.split(delimiter).filter(Boolean);
    out[key] = parts.some((p) => same(p, dir)) ? current : [dir, ...parts].join(delimiter);
  }
  return out;
}

/**
 * Variables added to a tab's PTY environment.
 * @param {{ipcPath:string, nonce:string, tabId:string|number, agent?:string, cwd?:string,
 *          scheme?:string, nodeRuntime?:string, binDir?:string, platform?:string}} o
 * @param {Record<string,string>} baseEnv the environment the PTY would get otherwise
 */
function buildAgentCliEnv(o, baseEnv) {
  const out = {
    [ENV.IPC]: o.ipcPath,
    [ENV.NONCE]: o.nonce,
    [ENV.TAB]: String(o.tabId),
    [ENV.AGENT]: o.agent || 'claude',
    [ENV.CWD]: o.cwd || '',
    [ENV.SCHEME]: o.scheme || 'vscode',
  };
  if (o.nodeRuntime) out[ENV.NODE] = o.nodeRuntime;
  if (o.binDir) Object.assign(out, prependPath(baseEnv || {}, o.binDir, o.platform));
  return out;
}

// ---- wire format ----

function encodeMessage(obj) {
  return JSON.stringify(obj) + '\n';
}

function errorReply(code, message) {
  return { ok: false, code, error: message };
}

function sameNonce(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Authenticate and route one request. Never throws — failures become replies. */
async function dispatch(req, nonce, handlers) {
  if (!req || typeof req !== 'object') return errorReply('bad-request', 'malformed request');
  if (req.v !== PROTOCOL_VERSION) {
    return errorReply('version', `protocol ${req.v} not supported (expected ${PROTOCOL_VERSION}) — the launcher and this command come from different versions; restart the tab`);
  }
  if (!sameNonce(req.nonce, nonce)) {
    return errorReply('unauthorized', 'this tab was started by a different launcher session — restart the tab');
  }
  const handler = Object.prototype.hasOwnProperty.call(handlers, req.op) ? handlers[req.op] : null;
  if (typeof handler !== 'function') return errorReply('unknown-op', `unknown command: ${req.op}`);
  try {
    return { ok: true, result: await handler(req) };
  } catch (e) {
    if (e instanceof AgentCliError) return errorReply(e.code, e.message);
    return errorReply('internal', (e && e.message) || String(e));
  }
}

/**
 * One request per connection: a JSON line in, a JSON line out.
 * @returns {{listen:()=>Promise<void>, close:()=>void, server:net.Server}}
 */
function createAgentCliServer({ ipcPath, nonce, handlers }) {
  const server = net.createServer((sock) => {
    let buf = '';
    let done = false;
    // Set at the first newline: data arriving while a handler is still
    // running must not dispatch the same request again.
    let dispatched = false;
    const timer = setTimeout(() => sock.destroy(), REQUEST_TIMEOUT_MS);
    const reply = (obj) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.end(encodeMessage(obj));
    };
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('close', () => clearTimeout(timer));
    sock.on('data', (chunk) => {
      if (done || dispatched) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        if (Buffer.byteLength(buf) > MAX_REQUEST_BYTES) reply(errorReply('too-large', 'request too large'));
        return;
      }
      dispatched = true;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch (_) {
        reply(errorReply('bad-request', 'malformed request'));
        return;
      }
      dispatch(req, nonce, handlers).then(reply, (e) => reply(errorReply('internal', String(e))));
    });
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        try {
          prepareSocketPath(ipcPath);
        } catch (e) {
          reject(e);
          return;
        }
        server.once('error', reject);
        server.listen(ipcPath, () => {
          server.removeListener('error', reject);
          if (process.platform !== 'win32') {
            try { fs.chmodSync(ipcPath, 0o600); } catch (_) {}
          }
          resolve();
        });
      });
    },
    close() {
      try { server.close(); } catch (_) {}
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(ipcPath); } catch (_) {}
      }
    },
  };
}

/** Client side: send one request, resolve with the parsed reply. */
function sendRequest({ ipcPath, nonce, tab, op, args, hints, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const sock = net.connect(ipcPath);
    const timer = setTimeout(() => {
      sock.destroy();
      finish(reject, new AgentCliError('timeout', 'the launcher did not answer in time'));
    }, timeoutMs || REQUEST_TIMEOUT_MS);
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(encodeMessage({ v: PROTOCOL_VERSION, nonce, tab, op, args: args || {}, hints: hints || {} }));
    });
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => {
      try {
        finish(resolve, JSON.parse(buf.trim()));
      } catch (_) {
        finish(reject, new AgentCliError('bad-reply', 'the launcher sent an unreadable reply'));
      }
    });
    sock.on('error', (e) => finish(reject, new AgentCliError('unreachable', `cannot reach the launcher (${e.code || e.message})`)));
  });
}

// ---- session operations ----

// Agents whose real session id is known only after their first transcript
// write; the launcher holds a placeholder until then.
function isPinned(entry) {
  switch (entry.agent) {
    case 'kiro': return !!(entry._kiroPinned || entry.isKiroResume);
    case 'codex': return !!(entry._codexPinned || entry.isCodexResume);
    case 'grok': return !!(entry._grokPinned || entry.isGrokResume);
    case 'gjc': return !!(entry._gjcPinned || entry.isGjcResume);
    case 'antigravity': return !!entry.isAntigravityResume;
    default: return true; // claude and chief: the launcher picks the id up front
  }
}

// Run the tab's own discovery once (the reader watch normally does this on its
// next poll) so a session written a moment ago is not reported as pending.
function tryPin(entry) {
  if (isPinned(entry) || typeof entry._resolveSessionPath !== 'function') return;
  try { entry._resolveSessionPath(); } catch (_) {}
}

function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

function markdownLink(title, link) {
  const text = (title || 'session').replace(/([\\[\]])/g, '\\$1');
  return `[${text}](${link})`;
}

/**
 * The launcher-side operations behind each command.
 * @param {{
 *   getPanels: () => Iterable<[any, any]>,
 *   scheme: string,
 *   extensionId: string,
 *   version?: string,
 *   titleFor?: (entry:any, sessionId:string) => string|null,
 *   rename?: (entry:any, title:string) => void,
 *   openLink?: (link:{sessionId:string, agent:string, cwd:string|null, title:string|null}) => any,
 * }} deps
 */
function createSessionOps(deps) {
  const titleFor = deps.titleFor || (() => null);

  function findTab(tab) {
    for (const [id, entry] of deps.getPanels()) {
      if (String(id) === String(tab)) return entry;
    }
    throw new AgentCliError('no-tab', `launcher tab ${tab} is gone — the command must run inside an open launcher tab`);
  }

  // Claude Code exports its live session id to its tools; it follows /clear,
  // which the launcher's copy does not. Only a Claude tab takes it (Claude run
  // nested inside another agent's tab is not that tab's session).
  function hintedId(entry, hints) {
    const hinted = hints && hints.claudeSessionId;
    return (entry.agent || 'claude') === 'claude' && isValidSessionId(hinted) ? hinted : null;
  }

  function describe(tab, entry, opts) {
    const o = opts || {};
    const agent = entry.agent || 'claude';
    // Discovery scans the agent's session folder on the extension host thread
    // (which also pumps every terminal) — only for the caller's own tab.
    if (o.pin !== false) tryPin(entry);
    let sessionId = entry.sessionId;
    let source = 'launcher';
    const hinted = hintedId(entry, o.hints);
    if (hinted) {
      sessionId = hinted;
      source = 'agent';
    } else if (!isPinned(entry)) {
      if (o.allowPending) return { tab: String(tab), agent, sessionId: null, cwd: entry.cwd || null, title: entry.title || null, link: null, pending: true };
      throw new AgentCliError('session-pending', agent === 'antigravity'
        ? 'Antigravity tabs get a session link once the conversation is resumed from the Sessions view'
        : `this ${agent} tab has no session id yet — it gets one when ${agent} writes its first transcript entry; retry after its first reply`);
    }
    const title = cleanTitle(o.title) || cleanTitle(titleFor(entry, sessionId) || '') || null;
    const link = buildSessionLink({
      scheme: deps.scheme,
      extensionId: deps.extensionId,
      sessionId,
      agent,
      cwd: entry.cwd,
      title: title || undefined,
    });
    if (!link) throw new AgentCliError('no-link', `session id ${JSON.stringify(sessionId)} cannot be linked`);
    return {
      tab: String(tab),
      agent,
      sessionId,
      cwd: entry.cwd || null,
      title,
      link,
      markdown: markdownLink(title, link),
      source,
    };
  }

  return {
    ping() {
      return { version: deps.version || null, protocol: PROTOCOL_VERSION, scheme: deps.scheme };
    },

    session(req) {
      const args = req.args || {};
      return describe(req.tab, findTab(req.tab), { hints: req.hints, title: args.title });
    },

    rename(req) {
      const title = cleanTitle((req.args || {}).title);
      if (!title) throw new AgentCliError('bad-args', 'rename needs a non-empty title');
      const entry = findTab(req.tab);
      if (typeof deps.rename !== 'function') throw new AgentCliError('unsupported', 'rename is not available');
      // After /clear the live Claude session differs from the tab's original
      // one; the glue titles both.
      deps.rename(entry, title, { sessionId: hintedId(entry, req.hints) });
      return describe(req.tab, entry, { hints: req.hints, title, allowPending: true });
    },

    tabs(req) {
      const out = [];
      for (const [id, entry] of deps.getPanels()) {
        const self = String(id) === String(req.tab);
        let row;
        try {
          row = describe(id, entry, { hints: self ? req.hints : null, allowPending: true, pin: self });
        } catch (_) {
          row = { tab: String(id), agent: entry.agent || 'claude', sessionId: null, cwd: entry.cwd || null, title: entry.title || null, link: null, pending: true };
        }
        out.push({
          ...row,
          tabTitle: entry.title || null,
          state: entry.state || null,
          active: !!(entry.panel && entry.panel.active),
          self,
        });
      }
      return out;
    },

    // v3.28.0: the agent says its turn is done / it needs the user. The glue
    // drives the tab state and the desktop toast (lib/agentNotify).
    notify(req) {
      const args = req.args || {};
      const event = NOTIFY_EVENTS_SET.has(args.event) ? args.event : 'attention';
      const entry = findTab(req.tab);
      if (typeof deps.notify !== 'function') throw new AgentCliError('unsupported', 'notify is not available');
      const result = deps.notify(entry, {
        event,
        message: cleanTitle(args.message || ''),
        kind: typeof args.kind === 'string' ? args.kind.slice(0, 40) : null,
        source: args.source === 'hook' ? 'hook' : 'cli',
        // When the hook process started — orders hooks that arrive out of order.
        t: Number.isFinite(args.t) ? args.t : null,
      }) || {};
      return { tab: String(req.tab), event, attention: !!result.attention, toast: !!result.toast };
    },

    async open(req) {
      const args = req.args || {};
      let caller = null;
      try { caller = findTab(req.tab); } catch (_) {}
      let link = null;
      if (typeof args.link === 'string' && args.link.includes('://')) {
        link = parseSessionLink(args.link);
        if (!link) throw new AgentCliError('bad-args', 'not a CLI Launcher session link');
      } else if (isValidSessionId(args.session)) {
        if (args.agent !== undefined && args.agent !== null && !isKnownAgent(args.agent)) {
          throw new AgentCliError('bad-args', `unknown agent: ${args.agent}`);
        }
        const agent = args.agent || (caller && caller.agent) || 'claude';
        link = { sessionId: args.session, agent, cwd: args.cwd || (caller && caller.cwd) || null, title: null };
      } else {
        throw new AgentCliError('bad-args', 'open needs a session link or a session id');
      }
      if (!isSafeLinkCwd(link.cwd)) {
        throw new AgentCliError('bad-args', `the session folder must be a local absolute path, got ${JSON.stringify(link.cwd)}`);
      }
      if (typeof deps.openLink !== 'function') throw new AgentCliError('unsupported', 'open is not available');
      const status = await deps.openLink(link, caller);
      return { status: status || 'requested', agent: link.agent, sessionId: link.sessionId, cwd: link.cwd };
    },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  ENV,
  AgentCliError,
  newNonce,
  makeIpcPath,
  prependPath,
  stripAgentCliEnv,
  buildAgentCliEnv,
  encodeMessage,
  dispatch,
  createAgentCliServer,
  sendRequest,
  isPinned,
  cleanTitle,
  markdownLink,
  createSessionOps,
};
