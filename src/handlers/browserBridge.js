// @module handlers/browserBridge — "ask about this page" from a browser
// extension → a new agent tab.
//
// The companion browser extension (CLI Launcher Browser) reads the current
// page as Markdown and POSTs it, with the user's question, the folder and the
// agent, to a small HTTP server this extension runs on 127.0.0.1. The page is
// saved to a temp file, a new tab opens in that folder with the chosen agent,
// and a prompt that points at the file and ends with the question is typed in.
//
// Trust: a request can start an agent in any folder, so it must carry the key
// the user copied from the setup command (kept in SecretStorage, compared in
// constant time). Web pages are kept out by Origin (a page cannot forge it)
// and DNS rebinding by Host. The page itself is someone else's text, so its
// tab starts with the agent's normal permission prompts — the agent's
// bypass / trust-all setting is not applied unless
// browserBridge.allowPermissionBypass is on (createPanel noPermissionBypass).
// The settings are read from USER settings only, as with the Slack inbox.
//
// Windows: every window with the bridge on tries to listen; one gets the port
// and the others retry, so the bridge survives that window closing. The
// listening window routes the tab like the Slack inbox does: the folder is
// open here → the tab opens here; otherwise a pending record goes to
// globalStorage and the editor CLI focuses (or opens) the window that owns
// the folder, which claims it (lib/windowRoute).

'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const state = require('../state');
const { t } = require('../i18n');
const lib = require('../lib/browserBridge');
const { isSafeLinkCwd, notificationText } = require('../lib/sessionLink');
const { isCwdInWorkspace, shouldClaimPending, PENDING_TTL_MS } = require('../lib/windowRoute');
const { openFolderWindow } = require('../lib/editorCli');
const { injectWhenReady } = require('../pty/injectWhenReady');
const { AGENTS, isKnownAgent } = require('../agents/registry');

const TOKEN_KEY = 'claudeCodeLauncher.browserBridge.token';
const PENDING_PREFIX = 'pending-browser-';
const PAGE_SUBDIR = 'claude-launcher-web';
const PAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Another window holds the port: try again this often. Any other listen
// error (a port Windows reserves, no permission) is retried more slowly.
const RETRY_MS = 10_000;
const RETRY_ERROR_MS = 60_000;
const RESTART_DEBOUNCE_MS = 500;
const BODY_TIMEOUT_MS = 30_000;
// detect() can spawn `where` / `<cli> --version` on the extension host.
const DETECT_CACHE_MS = 60_000;
// A window whose workspace holds the folder (a parent folder too) claims a
// hand-off record at once through its watcher; only when none has after this
// long is the editor CLI asked to focus or open one.
const CLAIM_WAIT_MS = 400;
// The sender takes back a record nobody claimed a little before it expires.
const UNCLAIMED_AFTER_MS = PENDING_TTL_MS - 5000;

let server = null;
let retryTimer = null;
let restartTimer = null;
let generation = 0;
let listenWarned = false;
let detectCache = null; // { at, installed: Map<id, boolean> }

function cfg() {
  return vscode.workspace.getConfiguration('claudeCodeLauncher');
}

// User (global) settings only: a repo's .vscode/settings.json must not open a
// port on this PC or move it.
function userSetting(key, def) {
  const info = cfg().inspect(key);
  return info && info.globalValue !== undefined ? info.globalValue : def;
}

function bridgePort() {
  const p = Number(userSetting('browserBridge.port', lib.DEFAULT_PORT));
  return lib.isValidPort(p) ? p : lib.DEFAULT_PORT;
}

