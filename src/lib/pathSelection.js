// @module lib/pathSelection — turn a selection or a reader link target into
// the path it names, and open folders in the OS file manager.
//
// "Open File" / "Open Folder" get whatever the user dragged over, and agent
// output rarely hands over a clean path:
//
//   - Claude Code (Ink) hard-wraps long lines and indents the continuation,
//     so a path selected across two rows arrives as "C:\obsidian\Won's 2nd\n
//     Brain\notes" — newline plus indent in the middle.
//   - Prose wraps it: `src/foo.ts`, "C:\x", (see C:\x), C:\x., and Korean
//     particles glued to the end: C:\dev\foo에, `README.md`를.
//   - Tool lines: Read(src/foo.ts), Write(C:\x\y.md).
//   - Locations: foo.ts:12, foo.ts:12:5, foo.cs(12,5), foo.md#L12.
//   - Other path shapes on Windows: file:///C:/x, Git Bash /c/x, WSL /mnt/c/x.
//
// pathCandidates() lists every reading of the text, most literal first, and
// resolveSelection() returns the first one that exists. Existence is the
// judge, so a loose reading (a stripped particle) only wins when the literal
// text names nothing — a folder really called "foo에" still opens as itself.
//
// openFolderCommand(): until 3.30.1 a folder opened as `explorer <path>` with
// Node's default quoting. explorer.exe does not parse its command line the
// way the C runtime does, and it falls back to Documents when it cannot read
// the path. Two shapes did that (checked on Windows 11 against the windows
// explorer actually opened):
//   - spaces plus a trailing backslash: Node quotes C:\a b\ as "C:\a b\\",
//     and explorer gets `C:\a b\\`. Folders printed with a trailing slash
//     (`4. Projects/foo/`) inside a path with spaces (the vault, OneDrive)
//     opened Documents every time.
//   - a comma: Node does not quote C:\a,b (no space) and explorer splits at
//     the comma.
// Passing the path verbatim inside quotes with the trailing separator removed
// opens the right folder for commas, spaces, &, %, apostrophes, Hangul and a
// drive root. A file is revealed with /select, so its folder opens with the
// file highlighted instead of only its parent.
//
// Paths come from text an agent printed, so none of this goes through a
// shell, a file:// host never becomes a UNC path, and the input is capped.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OPENERS = '\'"`‘“«「『《〈<';
const CLOSERS = '\'"`’”»」』》〉>';
const TRAILING_PUNCT = '.,;:!?。、，…';
const LEADING_MARKERS = /^(?:[⏺●•◦▪⎿└├│→>*-]\s*)+/;
// Read(src/foo.ts), Write(C:\x\y.md) — but not Backup(2) or Makefile(12):
// the argument has to look like a path (a separator, a dot or ~).
const TOOL_CALL = /^[A-Za-z][\w-]*\((.+)\)$/;
const PATHISH = /[\\/.~]/;
// Selections longer than this are not a path; reading them only costs time
// on the extension host thread.
const MAX_INPUT = 8192;
// One to three Hangul syllables glued to the end of a path-looking token —
// Korean particles (에, 를, 에서, 으로, 까지…). Only stripped after a character
// that can end a path name, never after a separator or a space.
const TRAILING_PARTICLE = /([A-Za-z0-9_\-.)\]}'"`])[\uAC00-\uD7A3]{1,3}$/;
const MAX_JOIN_ROWS = 6;
const MAX_ROWS = 10;

function stripWrappers(input) {
  let s = input.trim();
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(LEADING_MARKERS, '');
    const tool = s.match(TOOL_CALL);
    if (tool && PATHISH.test(tool[1])) s = tool[1].trim();
    if (s && OPENERS.includes(s[0])) s = s.slice(1);
    if (s && CLOSERS.includes(s[s.length - 1])) s = s.slice(0, -1);
    // Brackets: drop an opener that never closes / a closer that never opened,
    // so "C:\Program Files (x86)" keeps its parentheses.
    for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const opens = s.split(o).length - 1;
      const closes = s.split(c).length - 1;
      if (s.startsWith(o) && opens > closes) s = s.slice(1);
      else if (s.endsWith(c) && closes > opens) s = s.slice(0, -1);
    }
    // Trailing punctuation, trimmed by hand: a `[…]+$` regex is quadratic on
    // a long run of punctuation that is not at the end.
    let end = s.length;
    while (end > 0 && TRAILING_PUNCT.includes(s[end - 1])) end--;
    s = s.slice(0, end).trim();
    if (s === before) break;
  }
  return s;
}

function stripParticle(s) {
  return s.replace(TRAILING_PARTICLE, '$1');
}

