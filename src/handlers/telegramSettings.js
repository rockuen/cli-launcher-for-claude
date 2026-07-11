// @module handlers/telegramSettings — gjc(Gajae Code) 텔레그램 알림 연동 (얇은 래퍼).
//
// 런처는 gjc의 네이티브 텔레그램 데몬을 "설정/감지"만 한다. 데몬의 수명주기,
// 싱글톤(봇 토큰당 long-poll owner 1개), 정리(idleTimeout, 기본 60s)는 전적으로
// gjc가 소유한다. 런처는 능동 `gjc daemon stop`을 호출하지 않으며 참조계수도 두지
// 않는다 — 그래야 같은 머신의 다른(런처 밖) gjc 세션이 쓰는 공유 데몬을 끊지 않는다.
//
//   설정(ON):  gjc notify setup --token <t> --chat-id <id> [--redact]   (비대화·멱등)
//   해제(OFF): gjc config set notifications.enabled false                (권위적 OFF)
//   상태:      gjc daemon status --all --json
//
// 봇 토큰은 child_process 인자 배열로만 전달한다(셸 보간/터미널 히스토리 노출 방지).
// 동기 execFileSync 대신 비동기 execFile을 써서 확장 호스트 스레드를 막지 않는다.
//
// ⚠️ 머신전역: ON/OFF·토큰은 이 머신의 모든 gjc 세션(런처 밖 터미널 포함)에 영향을
//    준다. 설정 UI는 이 점을 사용자에게 고지한다.
//
// 단위 테스트는 순수 헬퍼(parseGjcVersion / isVersionSupported / isValidBotToken /
// isValidChatId / buildNotifySetupArgs / telegramKindPresent)를 vscode 없이 직접
// 검증한다. 그래서 vscode require는 가드한다(node:test 로드 시 throw 방지).

'use strict';

const { execFile } = require('child_process');
const { resolveGjcCli } = require('../pty/resolveCli');

// vscode는 확장 런타임에서만 존재. node:test가 이 모듈을 require해 순수 헬퍼를
// 테스트할 수 있도록 가드한다.
let vscode = null;
try { vscode = require('vscode'); } catch (_) { vscode = null; }

// i18n은 vscode require를 자체 가드하므로 vscode 없이도 로드된다(영어 폴백).
const { t } = require('../i18n');

// gjc 텔레그램 알림 SDK가 도입된 최소 버전.
const MIN_GJC_VERSION = [0, 7, 0];
const TELEGRAM_SUPPORTED_CONTEXT_KEY = 'claudeCodeLauncher.gjc.telegramSupported';

// ===========================================================================
// 순수 헬퍼 (vscode 비의존 — 단위 테스트 대상)
// ===========================================================================

