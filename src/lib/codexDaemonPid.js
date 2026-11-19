// Stale Codex app-server daemon PID files.
//
// Codex 0.165+ runs its TUI (new session, resume, fork) through an app-server
// daemon kept per CODEX_HOME, and remembers it in
// <CODEX_HOME>/app-server-daemon/daemon.pid as {"pid":N,"processStartTime":"…"}.
// On the next launch Codex opens that PID to see whether its daemon still runs.
// After a reboot the PID usually belongs to some other process. Codex copes when
// that PID is gone, or is a process this user may open (the start time differs),
// but when the new owner is a process this user may not open — a service such
// as svchost.exe — opening it fails and Codex quits before the TUI starts:
//
//   Error: failed to open daemon process: Access is denied. (os error 5)
//
// Measured on Windows with Codex 0.169.1 and 0.170.0 (2026-11-19). A stale
// daemon-updater.pid of the same shape only prints "failed to ensure managed
// updater …", but is cleared by the same rule. Whether Codex on macOS / Linux
// fails the same way is not verified; the same rule is applied there.
//
// A daemon Codex started for this user can always be signalled by this user, so
// a PID that cannot be (EPERM) is either a daemon started from an elevated
// window or not the daemon at all. It is not the daemon when
//   - (Windows) the file's processStartTime is from before this boot, or
//   - the process holding the PID now is not a codex process;
// then the file is stale and is removed before Codex reads it. Anything this
// cannot tell is left alone. Deleting the file is harmless to a Codex that is
// reading it (Rust opens files with FILE_SHARE_DELETE); it starts a new daemon.
// Another Codex can still write a fresh file between the re-read and the delete
// below; that window is a few microseconds and costs no more than the failure
// this prevents.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PID_FILES = ['daemon.pid', 'daemon-updater.pid'];

// FILETIME (100 ns since 1601-01-01 UTC) → Unix ms.
const FILETIME_UNIX_EPOCH_MS = 11644473600000n;
// os.uptime() is whole seconds on some platforms and boot is not one instant.
const BOOT_MARGIN_MS = 2 * 60 * 1000;

function codexHomeOf(env, cwd) {
  const fromEnv = env && env.CODEX_HOME;
  if (fromEnv) return path.resolve(cwd || process.cwd(), fromEnv);
  return path.join(os.homedir(), '.codex');
}

function readRecord(text) {
  try {
    const rec = JSON.parse(text);
    const pid = rec && rec.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startTime: rec.processStartTime };
  } catch (_) {
    return null;
  }
}

function readPid(text) {
  const rec = readRecord(text);
  return rec ? rec.pid : null;
}

// Windows processStartTime → Unix ms, or null.
function startTimeMs(value) {
  if (typeof value !== 'string' || !/^\d{15,20}$/.test(value)) return null;
  const ms = BigInt(value) / 10000n - FILETIME_UNIX_EPOCH_MS;
  return ms > 0n ? Number(ms) : null;
}

function bootTimeMs() {
  return Date.now() - os.uptime() * 1000;
}

// Did the recorded process start before this boot? Only Windows stores a
// FILETIME; Fast Startup makes uptime count from an older full boot, which
// only makes this say "no" more often.
function startedBeforeBoot(rec, bootMs = bootTimeMs(), platform = process.platform) {
  if (platform !== 'win32') return false;
  const ms = startTimeMs(rec.startTime);
  return ms !== null && ms < bootMs - BOOT_MARGIN_MS;
}

// 'alive' | 'gone' | 'denied' | 'unknown'
function signalProbe(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    if (e && e.code === 'EPERM') return 'denied';
    if (e && e.code === 'ESRCH') return 'gone';
    return 'unknown';
  }
}

// Image name for pid in `tasklist /FO CSV /NH` output; '' when absent (the
// "INFO: No tasks …" line is localized, so anything but a CSV row is ignored).
function parseTasklistCsv(out, pid) {
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1];
  }
  return '';
}

// `ps -o comm=` prints a full path on macOS, and "(name)" when it may not read
// another user's process details.
function parsePsComm(out) {
  const name = String(out).trim().replace(/^\((.*)\)$/, '$1');
  return name ? path.basename(name) : '';
}

const EXEC_OPTS = { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };

function tasklistPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
}

