// @module handlers/claudeChannelSetup — Claude Code 텔레그램 "channels" 풀 셋업 마법사.
//
// Claude Code의 네이티브 channels(연구 미리보기)로 폰 텔레그램 ↔ Claude 세션을
// 양방향 연결한다(chat bridge). gjc 텔레그램(handlers/telegramSettings.js,
// 단방향 알림)과는 대상·방향·메커니즘이 완전히 다른 별개 기능이다.
//
// 마법사가 비대화(셸 미경유)로 자동화하는 것:
//   1) claude plugin marketplace add anthropics/claude-plugins-official
//   2) claude plugin install telegram@claude-plugins-official --scope user
//   3) 봇 토큰을 ~/.claude/channels/telegram/.env 에 저장 (TELEGRAM_BOT_TOKEN=)
//   4) 런처 설정 claude.channels.telegram.enabled = true → 이후 새 Claude 세션은
//      createPanel이 `--channels plugin:telegram@claude-plugins-official`로 시작
//      (src/lib/claudeChannels.js).
//
// 자동화 불가(보안상 사용자 개입 필수) = 봇 페어링: 사용자가 폰에서 봇에 메시지를
// 보내면 봇이 페어링 코드를 회신 → 세션 안에서 `/telegram:access pair <code>` →
// `/telegram:access policy allowlist`. 마법사는 채널 켠 세션을 띄우고 이 절차를 안내만.
//
// 전제조건: Claude Code >= 2.1.80, Bun 설치(채널 플러그인이 bun 스크립트),
// claude.ai 또는 Console API key 인증(Bedrock/Vertex/Foundry 불가). 연구 미리보기.
//
// 보안: 봇 토큰은 셸/터미널 히스토리에 노출하지 않는다 — plugin 명령은 execFile로
// 셸을 거치지 않고, 토큰은 파일에만 0600으로 쓴다. 에러 메시지의 토큰은 마스킹한다.
//
// 단위 테스트는 순수 헬퍼(parseClaudeVersion / isVersionSupported / isValidBotToken /
// telegramEnvPath / buildEnvFileContent / buildMarketplaceAddArgs /
// buildPluginInstallArgs)를 vscode 없이 검증한다. 그래서 vscode require를 가드한다.

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { resolveClaudeCli } = require('../pty/resolveCli');

// vscode는 확장 런타임에서만 존재. node:test가 순수 헬퍼를 require할 수 있도록 가드.
let vscode = null;
try { vscode = require('vscode'); } catch (_) { vscode = null; }

// 채널(channels, 연구 미리보기)이 도입된 Claude Code 최소 버전.
const MIN_CLAUDE_VERSION = [2, 1, 80];
const TELEGRAM_MARKETPLACE = 'anthropics/claude-plugins-official';
const TELEGRAM_PLUGIN = 'telegram@claude-plugins-official';
const TELEGRAM_CHANNEL_ENABLED_KEY = 'claude.channels.telegram.enabled';

// ===========================================================================
// 순수 헬퍼 (vscode 비의존 — 단위 테스트 대상)
// ===========================================================================