function log(...args) {
  console.log('[Claude Launcher][browser]', ...args);
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function globalStorageDir(context) {
  const dir = context.globalStorageUri ? context.globalStorageUri.fsPath : context.globalStoragePath;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

// isSafeLinkCwd first: stat()ing a UNC path would contact that host.
function isUsableFolder(dir) {
  if (!dir || typeof dir !== 'string' || !isSafeLinkCwd(dir)) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function extensionVersion(context) {
  try {
    return (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '';
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// The page file
// ---------------------------------------------------------------------------

// Per user. Windows and macOS temp folders already are; on Linux os.tmpdir()
// is shared, so the folder name carries the uid, it is created 0700, and one
// that is not ours (or is a link someone planted) is refused.
function pageDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const dir = path.join(os.tmpdir(), uid === null ? PAGE_SUBDIR : `${PAGE_SUBDIR}-${uid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (uid !== null && (st.uid !== uid || (st.mode & 0o077) !== 0))) {
    throw new Error(`unsafe page folder: ${dir}`);
  }
  return dir;
}

// Only files this module named are swept.
function sweepOldPages(dir) {
  const cutoff = Date.now() - PAGE_MAX_AGE_MS;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => lib.PAGE_FILE_RE.test(n));
  } catch (_) {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (_) {}
  }
}

function savePage(v) {
  const dir = pageDir();
  sweepOldPages(dir);
  const now = new Date();
  const file = path.join(dir, lib.pageFileName(now, crypto.randomBytes(3).toString('hex')));
  // wx: a name collision never overwrites another page.
  fs.writeFileSync(file, lib.buildPageFile({ ...v, capturedAt: now }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return file;
}

// ---------------------------------------------------------------------------
// Opening the tab
// ---------------------------------------------------------------------------

function typePromptWhenReady(entry, prompt, title) {
  injectWhenReady(entry, prompt, {
    onGiveUp: () => {
      vscode.window
        // A function replacement: `$&` and friends in a title stay literal.
        .showWarningMessage(t('bridgeInjectGaveUp').replace('{0}', () => notificationText(title, 80)), t('bridgeCopyPrompt'))
        .then((c) => {
          if (c) vscode.env.clipboard.writeText(prompt);
        });
    },
  });
}

function openHere(context, record) {
  // Required lazily: createPanel pulls in the whole panel stack.
  const { createPanel } = require('../panel/createPanel');
  // Sanitized again here: a record can come from globalStorage.
  const title = lib.oneLine(record.title);
  const prompt = lib.sanitizeForPty(record.prompt);
  const agent = isKnownAgent(record.agent) ? record.agent : 'claude';
  const before = state.tabCounter;
  createPanel(context, context.extensionPath, { cwd: record.cwd, title }, {
    agent,
    noPermissionBypass: !userSetting('browserBridge.allowPermissionBypass', false),
  });
  // createPanel bumps the counter before it can fail, so check the entry too
  // (it has already told the user why, e.g. the agent's CLI is missing).
  const entry = state.tabCounter !== before ? state.panels.get(state.tabCounter) : null;
  if (!entry) return false;
  // A session-shaped open keeps focus where it was; this one was asked for.
  try {
    if (entry.panel) entry.panel.reveal(entry.panel.viewColumn, false);
  } catch (_) {}
  typePromptWhenReady(entry, prompt, title);
  return true;
}

// The OS window comes forward when the editor CLI is handed the folder this
// window has open. Only for a plain single-folder window: with a multi-root
// workspace the CLI would open a second window instead.
function focusThisWindow() {
  const folders = workspaceFolderPaths();
  if (folders.length !== 1 || vscode.workspace.workspaceFile) return;
  openFolderWindow(folders[0], vscode.env.appRoot);
}

function writePending(context, record) {
  const file = path.join(globalStorageDir(context), `${PENDING_PREFIX}${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ ...record, ts: Date.now() }), 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

// A window that never claims (Restricted Mode, a slow start, an older
// launcher) would lose the ask silently: take the record back before it
// expires and offer to open the tab here.
function watchUnclaimed(context, file, record) {
  const timer = setTimeout(() => {
    try {
      fs.unlinkSync(file);
    } catch (_) {
      return; // claimed
    }
    const here = t('bridgeOpenHere');
    vscode.window
      .showWarningMessage(t('bridgeHandoffUnclaimed').replace('{0}', () => notificationText(record.cwd, 160)), here)
      .then((c) => {
        if (c === here) openHere(context, record);
      });
  }, UNCLAIMED_AFTER_MS);
  if (timer.unref) timer.unref();
}

/**
 * Open the tab here, or hand it to the window that owns the folder.
 * @returns {Promise<'opened'|'handed-off'|'failed'>}
 */
async function deliver(context, record) {
  if (isCwdInWorkspace(record.cwd, workspaceFolderPaths())) {
    if (!openHere(context, record)) return 'failed';
    if (record.focus) focusThisWindow();
    return 'opened';
  }
  const file = writePending(context, record);
  if (file) {
    // A running window that has the folder (or a parent of it) open takes it
    // without the editor CLI, which only matches exact folders and would open
    // an extra, empty window for a subfolder.
    await new Promise((r) => setTimeout(r, CLAIM_WAIT_MS));
    if (!fs.existsSync(file)) return 'handed-off';
    if (openFolderWindow(record.cwd, vscode.env.appRoot)) {
      watchUnclaimed(context, file, record);
      return 'handed-off';
    }
    // No other window can take it — better a tab here than nothing.
    try {
      fs.unlinkSync(file);
    } catch (_) {
      return 'handed-off'; // claimed meanwhile
    }
  }
  if (!openHere(context, record)) return 'failed';
  if (record.focus) focusThisWindow();
  return 'opened';
}

function isValidRecord(record, now) {
  // A record from the future (the clock moved back) would never expire.
  return !!record && typeof record.ts === 'number' && record.ts <= now + 5000 && now - record.ts <= PENDING_TTL_MS
    && typeof record.prompt === 'string' && typeof record.title === 'string'
    && typeof record.agent === 'string' && isKnownAgent(record.agent)
    && typeof record.cwd === 'string' && !!record.cwd && isSafeLinkCwd(record.cwd);
}

// Reading and deleting is the claim: whichever window unlinks a record first
// opens it. Expired or malformed records are swept.
function claimPending(context) {
  const dir = globalStorageDir(context);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(PENDING_PREFIX) && n.endsWith('.json'));
  } catch (_) {
    return;
  }
  const folders = workspaceFolderPaths();
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue; // still being written
    }
    if (!isValidRecord(record, now)) {
      try { fs.unlinkSync(file); } catch (_) {}
      continue;
    }
    if (!shouldClaimPending(record, folders, now)) continue;
    try {
      fs.unlinkSync(file);
    } catch (_) {
      continue; // another window got there first
    }
    try {
      if (!openHere(context, record)) vscode.window.showWarningMessage(t('bridgeOpenFailed'));
      // Claimed without the editor CLI (see deliver): come forward ourselves.
      else if (record.focus) focusThisWindow();
    } catch (e) {
      log('opening a handed-over tab failed:', e && e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // Only extension origins get this far (isAllowedOrigin); echoing one back
  // lets an extension that is not exempt from CORS read the reply.
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

// Only reached with the right key. An oversized body is drained, not kept, so
// the sender still gets its 413 instead of a reset connection.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      req.destroy();
    }, BODY_TIMEOUT_MS);
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > lib.MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (tooLarge) reject(Object.assign(new Error('too large'), { code: 'too-large' }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function detect(agent) {
  try {
    return !!agent.detect();
  } catch (_) {
    return false;
  }
}

// Cached: every popup and options page asks, and detect() blocks the
// extension host (and with it every terminal tab) while it spawns.
function installedAgents() {
  const now = Date.now();
  if (detectCache && now - detectCache.at < DETECT_CACHE_MS) return detectCache.installed;
  const installed = new Map(AGENTS.map((a) => [a.id, detect(a)]));
  detectCache = { at: now, installed };
  return installed;
}

function agentList() {
  const enabled = cfg().get('enabledAgents', ['claude']);
  const installed = installedAgents();
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    installed: !!installed.get(a.id),
    enabled: Array.isArray(enabled) && enabled.includes(a.id),
  }));
}

function info(context) {
  return {
    ok: true,
    app: 'cli-launcher',
    api: lib.API_VERSION,
    version: extensionVersion(context),
    editor: vscode.env.appName || '',
    platform: process.platform,
    agents: agentList(),
    defaultAgent: cfg().get('agent') || 'claude',
    folders: workspaceFolderPaths(),
  };
}

/** @returns {Promise<[number, object]>} status and JSON body */
async function ask(context, body) {
  const parsed = lib.parseAskBody(body, { home: os.homedir(), platform: process.platform });
  if (!parsed.ok) return [400, parsed];
  const v = parsed.value;
  if (!isUsableFolder(v.cwd)) return [400, { ok: false, error: 'bad-folder', folder: v.cwd }];
  const agent = AGENTS.find((a) => a.id === v.agent);
  if (!agent) return [400, { ok: false, error: 'unknown-agent', agent: v.agent }];
  // Only this agent is probed when the cache is cold, and a cached "not
  // installed" is checked again: it may have just been installed.
  const fresh = detectCache && Date.now() - detectCache.at < DETECT_CACHE_MS;
  if (!(fresh && detectCache.installed.get(agent.id)) && !detect(agent)) {
    return [400, { ok: false, error: 'agent-not-installed', agent: v.agent }];
  }

  let file;
  try {
    file = savePage(v);
  } catch (e) {
    log('saving the page failed:', e && e.message);
    return [500, { ok: false, error: 'save-failed' }];
  }
  const record = {
    cwd: v.cwd,
    agent: v.agent,
    title: lib.browserTabTitle(v.title),
    prompt: lib.buildAskPrompt({
      question: v.question,
      title: v.title,
      url: v.url,
      filePath: file,
      agent: v.agent,
      hasSelection: !!v.selection.trim(),
    }),
    focus: v.focus,
  };
  const result = await deliver(context, record);
  log('ask', v.agent, '→', result, v.cwd);
  if (result === 'failed') return [500, { ok: false, error: 'open-failed' }];
  return [200, { ok: true, result, folder: path.basename(v.cwd) || v.cwd, agent: v.agent, file }];
}

async function handleRequest(context, req, res, port) {
  const origin = req.headers.origin;
  if (!lib.isAllowedHost(req.headers.host, port) || !lib.isAllowedOrigin(origin)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  const pathname = (req.url || '/').split('?')[0];
  // No key needed: lets the extension tell "launcher not running" from "wrong key".
  if (pathname === '/v1/ping' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, app: 'cli-launcher', api: lib.API_VERSION }, origin);
  }
  const token = await context.secrets.get(TOKEN_KEY);
  if (!lib.isValidToken(token) || !lib.tokensMatch(lib.bearerToken(req.headers.authorization), token)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' }, origin);
  }
  if (pathname === '/v1/info' && req.method === 'GET') {
    return sendJson(res, 200, info(context), origin);
  }
  if (pathname === '/v1/ask' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      const code = e && e.code === 'too-large' ? 'too-large' : 'bad-request';
      return sendJson(res, code === 'too-large' ? 413 : 400, { ok: false, error: code }, origin);
    }
    const [status, reply] = await ask(context, body);
    return sendJson(res, status, reply, origin);
  }
  return sendJson(res, 404, { ok: false, error: 'not-found' }, origin);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function stopServer() {
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (server) {
    const s = server;
    server = null;
    try { s.close(); } catch (_) {}
    try { if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); } catch (_) {}
  }
}

function startServer(context) {
  stopServer();
  if (!userSetting('browserBridge.enabled', false)) return;
  const gen = generation;
  const port = bridgePort();
  const srv = http.createServer((req, res) => {
    handleRequest(context, req, res, port).catch((e) => {
      log('request failed:', e && e.message);
      try { sendJson(res, 500, { ok: false, error: 'internal' }); } catch (_) {}
    });
  });
  srv.on('error', (e) => {
    // Closed whatever happened: an error after a successful listen (EMFILE on
    // accept) must not leave a server that stopServer can no longer reach.
    try { srv.close(); } catch (_) {}
    try { if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections(); } catch (_) {}
    if (gen !== generation) return;
    if (server === srv) server = null;
    // EADDRINUSE: another window has the bridge — take over if it goes away.
    const busy = !!e && e.code === 'EADDRINUSE';
    if (!busy) {
      log('server error:', e && e.message);
      if (!listenWarned) {
        listenWarned = true;
        vscode.window.showWarningMessage(
          t('bridgeListenFailed').replace('{0}', String(port)).replace('{1}', () => notificationText((e && (e.code || e.message)) || '', 80))
        );
      }
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (gen === generation) startServer(context);
    }, busy ? RETRY_MS : RETRY_ERROR_MS);
  });
  srv.listen(port, '127.0.0.1', () => {
    if (gen !== generation) {
      try { srv.close(); } catch (_) {}
      return;
    }
    log('listening on 127.0.0.1:' + port);
  });
  server = srv;
}

