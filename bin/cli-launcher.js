#!/usr/bin/env node
// cli-launcher — talk to the CLI Launcher tab this shell runs in.
//
// The launcher puts `bin/path/` on PATH for every agent it starts (Claude Code,
// Codex, gjc, Kiro, Grok, Chief), so an agent can run e.g.
//   cli-launcher link        → resume link for this session (attach it to a Burst todo, a note, …)
// The shims in bin/path/ run this file with the editor's own Node runtime.
// Protocol and server: src/lib/agentCli.js.

'use strict';

const path = require('path');
const {
  ENV,
  AgentCliError,
  sendRequest,
  markdownLink,
  cleanTitle,
} = require('../src/lib/agentCli');
const { buildSessionLink, isValidSessionId } = require('../src/lib/sessionLink');
const { NOTIFY_EVENTS, notifyFromHookInput } = require('../src/lib/agentNotify');

const USAGE = `Usage: cli-launcher <command> [options]

Commands (run inside a CLI Launcher tab):
  link [--markdown | --json] [--title <text> | --title-env]
                      Resume link for this tab's session. Clicking it reopens
                      the session in the launcher. --title sets the link label.
  info                Same as link --json: agent, session id, cwd, title, link.
  rename <title> | rename --title-env
                      Rename this tab and its session in the Sessions view.
  tabs [--json]       List open launcher tabs with their session links.
  open <link | session-id> [--agent <id>] [--cwd <dir>] | open --link-env
                      Ask to resume a session in the launcher (the user
                      confirms in the editor; an open tab is just focused).
  notify [--event done|attention|info] [<message> | --message-env]
                      Tell the user this tab is done (done) or needs them
                      (attention, the default): the tab is flagged and a
                      desktop notification shows <message>. info only shows
                      the notification.
  notify --from-hook  For agent hooks: reads the hook JSON from stdin (Claude
                      Code Stop, StopFailure, Notification, UserPromptSubmit).
                      Prints nothing, always exits 0.
  help                Show this help.

Windows cmd / PowerShell: cmd re-parses arguments, so text containing
& | < > ^ % must not go on the command line -- that includes every session
link (it has & between its parameters). Put a title in CLI_LAUNCHER_TITLE and
pass --title-env, a link in CLI_LAUNCHER_LINK and pass --link-env, a notify
message in CLI_LAUNCHER_MESSAGE and pass --message-env, e.g.:
  $env:CLI_LAUNCHER_TITLE = 'R&D notes'; cli-launcher rename --title-env
  $env:CLI_LAUNCHER_LINK = '<link>'; cli-launcher open --link-env

Exit codes: 0 ok, 1 command failed, 2 usage error, 3 not inside a launcher tab.`;

const TITLE_ENV = 'CLI_LAUNCHER_TITLE';
const LINK_ENV = 'CLI_LAUNCHER_LINK';
const MESSAGE_ENV = 'CLI_LAUNCHER_MESSAGE';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NO_LAUNCHER = 3;

function version() {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version;
  } catch (_) {
    return 'unknown';
  }
}