// `claude --version` 출력에서 semver [major, minor, patch] 추출. 실패 시 null.
function parseClaudeVersion(versionOutput) {
  if (versionOutput == null) return null;
  const m = String(versionOutput).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// parsed 버전이 min(기본 2.1.80) 이상인지.
function isVersionSupported(parsed, min = MIN_CLAUDE_VERSION) {
  if (!Array.isArray(parsed) || parsed.length < 3) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = Number(parsed[i]);
    const b = Number(min[i]);
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // 정확히 같음 → 지원
}

// 텔레그램 봇 토큰 형식: "<bot_id 숫자>:<영숫자·_·- 30자 이상>" (BotFather 형태).
function isValidBotToken(token) {
  if (typeof token !== 'string') return false;
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

// 텔레그램 채널 토큰 .env 절대경로: ~/.claude/channels/telegram/.env
function telegramEnvPath(homeDir) {
  const home = homeDir || os.homedir();
  return path.join(home, '.claude', 'channels', 'telegram', '.env');
}

// .env 파일 내용(끝 개행 포함). 토큰은 trim.
function buildEnvFileContent(token) {
  return 'TELEGRAM_BOT_TOKEN=' + String(token).trim() + '\n';
}

// `claude plugin marketplace add <marketplace>` 인자.
function buildMarketplaceAddArgs() {
  return ['plugin', 'marketplace', 'add', TELEGRAM_MARKETPLACE];
}

// `claude plugin install <plugin> --scope user` 인자.
function buildPluginInstallArgs() {
  return ['plugin', 'install', TELEGRAM_PLUGIN, '--scope', 'user'];
}

// 에러 메시지에 토큰이 섞여 나오면 마스킹.
function redactToken(message, token) {
  if (!message) return '';
  let out = String(message);
  if (token) out = out.split(token).join('***');
  return out;
}

// ===========================================================================
// claude / bun 실행 (비동기, 비블로킹)
// ===========================================================================

// resolveClaudeCli()로 실행 경로를 얻어 execFile로 실행(셸 미경유 → 인자 노출 없음).
function runClaude(args, opts = {}) {
  return new Promise((resolve) => {
    const resolved = resolveClaudeCli();
    if (!resolved || !resolved.shell) {
      resolve({ ok: false, error: 'claude-not-found', stdout: '', stderr: '' });
      return;
    }
    const fullArgs = [...(resolved.args || []), ...args];
    execFile(
      resolved.shell,
      fullArgs,
      { timeout: opts.timeout || 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts.spawn },
      (err, stdout, stderr) => {
        const out = (stdout || '').toString();
        const errOut = (stderr || '').toString();
        if (err) resolve({ ok: false, error: errOut || err.message || String(err), stdout: out, stderr: errOut });
        else resolve({ ok: true, error: null, stdout: out, stderr: errOut });
      },
    );
  });
}

// bun 설치 확인(채널 플러그인은 bun 스크립트). 실패는 비치명(경고만).
function checkBun() {
  return new Promise((resolve) => {
    execFile('bun', ['--version'], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      resolve(err ? { ok: false, version: null } : { ok: true, version: (stdout || '').toString().trim() });
    });
  });
}

// claude 버전 게이트 확인.
async function checkClaudeVersion() {
  const res = await runClaude(['--version'], { timeout: 8000 });
  const parsed = res.ok ? parseClaudeVersion(res.stdout) : null;
  return { ok: res.ok, parsed, supported: isVersionSupported(parsed), raw: res.stdout };
}

// ===========================================================================
// 런처 설정 미러 + 알림
// ===========================================================================

function _config() {
  if (!vscode) return null;
  return vscode.workspace.getConfiguration('claudeCodeLauncher');
}

async function _setEnabled(on) {
  const cfg = _config();
  if (!cfg) return;
  await cfg.update(TELEGRAM_CHANNEL_ENABLED_KEY, !!on, vscode.ConfigurationTarget.Global);
}

function _showError(message) { if (vscode) vscode.window.showErrorMessage(message); }
function _showInfo(message) { if (vscode) vscode.window.showInformationMessage(message); }
function _showWarn(message) { if (vscode) vscode.window.showWarningMessage(message); }

// ===========================================================================
// setup / disable
// ===========================================================================

// 채널 구성의 비대화 단계 전부를 수행(ON). 페어링(사용자 개입)은 제외.
// 반환: { ok, error, bunMissing, pluginInstallFailed }
async function setupTelegramChannel(input = {}) {
  const token = (input.token || '').trim();

  const resolved = resolveClaudeCli();
  if (!resolved || !resolved.shell) {
    _showError('Claude Code CLI(claude)를 찾을 수 없습니다. 설치: npm install -g @anthropic-ai/claude-code');
    return { ok: false, error: 'claude-not-found' };
  }

  // 사전 가드 1: 버전(채널은 2.1.80+). 프로브 실패(타임아웃·첫 실행 지연·출력형식
  // 변화)와 "진짜 구버전"을 구분한다 — resolveClaudeCli는 이미 성공(CLI 존재 확인)
  // 했으므로, 버전 확인 실패를 구버전으로 오판해 정상 설치를 막지 않는다. 진짜 구버전
  // (파싱 성공 + 미달)만 하드 차단하고, 확인 불가(파싱 실패)는 비치명 경고 후 진행.
  const ver = await checkClaudeVersion();
  if (ver.ok && ver.parsed && !ver.supported) {
    _showError('채널(channels)은 Claude Code 2.1.80 이상이 필요합니다. 업데이트: npm install -g @anthropic-ai/claude-code');
    return { ok: false, error: 'unsupported-version' };
  }
  if (!ver.ok || !ver.parsed) {
    _showWarn('Claude 버전을 확인하지 못했습니다(채널은 2.1.80+ 필요). 계속 진행합니다 — 페어링이 안 되면 `claude --version`으로 확인하세요.');
  }
  // 사전 가드 2: 토큰 형식.
  if (!isValidBotToken(token)) {
    _showError('봇 토큰 형식이 올바르지 않습니다. BotFather 토큰 "<숫자>:<영숫자_- 30자 이상>"을 입력하세요.');
    return { ok: false, error: 'invalid-token' };
  }

  // 경고: bun 미설치 — 채널 플러그인은 bun으로 실행된다. 진행은 허용(페어링 시 필요).
  const bun = await checkBun();
  if (!bun.ok) {
    _showWarn('Bun이 감지되지 않았습니다. 텔레그램 채널 플러그인은 Bun으로 실행됩니다. https://bun.sh 에서 설치한 뒤 페어링하세요.');
  }

  // 1) 마켓플레이스 추가. 이미 추가돼 있으면 비-0을 낼 수 있어 치명 처리하지 않음.
  const mkt = await runClaude(buildMarketplaceAddArgs(), { timeout: 60000 });

  // 2) 플러그인 설치. 이미 설치돼 있거나 marketplace가 이미 있으면 비-0일 수 있으므로,
  //    실패해도 중단하지 않고 경고 + 수동 설치 안내로 폴백(토큰/토글은 그대로 진행).
  const inst = await runClaude(buildPluginInstallArgs(), { timeout: 120000 });
  let pluginInstallFailed = false;
  if (!inst.ok) {
    pluginInstallFailed = true;
    _showWarn(
      '텔레그램 플러그인 자동 설치가 확인되지 않았습니다(이미 설치돼 있을 수 있음). '
      + '문제가 있으면 세션에서 `/plugin marketplace add anthropics/claude-plugins-official` 후 '
      + '`/plugin install telegram@claude-plugins-official`를 실행하세요. 상세: '
      + redactToken(inst.error, token),
    );
  }

  // 3) 토큰 .env 저장(0600). 파일에만 기록 — 셸/히스토리 노출 없음.
  try {
    const p = telegramEnvPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buildEnvFileContent(token), { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch (_) { /* Windows 등 chmod 미지원 무시 */ }
  } catch (e) {
    _showError('토큰 저장 실패(' + telegramEnvPath() + '): ' + redactToken(e && e.message, token));
    return { ok: false, error: 'token-write-failed' };
  }

  // 4) 런처 토글 ON → 이후 새 Claude 세션이 --channels로 시작.
  await _setEnabled(true);

  return { ok: true, error: null, bunMissing: !bun.ok, pluginInstallFailed };
}

// 명령 팔레트/설정 UI용 프롬프트 래퍼: 토큰을 password InputBox로 받아 setup 실행,
// 성공 시 페어링 안내 + (선택) 새 Claude 세션 시작.
async function promptAndSetupTelegramChannel() {
  if (!vscode) return { ok: false, error: 'no-vscode' };
  const token = await vscode.window.showInputBox({
    title: 'Claude 텔레그램 채널 설정 (양방향 chat bridge)',
    prompt: 'Telegram 봇 토큰 (BotFather 발급). 폰 텔레그램에서 Claude 세션을 양방향으로 제어합니다.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: '123456789:AA...',
    validateInput: (v) => (isValidBotToken(v) ? undefined : '봇 토큰 형식: "<숫자>:<영숫자_- 30자 이상>" (BotFather 발급)'),
  });
  if (token === undefined) return { ok: false, error: 'cancelled' };

  const result = await setupTelegramChannel({ token });
  if (!result.ok) return result;

  // 페어링(사용자 개입 필수) 안내 + 세션 시작 옵션. plugin 설치가 확인되지 않았으면
  // 성공 토스트가 그 경고를 가리지 않도록 더 신중한 문구로 바꾼다.
  const openNew = '새 Claude 세션 열기';
  const later = '나중에';
  const pairingSteps = '마지막 페어링만 폰에서 하세요: (1) 텔레그램에서 봇에게 아무 메시지나 전송 → '
    + '(2) 봇이 준 코드로 세션에서 /telegram:access pair <코드> → '
    + '(3) /telegram:access policy allowlist 로 본인만 허용.';
  const headline = result.pluginInstallFailed
    ? '채널을 켰지만 텔레그램 플러그인 자동 설치가 확인되지 않았습니다. 페어링 전에 세션에서 /plugin install telegram@claude-plugins-official 로 설치를 확인하세요. '
    : 'Claude 텔레그램 채널이 구성됐습니다. 새 Claude 세션은 자동으로 --channels로 연결됩니다. ';
  const choice = await vscode.window.showInformationMessage(
    headline + pairingSteps,
    openNew, later,
  );
  if (choice === openNew) {
    try { await vscode.commands.executeCommand('claudeCodeLauncher.newClaude'); } catch (_) { /* 명령 부재 무시 */ }
  }
  return result;
}

// 채널 OFF: 런처 토글만 끈다. 플러그인·토큰은 유지(재활성화 즉시 가능). 다음 새
// 세션부터 --channels 없이 시작한다. 이미 열린 세션에는 영향 없음.
async function disableTelegramChannel() {
  await _setEnabled(false);
  _showInfo('Claude 텔레그램 채널을 껐습니다. 이후 새 Claude 세션은 --channels 없이 시작됩니다. (플러그인·토큰은 유지 — 다시 켜면 바로 사용)');
  return { ok: true, error: null };
}

module.exports = {
  // 순수 헬퍼 (테스트 대상)
  parseClaudeVersion,
  isVersionSupported,
  isValidBotToken,
  telegramEnvPath,
  buildEnvFileContent,
  buildMarketplaceAddArgs,
  buildPluginInstallArgs,
  redactToken,
  // 런타임 API
  checkBun,
  checkClaudeVersion,
  setupTelegramChannel,
  promptAndSetupTelegramChannel,
  disableTelegramChannel,
  // 상수
  MIN_CLAUDE_VERSION,
  TELEGRAM_MARKETPLACE,
  TELEGRAM_PLUGIN,
  TELEGRAM_CHANNEL_ENABLED_KEY,
};
