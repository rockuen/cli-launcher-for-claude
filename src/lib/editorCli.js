// @module lib/editorCli — open (or focus) an editor window on a folder, so a
// deep link can reach the window that owns a session's working directory.
//
// Why not `vscode.openFolder`: it either hijacks the current window or forces
// a brand new one — it cannot focus an EXISTING window that already has that
// folder open. Handing the folder to the editor's own launcher does exactly
// that routing (existing window → focus, otherwise → new window).
//
// SECURITY: the folder argument arrives from a URI that anything on the machine
// can fire, so it never reaches a shell. Windows spawns the editor executable
// directly (arguments as an array, no `.cmd` and therefore no shell quoting);
// POSIX spawns the launcher script the same way. The path is also required to
// be an existing directory, which is what a quoting-escape payload would fail.

const fs = require('fs');
const path = require('path');

/**
 * Directories that may hold the launcher CLI, most likely first.
 *   macOS:  <App>.app/Contents/Resources/app/bin
 *   Linux:  <install>/bin, with appRoot = <install>/resources/app
 * @param {string} appRoot vscode.env.appRoot
 */
function cliDirCandidates(appRoot) {
  if (!appRoot) return [];
  return [
    path.join(appRoot, 'bin'),
    path.join(appRoot, '..', '..', 'bin'),
  ];
}

/**
 * Pick the launcher entry out of a bin directory listing. The product name
 * varies (code / codium / cursor), so it is discovered rather than hardcoded;
 * `*-tunnel*` is the remote-tunnel binary, never the launcher.
 * @param {string[]} names directory entries
 * @returns {string|null}
 */
function pickCliName(names) {
  const list = (names || []).filter((n) => n && !/tunnel/i.test(n));
  return list.find((n) => !path.extname(n)) || null;
}

/**
 * Resolve the POSIX launcher script, or null when it cannot be found.
 * @param {string} appRoot vscode.env.appRoot
 */
function findEditorCli(appRoot) {
  for (const dir of cliDirCandidates(appRoot)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    const picked = pickCliName(names);
    if (picked) {
      const full = path.join(dir, picked);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** Only an existing directory is ever handed to a spawn. */
function isExistingDirectory(folder) {
  if (!folder || typeof folder !== 'string') return false;
  try {
    return fs.statSync(folder).isDirectory();
  } catch (_) {
    return false;
  }
}

// The extension host runs as `<Editor>.exe` with ELECTRON_RUN_AS_NODE=1. Reusing
// that env would start the child in Node mode — it would run no window at all.
function guiEnv() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Focus (or open) an editor window on `folder`.
 * @param {string} folder absolute folder path
 * @param {string} appRoot vscode.env.appRoot
 * @returns {boolean} whether a launch was attempted
 */
function openFolderWindow(folder, appRoot) {
  if (!isExistingDirectory(folder)) return false;
  const { spawn } = require('child_process');
  const opts = { env: guiEnv(), detached: true, stdio: 'ignore' };

  try {
    if (process.platform === 'win32') {
      // The editor executable routes through the same single-instance path as
      // bin/*.cmd, without needing a shell to run a batch file.
      spawn(process.execPath, [folder], opts).unref();
      return true;
    }

    const cli = findEditorCli(appRoot);
    if (cli) {
      spawn(cli, [folder], opts).unref();
      return true;
    }
    if (process.platform === 'darwin') {
      // process.execPath points at the Electron binary inside the bundle;
      // `open -a` on the .app is the supported way to hand it an argument.
      const appBundle = appRoot ? appRoot.replace(/\/Contents\/Resources\/app$/, '') : null;
      if (!appBundle) return false;
      spawn('open', ['-a', appBundle, folder], opts).unref();
      return true;
    }
    spawn(process.execPath, [folder], opts).unref();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  cliDirCandidates,
  pickCliName,
  findEditorCli,
  isExistingDirectory,
  openFolderWindow,
};