// file:// URLs (decoded), plus the Windows-only shapes that name a drive path:
// /C:/x (a file URL's path), /c/x (Git Bash), /mnt/c/x (WSL).
// The host of file://host/x is dropped, as the reader always did: turning it
// into \\host\x would make the existence check open an SMB connection (and
// send NTLM credentials) to a host named in agent output.
function convertShapes(s, platform) {
  const out = [];
  let p = s;
  if (/^file:\/\//i.test(p)) {
    // file://C:/x (two slashes, common in agent output) carries the drive
    // where the host goes; keep it as the drive.
    const drive = p.match(/^file:\/\/([A-Za-z]:)(?=[\\/]|$)/i);
    let rest = drive ? '/' + p.slice('file://'.length) : p.replace(/^file:\/\/[^/]*/i, '');
    try { rest = decodeURIComponent(rest); } catch (_) { /* keep raw */ }
    p = rest;
  }
  if (platform === 'win32') {
    let m;
    if ((m = p.match(/^\/([A-Za-z]:(?:[\\/].*)?)$/))) out.push(m[1]);
    else if ((m = p.match(/^\/mnt\/([A-Za-z])(?:([\\/].*))?$/))) out.push(m[1].toUpperCase() + ':' + (m[2] || '/'));
    // Git Bash only with a folder after the drive: a bare "/d" is not read as D:\.
    else if ((m = p.match(/^\/([A-Za-z])([\\/].+)$/))) out.push(m[1].toUpperCase() + ':' + m[2]);
  }
  out.push(p);
  return out;
}

// foo.ts:12 / foo.ts:12:5 / foo.cs(12,5) / foo.md#L12 / foo.md#L12-L20
function splitLineSuffix(s) {
  let m = s.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (m && m[1] && !/^[A-Za-z]$/.test(m[1])) return { path: m[1], line: parseInt(m[2], 10) };
  m = s.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/);
  if (m && m[1]) return { path: m[1], line: parseInt(m[2], 10) };
  m = s.match(/^(.*?)\((\d+)(?:,\s*\d+)?\)$/);
  if (m && m[1]) return { path: m[1], line: parseInt(m[2], 10) };
  return null;
}

function rows(raw) {
  const text = String(raw == null ? '' : raw);
  if (text.length > MAX_INPUT) return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// The selection on one line, shortened, for warnings and toasts.
function previewText(raw) {
  const flat = String(raw == null ? '' : raw).slice(0, 400).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 80) + '…' : flat;
}

// Every reading of `raw` as a path, most literal first, de-duplicated.
// Returns [{ path, line, partial }] — line is 0 when the text carried none;
// partial marks a reading made from one row of a multi-row selection.
function pathCandidates(raw, opts) {
  const platform = (opts && opts.platform) || process.platform;
  const lines = rows(raw);
  if (!lines.length) return [];

  // A wrapped path first (rows joined, continuation indent dropped), then
  // each row on its own (several paths selected at once: the first one wins).
  // Ink breaks inside a long word with no space, but at a space it drops the
  // space, so both joins are tried. Capped: a path wraps over a few rows at
  // most, and every reading costs a handful of existsSync calls.
  const bases = lines.length === 1 ? [{ text: lines[0], partial: false }]
    : (lines.length <= MAX_JOIN_ROWS
      ? [{ text: lines.join(''), partial: false }, { text: lines.join(' '), partial: false }]
      : []).concat(lines.slice(0, MAX_ROWS).map((text) => ({ text, partial: true })));

  const out = [];
  const seen = new Set();
  const add = (p, line, partial) => {
    const v = String(p || '').trim();
    if (!v) return;
    const key = v + '\u0000' + line;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: v, line, partial });
  };

  for (const base of bases) {
    const stripped = stripWrappers(base.text);
    const variants = [base.text, stripped, stripWrappers(stripParticle(stripped))];
    for (const v of variants) {
      for (const shape of convertShapes(v, platform)) {
        add(shape, 0, base.partial);
        const ls = splitLineSuffix(shape);
        if (ls) add(ls.path, ls.line, base.partial);
      }
    }
  }
  return out;
}

