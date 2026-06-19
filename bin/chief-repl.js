#!/usr/bin/env node

// Thin interactive wrapper around Chief's async REST chat API. The launcher
// owns the session id; Chief's chat_id is stored only in summary.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120000;
const DEFAULT_BASE_URL = 'https://api.storytell.ai';
const PROMPT = 'chief> ';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--resume') { out.sessionId = argv[++i]; out.resume = true; }
    else if (a === '--cwd') out.cwd = argv[++i];
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function mkdirp(p) {
  if (p) fs.mkdirSync(p, { recursive: true });
}

function safeJsonRead(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function appendJsonl(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function titleFromPrompt(prompt) {
  return String(prompt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeBaseUrl(raw) {
  return String(raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function shouldSet(value) {
  return typeof value === 'string' && value.trim();
}

class ChiefClient {
  constructor(env) {
    this.baseUrl = normalizeBaseUrl(env.CHIEF_BASE_URL);
    this.apiKey = env.CHIEF_API_KEY || '';
    this.projectId = env.CHIEF_PROJECT_ID || '';
    this.intelligence = env.CHIEF_INTELLIGENCE || 'auto';
    this.provider = env.CHIEF_PROVIDER || 'automatic';
    this.publicData = String(env.CHIEF_WEB || '').toLowerCase() === 'true';
  }

  assertConfigured() {
    if (!this.apiKey) throw new Error('CHIEF_API_KEY is not configured.');
    if (!this.projectId) throw new Error('CHIEF_PROJECT_ID is not configured.');
  }

  headers() {
    return {
      'X-API-Key': this.apiKey,
      'X-Project-Id': this.projectId,
      'Content-Type': 'application/json',
    };
  }

  body(prompt) {
    const body = { prompt };
    if (shouldSet(this.intelligence)) body.intelligence = this.intelligence;
    if (shouldSet(this.provider)) body.provider = this.provider;
    body.public_data = !!this.publicData;
    return body;
  }

  async postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Error(`Chief request failed (${res.status}): ${text || res.statusText}`);
    }
    return res.json();
  }

  async createChat(prompt) {
    return this.postJson(`${this.baseUrl}/v1/chats`, this.body(prompt));
  }

  async sendMessage(chatId, prompt) {
    return this.postJson(`${this.baseUrl}/v1/chats/${encodeURIComponent(chatId)}/messages`, this.body(prompt));
  }

  async getMessage(chatId, messageId) {
    const res = await fetch(
      `${this.baseUrl}/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      { headers: this.headers() }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Chief poll failed (${res.status}): ${text || res.statusText}`);
    }
    return res.json();
  }

  async waitForResponse(chatId, messageId) {
    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      const msg = await this.getMessage(chatId, messageId);
      if (typeof msg.response === 'string' && msg.response.trim()) return msg.response;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for Chief response.');
  }
}

class Transcript {
  constructor(sessionId, cwd) {
    const root = process.env.CHIEF_SESSIONS_DIR || path.join(os.homedir(), '.chief', 'sessions');
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.dir = path.join(root, sessionId);
    this.summaryPath = path.join(this.dir, 'summary.json');
    this.updatesPath = path.join(this.dir, 'updates.jsonl');
    mkdirp(this.dir);
    const existing = safeJsonRead(this.summaryPath, null);
    const info = existing && existing.info && typeof existing.info === 'object' ? existing.info : {};
    const createdAt = info.created_at || nowIso();
    this.info = {
      cwd: info.cwd || cwd || '',
      chat_id: info.chat_id || null,
      title: info.title || info.generated_title || '',
      generated_title: info.generated_title || info.title || '',
      created_at: createdAt,
      updated_at: info.updated_at || createdAt,
    };
    this.save();
  }

  save() {
    this.info.updated_at = this.info.updated_at || nowIso();
    fs.writeFileSync(this.summaryPath, JSON.stringify({ info: this.info }, null, 2) + '\n', 'utf8');
  }

  update(fields) {
    this.info = { ...this.info, ...fields, updated_at: nowIso() };
    this.save();
  }

  append(role, text) {
    const row = { role, text, timestamp: nowIso() };
    appendJsonl(this.updatesPath, row);
    this.update({});
  }

  replay() {
    const rows = readJsonl(this.updatesPath);
    if (rows.length === 0) return;
    process.stdout.write('\n');
    for (const row of rows) {
      if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
      const who = row.role === 'user' ? 'You' : 'Chief';
      process.stdout.write(`${who}: ${row.text || ''}\n\n`);
    }
  }
}

function startSpinner(label) {
  const frames = ['|', '/', '-', '\\'];
  let i = 0;
  process.stdout.write(`${label} ${frames[i]}`);
  return setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r${label} ${frames[i]}`);
  }, 150);
}

function stopSpinner(timer, label) {
  if (timer) clearInterval(timer);
  process.stdout.write(`\r${' '.repeat(label.length + 2)}\r`);
}

function printHelp() {
  process.stdout.write([
    'Commands:',
    '  /intel fast|expert|research|auto',
    '  /provider automatic|anthropic|openai|google',
    '  /web on|off',
    '  /upload <path>',
    '  /new',
    '  /exit',
  ].join('\n') + '\n');
}

function runUpload(uploadPath, cwd) {
  return new Promise((resolve) => {
    const target = path.resolve(cwd || process.cwd(), uploadPath);
    const args = ['assets', 'upload', target];
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) args.push('--recursive');
    } catch (e) {
      process.stdout.write(`Upload path not found: ${target}\n`);
      resolve(false);
      return;
    }
    const child = spawn('chief', args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (e) => {
      process.stdout.write(`Chief CLI upload failed: ${e.message}\n`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

async function handleSlash(line, client, transcript, cwd) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const value = rest[0];
  if (cmd === '/help') {
    printHelp();
    return true;
  }
  if (cmd === '/exit' || cmd === '/quit') {
    process.exit(0);
  }
  if (cmd === '/intel') {
    if (!['fast', 'expert', 'research', 'auto'].includes(value)) {
      process.stdout.write('Usage: /intel fast|expert|research|auto\n');
    } else {
      client.intelligence = value;
      process.stdout.write(`intelligence=${value}\n`);
    }
    return true;
  }
  if (cmd === '/provider') {
    if (!['automatic', 'anthropic', 'openai', 'google'].includes(value)) {
      process.stdout.write('Usage: /provider automatic|anthropic|openai|google\n');
    } else {
      client.provider = value;
      process.stdout.write(`provider=${value}\n`);
    }
    return true;
  }
  if (cmd === '/web') {
    if (value !== 'on' && value !== 'off') {
      process.stdout.write('Usage: /web on|off\n');
    } else {
      client.publicData = value === 'on';
      process.stdout.write(`web=${value}\n`);
    }
    return true;
  }
  if (cmd === '/new') {
    transcript.update({ chat_id: null });
    process.stdout.write('Started a new Chief chat for this launcher session.\n');
    return true;
  }
  if (cmd === '/upload') {
    const uploadPath = line.trim().slice('/upload'.length).trim();
    if (!uploadPath) {
      process.stdout.write('Usage: /upload <path>\n');
    } else {
      await runUpload(uploadPath, cwd);
    }
    return true;
  }
  return false;
}

async function askChief(prompt, client, transcript) {
  transcript.append('user', prompt);
  const label = 'Chief thinking';
  const spinner = startSpinner(label);
  try {
    let chatId = transcript.info.chat_id;
    let messageId;
    if (!chatId) {
      const created = await client.createChat(prompt);
      chatId = created.chat_id;
      messageId = created.message_id;
      transcript.update({
        chat_id: chatId,
        title: transcript.info.title || titleFromPrompt(prompt),
        generated_title: transcript.info.generated_title || titleFromPrompt(prompt),
      });
    } else {
      const sent = await client.sendMessage(chatId, prompt);
      messageId = sent.message_id;
    }
    if (!chatId || !messageId) throw new Error('Chief did not return chat_id/message_id.');
    const response = await client.waitForResponse(chatId, messageId);
    stopSpinner(spinner, label);
    process.stdout.write(`\n${response}\n\n`);
    transcript.append('assistant', response);
  } catch (e) {
    stopSpinner(spinner, label);
    process.stdout.write(`Chief error: ${e.message}\n\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sessionId) {
    process.stderr.write('Usage: chief-repl --session-id <id> | --resume <id> [--cwd <cwd>]\n');
    process.exit(2);
  }
  const cwd = args.cwd || process.cwd();
  const client = new ChiefClient(process.env);
  try {
    client.assertConfigured();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.stderr.write('Set claudeCodeLauncher.chief.apiKey / chief.projectId or CHIEF_API_KEY / CHIEF_PROJECT_ID.\n');
    process.exit(1);
  }

  const transcript = new Transcript(args.sessionId, cwd);
  process.stdout.write('Chief REPL - async REST chat via Storytell Chief.\n');
  process.stdout.write(`session=${args.sessionId}${transcript.info.chat_id ? ` chat=${transcript.info.chat_id}` : ''}\n`);
  process.stdout.write('Type /help for commands, /exit to quit.\n');
  if (args.resume) transcript.replay();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    terminal: true,
  });

  rl.prompt();
  rl.on('line', async (line) => {
    rl.pause();
    const text = String(line || '').trim();
    try {
      if (!text) {
        // no-op
      } else if (text.startsWith('/') && await handleSlash(text, client, transcript, cwd)) {
        // handled
      } else {
        await askChief(text, client, transcript);
      }
    } finally {
      rl.resume();
      rl.prompt();
    }
  });
  rl.on('close', () => process.exit(0));
}

main().catch((e) => {
  process.stderr.write(`Chief fatal error: ${e.message}\n`);
  process.exit(1);
});