// `gjc --version` 출력에서 semver [major, minor, patch]를 추출. 실패 시 null.
function parseGjcVersion(versionOutput) {
  if (versionOutput == null) return null;
  const m = String(versionOutput).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// parsed 버전이 min(기본 0.7.0) 이상인지.
function isVersionSupported(parsed, min = MIN_GJC_VERSION) {
  if (!Array.isArray(parsed) || parsed.length < 3) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = Number(parsed[i]);
    const b = Number(min[i]);
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // 정확히 같음 → 지원
}

// 텔레그램 봇 토큰 형식: "<bot_id 숫자>:<영숫자·_·- 길이 충분>".
// BotFather 토큰은 "<숫자>:<35자 가량>" 형태. 보수적으로 숫자콜론 + 30자 이상.
function isValidBotToken(token) {
  if (typeof token !== 'string') return false;
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

// chatId: 정수(음수 = 그룹/채널 허용) 또는 @username.
function isValidChatId(chatId) {
  if (typeof chatId !== 'string') return false;
  const v = chatId.trim();
  return /^-?\d+$/.test(v) || /^@[A-Za-z0-9_]{4,}$/.test(v);
}

// `gjc notify setup` 인자 배열. 토큰/챗ID는 인자로만 전달(셸 보간 없음).
function buildNotifySetupArgs(token, chatId, redact) {
  const args = ['notify', 'setup', '--token', String(token).trim(), '--chat-id', String(chatId).trim()];
  if (redact) args.push('--redact');
  return args;
}

// `gjc daemon status --all --json` 출력(JSON 문자열 또는 파싱된 배열)에서
// telegram 데몬 kind 지원 여부.
function telegramKindPresent(daemonStatus) {
  let arr = daemonStatus;
  if (typeof daemonStatus === 'string') {
    try { arr = JSON.parse(daemonStatus); } catch (_) { return false; }
  }
  return Array.isArray(arr) && arr.some((d) => d && d.kind === 'telegram');
}

// ===========================================================================
// gjc 실행 (비동기, 비블로킹)
// ===========================================================================

// resolveGjcCli()로 절대 경로를 얻어 execFile로 실행. 셸을 거치지 않으므로
// 인자(토큰 포함)가 셸 해석/히스토리에 노출되지 않는다.
function runGjc(args, opts = {}) {
  return new Promise((resolve) => {
    const resolved = resolveGjcCli();
    if (!resolved || !resolved.shell) {
      resolve({ ok: false, error: 'gjc-not-found', path: null, stdout: '', stderr: '' });
      return;
    }
    execFile(
      resolved.shell,
      args,
      { timeout: opts.timeout || 8000, windowsHide: true, maxBuffer: 1024 * 1024, ...opts.spawn },
      (err, stdout, stderr) => {
        const out = (stdout || '').toString();
        const errOut = (stderr || '').toString();
        if (err) resolve({ ok: false, error: errOut || err.message || String(err), path: resolved.shell, stdout: out, stderr: errOut });
        else resolve({ ok: true, error: null, path: resolved.shell, stdout: out, stderr: errOut });
      },
    );
  });
}

// ===========================================================================
// 런처 설정 미러 (UI source of truth)
// ===========================================================================

function _config() {
  if (!vscode) return null;
  return vscode.workspace.getConfiguration('claudeCodeLauncher');
}

async function _setLauncherEnabled(on) {
  const cfg = _config();
  if (!cfg) return;
  await cfg.update('gjc.telegram.enabled', !!on, vscode.ConfigurationTarget.Global);
}

function _showError(message) {
  if (vscode) vscode.window.showErrorMessage(message);
}
function _showInfo(message) {
  if (vscode) vscode.window.showInformationMessage(message);
}

// ===========================================================================
// 지원 감지 (비동기 + activate 캐시)
// ===========================================================================

// 캐시는 gjc 경로별로 유효. 경로가 바뀌면(예: 재설치) 자동 무효화.
let _supportCache = null; // { gjcPath: string|null, supported: boolean }

async function _setContextKey(supported) {
  if (!vscode || !vscode.commands || !vscode.commands.executeCommand) return;
  try {
    await vscode.commands.executeCommand('setContext', TELEGRAM_SUPPORTED_CONTEXT_KEY, !!supported);
  } catch (_) { /* setContext 실패는 비치명적 */ }
}

// gjc가 텔레그램을 지원하는지: 버전 ≥0.7.0 AND daemon status에 kind=telegram 존재.
// activate에서 1회 호출해 컨텍스트키를 세팅한다. force로 캐시 무효화 가능.
async function detectTelegramSupport(opts = {}) {
  const force = !!opts.force;
  const resolved = resolveGjcCli();
  const gjcPath = resolved && resolved.shell ? resolved.shell : null;

  if (!gjcPath) {
    _supportCache = { gjcPath: null, supported: false };
    await _setContextKey(false);
    return false;
  }
  if (!force && _supportCache && _supportCache.gjcPath === gjcPath) {
    await _setContextKey(_supportCache.supported);
    return _supportCache.supported;
  }

  const ver = await runGjc(['--version'], { timeout: 6000 });
  const parsed = ver.ok ? parseGjcVersion(ver.stdout) : null;
  const versionOk = isVersionSupported(parsed);

  let kindOk = false;
  if (versionOk) {
    const status = await runGjc(['daemon', 'status', '--all', '--json'], { timeout: 6000 });
    kindOk = status.ok && telegramKindPresent(status.stdout);
  }

  const supported = versionOk && kindOk;
  _supportCache = { gjcPath, supported };
  await _setContextKey(supported);
  return supported;
}

function invalidateTelegramSupportCache() {
  _supportCache = null;
}

// ===========================================================================
// setup / disable / status
// ===========================================================================

// 폼 입력으로 gjc 텔레그램 알림을 구성한다(ON). 사전 가드 → notify setup 위임 →
// 성공 시 런처 enabled=true, 실패 시 OFF 롤백 + 구체 에러.
async function setupTelegram(input = {}) {
  const token = (input.token || '').trim();
  const chatId = (input.chatId || '').trim();
  const redact = !!input.redact;

  const resolved = resolveGjcCli();
  if (!resolved || !resolved.shell) {
    _showError(t('tgGjcNotFound'));
    return { ok: false, error: 'gjc-not-found' };
  }

  // 사전 가드 1: 텔레그램 지원 버전인지.
  const supported = await detectTelegramSupport({ force: true });
  if (!supported) {
    _showError(t('tgUnsupportedVersion'));
    return { ok: false, error: 'unsupported-version' };
  }
  // 사전 가드 2: 입력 형식.
  if (!isValidBotToken(token)) {
    _showError(t('tgInvalidToken'));
    return { ok: false, error: 'invalid-token' };
  }
  if (!isValidChatId(chatId)) {
    _showError(t('tgInvalidChatId'));
    return { ok: false, error: 'invalid-chat-id' };
  }

  // notify setup 위임(비대화·멱등). 토큰은 인자 배열로만.
  const result = await runGjc(buildNotifySetupArgs(token, chatId, redact), { timeout: 30000 });
  if (!result.ok) {
    await _setLauncherEnabled(false); // OFF 롤백
    _showError(t('tgSetupFailed').replace('{0}', _redactToken(result.error, token)));
    return { ok: false, error: 'setup-failed' };
  }

  await _setLauncherEnabled(true);
  _showInfo(t('tgEnabled'));
  return { ok: true, error: null };
}

// 권위적 OFF: gjc config set notifications.enabled false. 다음 세션의 데몬 자동
// 기동을 막는다. 현재 데몬은 gjc idleTimeout(기본 60s)이 정리한다. 런처는 능동
// daemon stop을 호출하지 않는다(외부 세션 보호).
async function disableTelegram() {
  const resolved = resolveGjcCli();
  if (resolved && resolved.shell) {
    const result = await runGjc(['config', 'set', 'notifications.enabled', 'false'], { timeout: 10000 });
    if (!result.ok) {
      _showError(t('tgDisableFailed').replace('{0}', result.error));
      return { ok: false, error: 'disable-failed' };
    }
  }
  await _setLauncherEnabled(false);
  _showInfo(t('tgDisabled'));
  return { ok: true, error: null };
}

// 현재 텔레그램 데몬 상태(관찰 전용). configured/health를 반환.
async function telegramStatus() {
  const result = await runGjc(['daemon', 'status', '--all', '--json'], { timeout: 6000 });
  if (!result.ok) return { ok: false, configured: false, raw: result.error };
  let entry = null;
  try {
    const arr = JSON.parse(result.stdout);
    if (Array.isArray(arr)) entry = arr.find((d) => d && d.kind === 'telegram') || null;
  } catch (_) { /* ignore */ }
  return {
    ok: true,
    configured: !!(entry && entry.configured),
    health: entry ? entry.health : 'unknown',
    raw: result.stdout,
  };
}

// 에러 메시지에 토큰이 섞여 나오면 마스킹.
function _redactToken(message, token) {
  if (!message) return '';
  let out = String(message);
  if (token) out = out.split(token).join('***');
  return out;
}

// 명령 팔레트용 프롬프트 래퍼: 토큰·챗ID·redact를 InputBox/QuickPick로 받아 setupTelegram 호출.
// 토큰 InputBox는 password 모드로 화면 노출을 줄인다.
async function promptAndSetupTelegram() {
  if (!vscode) return { ok: false, error: 'no-vscode' };
  const token = await vscode.window.showInputBox({
    title: t('tgSettingsTitle'),
    prompt: t('tgTokenPrompt'),
    password: true,
    ignoreFocusOut: true,
    placeHolder: '123456789:AA...',
  });
  if (token === undefined) return { ok: false, error: 'cancelled' };
  const chatId = await vscode.window.showInputBox({
    title: t('tgSettingsTitle'),
    prompt: t('tgChatIdPrompt'),
    ignoreFocusOut: true,
    placeHolder: '123456789',
  });
  if (chatId === undefined) return { ok: false, error: 'cancelled' };
  const redactPick = await vscode.window.showQuickPick(
    [
      { label: t('tgRedactOff'), _redact: false },
      { label: t('tgRedactOn'), _redact: true },
    ],
    { title: t('tgRedactTitle'), placeHolder: t('tgRedactPlaceholder') },
  );
  if (!redactPick) return { ok: false, error: 'cancelled' };
  return setupTelegram({ token, chatId, redact: redactPick._redact });
}

module.exports = {
  // 순수 헬퍼 (테스트 대상)
  parseGjcVersion,
  isVersionSupported,
  isValidBotToken,
  isValidChatId,
  buildNotifySetupArgs,
  telegramKindPresent,
  // 런타임 API
  detectTelegramSupport,
  invalidateTelegramSupportCache,
  setupTelegram,
  promptAndSetupTelegram,
  disableTelegram,
  telegramStatus,
  // 상수
  MIN_GJC_VERSION,
  TELEGRAM_SUPPORTED_CONTEXT_KEY,
};