function expandHome(p) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Resolve a possibly-partial path to an existing absolute path.
// Tries (in order): absolute, cwd+frag, walk up cwd ancestors, homedir, platform roots.
// Returns first existing candidate, or null.
function resolvePathFragment(frag, cwd) {
  if (!frag) return null;

  const normalize = (p) => p.replace(/\\/g, '/').replace(/\//g, path.sep);

  if (path.isAbsolute(frag)) {
    const abs = normalize(frag);
    if (fs.existsSync(abs)) return abs;
    frag = frag.replace(/^[\\/]+/, '');
    if (!frag) return null;
  }

  const candidates = [];
  if (cwd) candidates.push(path.join(cwd, frag));

  let current = cwd;
  while (current) {
    const parent = path.dirname(current);
    if (parent === current) break;
    candidates.push(path.join(parent, frag));
    current = parent;
  }

  candidates.push(path.join(os.homedir(), frag));
  if (process.platform === 'darwin') candidates.push(path.join('/Users', frag));
  else if (process.platform === 'linux') candidates.push(path.join('/home', frag));

  for (const c of candidates) {
    const n = normalize(c);
    if (fs.existsSync(n)) return n;
  }
  return null;
}

// The first candidate of `raw` that exists. Returns { path, line, isDir } or
// null. A folder named by one row of a multi-row selection is skipped unless
// opts.partialDirs: that is often the first half of a wrapped path selected
// only in part ("<repo>\src\" + "hand…"), so the callers try their basename
// walk and OS-index search first and ask for it only as a last resort (it is
// also a folder path followed by a row of prose).
function resolveSelection(raw, cwd, opts) {
  const partialDirs = !!(opts && opts.partialDirs);
  const candidates = pathCandidates(raw, opts);
  for (const c of candidates) {
    if (partialDirs && !c.partial) continue; // already tried without the flag
    const abs = resolvePathFragment(expandHome(c.path), cwd);
    if (!abs) continue;
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch (_) { continue; }
    if (isDir && c.partial && !partialDirs) continue;
    return { path: abs, line: c.line, isDir };
  }
  return null;
}

// Basename walk under cwd (depth 6, skipping node_modules / .git) for a
// partial path whose start isn't cwd-relative ("slack-manifests/x.yaml" from
// a nested project). A hit whose path ends with the whole fragment wins over
// a bare basename match. dirs=true also accepts folders.
// Returns { path, isDir } or null.
function findUnderCwd(cwd, fragment, opts) {
  if (!cwd || !fragment) return null;
  const dirs = !!(opts && opts.dirs);
  const suffix = String(fragment).replace(/\\/g, '/').replace(/\/+$/, '');
  const basename = path.basename(suffix);
  if (!basename || basename === '.' || basename === '..') return null;
  const found = [];
  (function walk(dir, depth) {
    if (depth > 6 || found.length >= 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === basename && (e.isFile() || (dirs && e.isDirectory()))) found.push({ path: full, isDir: e.isDirectory() });
      else if (e.isDirectory()) walk(full, depth + 1);
    }
  })(cwd, 0);
  return found.find((f) => f.path.replace(/\\/g, '/').endsWith(suffix)) || found[0] || null;
}

// The text the slow fallbacks (cwd basename walk, OS file index) search for
// when no candidate exists: the cleaned reading of the selection (rows
// joined), without its line suffix.
function fallbackQuery(raw, opts) {
  const platform = (opts && opts.platform) || process.platform;
  const lines = rows(raw);
  if (!lines.length) return { path: '', line: 0 };
  const cleaned = stripWrappers(stripParticle(stripWrappers(lines.join(''))));
  const shape = convertShapes(cleaned, platform)[0];
  return splitLineSuffix(shape) || { path: shape, line: 0 };
}

// How to open `target` in the OS file manager. A file is revealed (its folder
// opens with the file selected); a folder opens as itself.
// Returns { command, args, options }.
function openFolderCommand(target, opts) {
  const platform = (opts && opts.platform) || process.platform;
  const reveal = !!(opts && opts.reveal);
  if (platform === 'win32') {
    let p = path.win32.resolve(target);
    // Keep "C:\" whole; drop any other trailing separator (see header).
    if (!/^[A-Za-z]:\\$/.test(p)) p = p.replace(/[\\/]+$/, '');
    if (p.includes('"')) throw new Error('invalid path');
    const quoted = '"' + p + '"';
    // By full path: a bare name is searched from the current directory first.
    const systemRoot = (opts && opts.systemRoot) || process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return {
      command: path.win32.join(systemRoot, 'explorer.exe'),
      args: [reveal ? '/select,' + quoted : quoted],
      options: { detached: true, stdio: 'ignore', windowsVerbatimArguments: true },
    };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: reveal ? ['-R', target] : [target], options: { detached: true, stdio: 'ignore' } };
  }
  return { command: 'xdg-open', args: [reveal ? path.dirname(target) : target], options: { detached: true, stdio: 'ignore' } };
}

module.exports = {
  pathCandidates,
  resolvePathFragment,
  resolveSelection,
  fallbackQuery,
  findUnderCwd,
  openFolderCommand,
  expandHome,
  previewText,
};
