// @module pty/loadNodePty — the bundled node-pty, else the editor's own.
//
// The bundled copy carries native binaries only for the targets CI builds
// (win32-x64, darwin-arm64, linux-x64). Anywhere else it cannot load -- VSCodroid
// on Android above all, whose Node is Bionic arm64 and opens neither a glibc nor
// a musl addon. But every editor ships a node-pty built for exactly the platform
// it runs on, because its own terminal needs one, and it sits under appRoot:
// node_modules on a server build (VSCodroid, VS Code Server), node_modules.asar
// on Electron desktop, which reads the archive and loads the binary beside it.

const path = require('path');

// `req` and `appRoot` are injectable for tests; production passes neither.
function loadNodePty(req = require, appRoot) {
  try {
    return req('node-pty');
  } catch (bundledErr) {
    const root = appRoot || require('vscode').env.appRoot;
    for (const dir of ['node_modules', 'node_modules.asar']) {
      try {
        return req(path.join(root, dir, 'node-pty'));
      } catch (_) {}
    }
    throw bundledErr;
  }
}

module.exports = { loadNodePty };