function restartSoon(context) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    listenWarned = false;
    startServer(context);
  }, RESTART_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setupBridge(context) {
  let token = await context.secrets.get(TOKEN_KEY);
  if (!lib.isValidToken(token)) token = null;
  if (token) {
    const copy = t('bridgeSetupCopyKey');
    const renew = t('bridgeSetupNewKey');
    const choice = await vscode.window.showInformationMessage(t('bridgeSetupHasKey'), { modal: true }, copy, renew);
    if (!choice) return;
    if (choice === renew) token = null;
  }
  if (!token) {
    token = lib.generateToken();
    await context.secrets.store(TOKEN_KEY, token);
  }
  try {
    await cfg().update('browserBridge.enabled', true, vscode.ConfigurationTarget.Global);
  } catch (e) {
    // New settings are registered on a window reload, not on Restart Extensions.
    const reload = t('bridgeSetupReload');
    const choice = await vscode.window.showErrorMessage(
      t('bridgeSetupSettingsFailed').replace('{0}', notificationText((e && e.message) || '', 200)),
      reload
    );
    if (choice === reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }
  // Re-running setup with the same values fires no change event.
  restartSoon(context);
  const key = lib.encodeKey(bridgePort(), token);
  await vscode.env.clipboard.writeText(key);
  // Not awaited: the command resolves to the key now (scripts can read it
  // from executeCommand), while the notice waits for the user.
  vscode.window.showInformationMessage(t('bridgeSetupDone').replace('{0}', String(bridgePort())), { modal: true });
  return key;
}

async function disableBridge() {
  stopServer();
  await cfg().update('browserBridge.enabled', false, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(t('bridgeDisabled'));
}

/** Wire the commands, the pending hand-off and the server (called once from activate). */
function registerBrowserBridge(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.browserBridge.setup', () => setupBridge(context)),
    vscode.commands.registerCommand('claudeCodeLauncher.browserBridge.disable', () => disableBridge()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeLauncher.browserBridge.enabled')
        || e.affectsConfiguration('claudeCodeLauncher.browserBridge.port')) {
        restartSoon(context);
      }
    }),
    {
      dispose() {
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = null;
        stopServer();
      },
    }
  );

  // Records handed over by another window: a running window learns of them
  // through the watcher; a window the editor CLI just opened, at start-up.
  const dir = globalStorageDir(context);
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && !String(filename).startsWith(PENDING_PREFIX)) return;
      claimPending(context);
    });
    context.subscriptions.push({ dispose: () => { try { watcher.close(); } catch (_) {} } });
  } catch (_) {}
  // Deferred so the tree providers exist before a panel is created.
  setTimeout(() => claimPending(context), 1500);

  startServer(context);
}

module.exports = {
  registerBrowserBridge,
  _test: { deliver, claimPending, handleRequest, startServer, stopServer, TOKEN_KEY },
};
