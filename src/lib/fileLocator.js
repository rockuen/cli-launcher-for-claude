// @module lib/fileLocator — find a file anywhere on disk by basename, using
// the OS file index, as a last-resort fallback when cwd-relative resolution
// fails.
//
// Why: the reader linkifies bare filenames the agent prints (e.g.
// "_merged_erp_inbound.csv"). When that file lives outside the session cwd,
// resolvePathFragment + the cwd basename walk both miss it, so the click dead-
// ends at "file not found". The OS already maintains a global filename index;
// we query it instead of walking the whole disk ourselves.
//
// Backends (one per platform, all emit one absolute path per line):
//   win32  — Everything CLI `es.exe` (instant, NTFS USN index, ~80ms/call).
//   darwin — Spotlight `mdfind -name` (built in, no install).
//   linux  — `plocate` / `locate -b` (needs an updated locate db).
//
// es.exe is resolved from (in order): a configured path, then common install
// dirs including %LOCALAPPDATA%\Programs\everything-cli (where the extension's
// setup drops it) and Program Files\Everything. If no backend binary exists,
// locateFiles() returns [] and the caller falls back to the existing "not
// found" message — the feature is strictly additive and never throws.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RESULTS = 20;
const MAX_BUFFER = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — no IO, no vscode.
// ---------------------------------------------------------------------------

// Turn an index tool's stdout (one absolute path per line) into clean
// candidate paths: trim, drop blanks, keep only exact-basename matches, remove
// recycle-bin / trash + (by default) node_modules / .git noise, dedupe, cap.
// Existence + file-vs-dir is verified by the IO layer, not here.
//   caseInsensitive defaults true (Windows + macOS); pass false on Linux.
function parseLocatorOutput(stdout, targetBasename, opts = {}) {
  if (typeof stdout !== 'string' || !targetBasename) return [];
  const max = typeof opts.maxResults === 'number' && opts.maxResults > 0
    ? opts.maxResults
    : DEFAULT_MAX_RESULTS;
  const excludeNodeModules = opts.excludeNodeModules !== false;
  const caseInsensitive = opts.caseInsensitive !== false;

  const want = caseInsensitive ? targetBasename.toLowerCase() : targetBasename;
  const seen = new Set();
  const out = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Exact basename match only. Index tools return substring hits and shortcut
    // (.lnk) wrappers — "_merged_erp_inbound.csv.lnk" is a different basename
    // than "_merged_erp_inbound.csv", so it drops out here automatically.
    const base = path.basename(line);
    const baseCmp = caseInsensitive ? base.toLowerCase() : base;
    if (baseCmp !== want) continue;

    // Path noise: recycle bin, trash, and (by default) dependency / vcs dirs.
    const norm = line.replace(/\\/g, '/');
    if (/\/\$recycle\.bin\//i.test(norm)) continue;
    if (/\/\.trash(es)?\//i.test(norm)) continue;
    if (excludeNodeModules && /\/node_modules\//i.test(norm)) continue;
    if (/\/\.git\//i.test(norm)) continue;

    const key = caseInsensitive ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

// Everything search syntax: wfn: = whole-filename match (keeps the index from
// returning substring hits). We still post-filter by basename because wfn: can
// still match inside $Recycle.Bin etc.
function buildEsArgs(basename, maxResults) {
  const max = typeof maxResults === 'number' && maxResults > 0 ? maxResults : DEFAULT_MAX_RESULTS;
  return ['-n', String(max), 'wfn:' + basename];
}

// Spotlight: -name matches the file name (not the full path); prints full paths.
function buildMdfindArgs(basename) {
  return ['-name', basename];
}

// plocate / classic locate: -b basename, -i case-insensitive, -l limit.
function buildLocateArgs(basename, maxResults) {
  const max = typeof maxResults === 'number' && maxResults > 0 ? maxResults : DEFAULT_MAX_RESULTS;
  return ['-i', '-b', '-l', String(max), basename];
}

// ---------------------------------------------------------------------------
// IO layer — spawns the backend, tolerates every failure by returning [].
// ---------------------------------------------------------------------------

function _candidateEsPaths(configPath) {
  const list = [];
  if (configPath) list.push(configPath);
  const lad = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (lad) list.push(path.join(lad, 'Programs', 'everything-cli', 'es.exe'));
  list.push(path.join(pf, 'Everything', 'es.exe'));
  list.push(path.join(pf86, 'Everything', 'es.exe'));
  return list;
}

// First existing es.exe among the configured path + common install dirs, or
// null. Not cached: the probe is a handful of existsSync calls and only runs
// when a file link already missed every cheaper resolution step.
function resolveEsBinary(configPath) {
  for (const p of _candidateEsPaths(configPath)) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

function _run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    try {
      const child = execFile(
        bin,
        args,
        { timeout: timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout) => {
          // ENOENT / timeout / non-zero exit → treat as "no results".
          if (err) { finish(''); return; }
          finish(typeof stdout === 'string' ? stdout : String(stdout || ''));
        }
      );
      child.on('error', () => finish(''));
    } catch (_) {
      finish('');
    }
  });
}

// Locate existing FILES (not dirs) matching `basename` via the OS index.
// Returns absolute paths; [] when the backend is unavailable or nothing matches.
async function locateFiles(basename, opts = {}) {
  if (!basename) return [];
  const platform = opts.platform || process.platform;
  const max = typeof opts.maxResults === 'number' && opts.maxResults > 0
    ? opts.maxResults
    : DEFAULT_MAX_RESULTS;

  let bin;
  let args;
  let caseInsensitive = true;

  // Fetch more than `max` from the index: our basename + noise filters
  // (recycle bin / node_modules / .git / .lnk) run AFTER the backend's own
  // result cap. A small `max` could otherwise be consumed entirely by
  // $Recycle.Bin hits (which sort first) and hide the real file. We over-fetch,
  // then filter, then cap to `max` in parseLocatorOutput.
  const fetchN = Math.max(max * 5, 50);

  if (platform === 'win32') {
    bin = resolveEsBinary(opts.esPath);
    if (!bin) return [];
    args = buildEsArgs(basename, fetchN);
  } else if (platform === 'darwin') {
    bin = 'mdfind';
    args = buildMdfindArgs(basename);
  } else {
    bin = opts.locateBin || 'plocate';
    args = buildLocateArgs(basename, fetchN);
    caseInsensitive = false; // Linux filesystems are case-sensitive
  }

  let stdout = await _run(bin, args, opts.timeoutMs);
  // Linux: plocate may be absent — fall back to classic locate once.
  if (!stdout && platform !== 'win32' && platform !== 'darwin' && bin === 'plocate') {
    stdout = await _run('locate', buildLocateArgs(basename, fetchN), opts.timeoutMs);
  }

  const candidates = parseLocatorOutput(stdout, basename, {
    maxResults: max,
    excludeNodeModules: opts.excludeNodeModules,
    caseInsensitive,
  });

  // Verify each still exists and is a regular file (the index can lag deletes).
  const files = [];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) files.push(c);
    } catch (_) { /* stale index entry — skip */ }
  }
  return files;
}

// Cheap check the caller can use to decide whether to even attempt a search.
function isLocatorAvailable(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return !!resolveEsBinary(opts.esPath);
  return true; // mdfind / locate assumed present on mac / linux
}

module.exports = {
  parseLocatorOutput,
  buildEsArgs,
  buildMdfindArgs,
  buildLocateArgs,
  resolveEsBinary,
  locateFiles,
  isLocatorAvailable,
};