// Image name of a running PID; '' when there is no such process; null when it
// cannot be told. About 0.45 s on Windows (listing every process takes 1.5-2 s),
// and only reached for a PID this user may not signal.
function imageName(pid, exec = execFileSync, platform = process.platform) {
  if (platform === 'win32') {
    try {
      // tasklist names every process without opening it, services included.
      return parseTasklistCsv(exec(tasklistPath(), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], EXEC_OPTS), pid);
    } catch (_) {
      return null;
    }
  }
  try {
    const name = parsePsComm(exec(fs.existsSync('/bin/ps') ? '/bin/ps' : 'ps', ['-o', 'comm=', '-p', String(pid)], EXEC_OPTS));
    // The process exists (it refused a signal), so a blank answer means ps
    // could not see it (hidepid), not that it is gone.
    return name || null;
  } catch (_) {
    // ps exits 1 for "no such process" and for usage errors alike.
    return null;
  }
}

// imageName that asks once per PID (both files can name the same one).
function imageLookup(lookup = imageName) {
  const seen = new Map();
  return (pid) => {
    if (!seen.has(pid)) seen.set(pid, lookup(pid));
    return seen.get(pid);
  };
}

function isCodexImage(name) {
  return /^codex(\.exe)?$/i.test(name);
}

// Files looked at and kept, by path and content, so a PID an elevated Codex
// holds (or one that cannot be told) is not looked up again on every spawn.
const keptRecords = new Map();
const KEPT_MAX = 32;

function rememberKept(key) {
  if (keptRecords.size >= KEPT_MAX) keptRecords.delete(keptRecords.keys().next().value);
  keptRecords.set(key, true);
}

/**
 * Remove daemon PID files under codexHome that point at a process which cannot
 * be the Codex daemon (see the top of this file). Never throws.
 * @param {string} codexHome
 * @param {{ signalProbe?: (pid: number) => string, imageName?: (pid: number) => (string|null), bootTimeMs?: number, platform?: string }} [deps]
 * @returns {{ file: string, pid: number, image: string, reason: string }[]} the files removed
 */
function clearStaleCodexDaemonPids(codexHome, deps = {}) {
  const probe = deps.signalProbe || signalProbe;
  const image = deps.imageName || imageLookup();
  const platform = deps.platform || process.platform;
  const removed = [];
  if (!codexHome) return removed;
  const dir = path.join(codexHome, 'app-server-daemon');
  let bootMs;
  for (const name of PID_FILES) {
    const file = path.join(dir, name);
    try {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (_) {
        continue;
      }
      const rec = readRecord(text);
      if (!rec) continue;
      // alive: Codex compares the start time itself. gone: Codex starts a new one.
      if (probe(rec.pid) !== 'denied') continue;
      const key = `${file}\0${text}`;
      if (keptRecords.has(key)) continue;
      if (bootMs === undefined) bootMs = deps.bootTimeMs !== undefined ? deps.bootTimeMs : bootTimeMs();
      let img = '';
      let reason = 'before-boot';
      if (!startedBeforeBoot(rec, bootMs, platform)) {
        img = image(rec.pid);
        reason = 'not-codex';
        if (img === null || isCodexImage(img)) {
          rememberKept(key);
          continue;
        }
      }
      // Another codex may have written a fresh file in the meantime.
      if (fs.readFileSync(file, 'utf8') !== text) continue;
      fs.unlinkSync(file);
      removed.push({ file, pid: rec.pid, image: img, reason });
    } catch (_) {}
  }
  return removed;
}

// For a Codex spawn: the CODEX_HOME that env gives it (~/.codex when unset).
// A tmux / psmux tab runs Codex with the multiplexer server's environment, which
// can name another home; the check is still safe there, only maybe idle.
function clearCodexDaemonPidsFor(env, cwd) {
  try {
    for (const r of clearStaleCodexDaemonPids(codexHomeOf(env, cwd))) {
      const why = r.reason === 'before-boot' ? 'started before this boot' : `is now ${r.image || 'gone'}`;
      console.log(`[Claude Launcher] removed stale Codex ${path.basename(r.file)}: pid ${r.pid} ${why}`);
    }
  } catch (_) {}
}

module.exports = {
  clearStaleCodexDaemonPids,
  clearCodexDaemonPidsFor,
  codexHomeOf,
  _test: {
    readPid,
    readRecord,
    startTimeMs,
    startedBeforeBoot,
    signalProbe,
    imageName,
    imageLookup,
    parseTasklistCsv,
    parsePsComm,
    isCodexImage,
    keptRecords,
    PID_FILES,
  },
};