// JSON with every non-ASCII character escaped, so a Korean title survives a
// shell that decodes the pipe with a legacy code page (PowerShell, cmd).
function asciiJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Split argv into positionals and --flags (`--flag value` and `--flag=value`). */
function parseArgs(argv, valueFlags) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (valueFlags.includes(name)) {
        if (i + 1 >= argv.length) throw new AgentCliError('usage', `--${name} needs a value`);
        flags[name] = argv[++i];
      } else flags[name] = true;
    } else if (a === '-m') {
      flags.markdown = true;
    } else if (a === '-h') {
      flags.help = true;
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function launcherContext(env) {
  if (!env[ENV.IPC] || !env[ENV.NONCE] || !env[ENV.TAB]) return null;
  return { ipcPath: env[ENV.IPC], nonce: env[ENV.NONCE], tab: env[ENV.TAB] };
}

function hintsFrom(env) {
  const hints = {};
  if (isValidSessionId(env.CLAUDE_CODE_SESSION_ID)) hints.claudeSessionId = env.CLAUDE_CODE_SESSION_ID;
  return hints;
}

// The launcher is unreachable but the tab's environment still says enough to
// build a Claude link: Claude Code exports its own session id.
function linkFromEnvironment(env, title) {
  const agent = env[ENV.AGENT] || 'claude';
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  const cwd = env[ENV.CWD];
  if (agent !== 'claude' || !isValidSessionId(sessionId) || !cwd) return null;
  const cleaned = cleanTitle(title) || null;
  const link = buildSessionLink({
    scheme: env[ENV.SCHEME] || 'vscode',
    sessionId,
    agent,
    cwd,
    title: cleaned || undefined,
  });
  if (!link) return null;
  return { tab: env[ENV.TAB] || null, agent, sessionId, cwd, title: cleaned, link, markdown: markdownLink(cleaned, link), source: 'environment' };
}

async function call(env, op, args) {
  const ctx = launcherContext(env);
  if (!ctx) {
    throw new AgentCliError('no-launcher', `not running inside a CLI Launcher tab (${ENV.IPC} is not set)`);
  }
  const reply = await sendRequest({ ...ctx, op, args, hints: hintsFrom(env) });
  if (!reply || reply.ok !== true) {
    throw new AgentCliError((reply && reply.code) || 'failed', (reply && reply.error) || 'the launcher refused the request');
  }
  return reply.result;
}

function printSession(io, info, flags) {
  if (flags.json) io.out(asciiJson(info));
  else if (flags.markdown) io.out(info.markdown);
  else io.out(info.link);
}

function titleFromEnv(env) {
  const title = cleanTitle(env[TITLE_ENV] || '');
  if (!title) throw new AgentCliError('usage', `--title-env reads ${TITLE_ENV}, which is empty`);
  return title;
}

// A folder for `open --cwd`: absolute, and a Git Bash path (/c/dev/x) turned
// into the Windows path the launcher compares against.
function resolveCwd(raw, platform) {
  let dir = String(raw);
  if ((platform || process.platform) === 'win32') {
    const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(dir);
    if (msys) dir = `${msys[1].toUpperCase()}:\\${(msys[2] || '').replace(/\//g, '\\')}`;
  }
  return path.resolve(dir);
}

async function cmdLink(argv, env, io, forceJson) {
  const { flags, positionals } = parseArgs(argv, ['title']);
  if (positionals.length) throw new AgentCliError('usage', `unexpected argument: ${positionals[0]}`);
  if (forceJson) flags.json = true;
  const title = flags['title-env'] ? titleFromEnv(env) : (typeof flags.title === 'string' ? flags.title : undefined);
  let info;
  try {
    info = await call(env, 'session', { title });
  } catch (e) {
    const offline = e instanceof AgentCliError && ['no-launcher', 'unreachable', 'timeout'].includes(e.code);
    const fallback = offline ? linkFromEnvironment(env, title) : null;
    if (!fallback) throw e;
    io.err(`cli-launcher: ${e.message}; built the link from this shell's environment instead`);
    info = fallback;
  }
  printSession(io, info, flags);
  return EXIT_OK;
}

async function cmdRename(argv, env, io) {
  const { flags, positionals } = parseArgs(argv, []);
  const title = flags['title-env'] ? titleFromEnv(env) : cleanTitle(positionals.join(' '));
  if (!title) throw new AgentCliError('usage', 'rename needs a title: cli-launcher rename "<title>"');
  const info = await call(env, 'rename', { title });
  if (flags.json) io.out(asciiJson(info));
  else io.out(`Renamed tab ${info.tab} to "${info.title}"${info.link ? `\n${info.link}` : ''}`);
  return EXIT_OK;
}

async function cmdTabs(argv, env, io) {
  const { flags } = parseArgs(argv, []);
  const tabs = await call(env, 'tabs', {});
  if (flags.json) {
    io.out(asciiJson(tabs));
    return EXIT_OK;
  }
  if (!tabs.length) {
    io.out('No open launcher tabs.');
    return EXIT_OK;
  }
  for (const t of tabs) {
    const mark = t.self ? '*' : ' ';
    const label = t.title || t.tabTitle || '(untitled)';
    io.out(`${mark} ${t.tab}\t${t.agent}\t${label}\t${t.link || '(no session id yet)'}`);
  }
  return EXIT_OK;
}

async function cmdOpen(argv, env, io) {
  const { flags, positionals } = parseArgs(argv, ['agent', 'cwd']);
  if (flags['link-env']) {
    const fromEnv = String(env[LINK_ENV] || '').trim();
    if (!fromEnv) throw new AgentCliError('usage', `--link-env reads ${LINK_ENV}, which is empty`);
    if (positionals.length) throw new AgentCliError('usage', 'pass the link either as an argument or with --link-env, not both');
    positionals.push(fromEnv);
  }
  const target = positionals[0];
  if (!target || positionals.length > 1) throw new AgentCliError('usage', 'open needs exactly one session link or session id');
  const args = target.includes('://')
    ? { link: target }
    : {
      session: target,
      agent: typeof flags.agent === 'string' ? flags.agent : undefined,
      cwd: typeof flags.cwd === 'string' ? resolveCwd(flags.cwd) : undefined,
    };
  const result = await call(env, 'open', args);
  const what = `${result.agent} session ${result.sessionId}`;
  if (flags.json) io.out(asciiJson(result));
  else if (result.status === 'revealed') io.out(`Switched to the open tab for the ${what}.`);
  else if (result.status === 'confirm') io.out(`Asked the user to confirm in the editor; the ${what} opens when they click Open.`);
  else io.out(`Opening the ${what}.`);
  return EXIT_OK;
}

async function cmdNotify(argv, env, io) {
  const { flags, positionals } = parseArgs(argv, ['event', 'kind']);
  // Agents often try --help first; that must not notify anyone.
  if (flags.help) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (flags['from-hook']) {
    // Run by an agent hook. Whatever happens, stay silent and exit 0: a
    // non-zero exit or output from a Stop hook can change what the agent does.
    try {
      const raw = io.readStdin ? await io.readStdin() : '';
      let input = null;
      try { input = JSON.parse(raw); } catch (_) {}
      const ev = notifyFromHookInput(input);
      // t: when this hook process started. Claude starts hooks in order, but
      // each is its own process, so their notifications can arrive out of it.
      if (ev) await call(env, 'notify', { ...ev, source: 'hook', t: Math.round(performance.timeOrigin) });
    } catch (_) {}
    return EXIT_OK;
  }
  const event = typeof flags.event === 'string' ? flags.event : 'attention';
  // busy (a new turn) comes from hooks only.
  if (!NOTIFY_EVENTS.has(event) || event === 'busy') throw new AgentCliError('usage', `--event must be done, attention or info (got ${event})`);
  const message = flags['message-env'] ? String(env[MESSAGE_ENV] || '') : positionals.join(' ');
  const result = await call(env, 'notify', { event, message, kind: typeof flags.kind === 'string' ? flags.kind : undefined });
  if (flags.json) io.out(asciiJson(result));
  else io.out(`Sent (${result.event}).`);
  return EXIT_OK;
}

/**
 * @param {string[]} argv arguments after the command name
 * @param {Record<string,string|undefined>} env
 * @param {{out:(s:string)=>void, err:(s:string)=>void}} io
 * @returns {Promise<number>} exit code
 */
async function main(argv, env, io) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'link': return await cmdLink(rest, env, io, false);
      case 'info': return await cmdLink(rest, env, io, true);
      case 'rename': return await cmdRename(rest, env, io);
      case 'tabs': return await cmdTabs(rest, env, io);
      case 'open': return await cmdOpen(rest, env, io);
      case 'notify': return await cmdNotify(rest, env, io);
      case '--version':
      case 'version':
        io.out(version());
        return EXIT_OK;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return command === undefined ? EXIT_USAGE : EXIT_OK;
      default:
        io.err(`cli-launcher: unknown command "${command}"\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (e) {
    const code = e instanceof AgentCliError ? e.code : 'failed';
    io.err(`cli-launcher: ${(e && e.message) || e}`);
    if (code === 'usage') return EXIT_USAGE;
    if (code === 'no-launcher' || code === 'unreachable' || code === 'timeout') return EXIT_NO_LAUNCHER;
    return EXIT_FAILED;
  }
}

module.exports = { main, parseArgs, asciiJson, resolveCwd, USAGE };

// stdin for `notify --from-hook` (the hook JSON). A terminal or an idle pipe
// must not hang the command: give up after a short wait.
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    readStdin: () => readStdin(3000),
  }).then((code) => {
    process.exitCode = code;
    // A stdin that never closed must not keep the process alive.
    try { process.stdin.destroy(); } catch (_) {}
  });
}
