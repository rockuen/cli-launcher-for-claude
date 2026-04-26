// OMCRuntime — detection-only helpers for the OMC (oh-my-claudecode)
// installation. Used by Phase 4 (OMC mode toggle) to decide whether to
// surface OMC-dependent UI.
//
// Three independent signals are checked. We treat OMC as "installed" when
// at least two of the three say yes — that handles the common cases:
//   - ~/.omc/ exists but `omc` CLI not on PATH (npm global isn't in PATH)
//   - `omc` is on PATH but ~/.omc not yet initialized (first-run state)
//   - config.json may be partially written or symlinked
//
// We deliberately do NOT spawn OMC processes here. Spawning belongs to a
// future runtime layer; detection should stay cheap (~10ms).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export interface OMCDetectionSignals {
  /** `~/.omc/` directory exists. */
  homeDir: boolean;
  /** `omc` CLI resolvable on PATH. */
  cliOnPath: boolean;
  /** `~/.omc/config.json` exists and is valid JSON. */
  configValid: boolean;
}

export interface OMCDetectionResult {
  /** True iff at least two of the three signals are positive. */
  installed: boolean;
  signals: OMCDetectionSignals;
  /** Resolved absolute path to `~/.omc/config.json` (regardless of validity). */
  configPath: string;
  /** Resolved absolute path to `~/.omc/` (regardless of existence). */
  homeDir: string;
  /** OMC CLI version reported by `omc --version`, if reachable. */
  cliVersion?: string;
}

/**
 * Probe the local OMC installation. Pure observation — does not write,
 * does not spawn long-running processes. Used by the OMC mode toggle to
 * default to ON when OMC is present.
 *
 * @param homeOverride Optional custom home directory (mainly for tests).
 *                     Falls back to `os.homedir()`.
 */
export async function detectOMC(homeOverride?: string): Promise<OMCDetectionResult> {
  const home = homeOverride ?? os.homedir();
  const homeDir = path.join(home, '.omc');
  const configPath = path.join(homeDir, 'config.json');

  const homeDirExists = await pathIsDir(homeDir);
  const configValid = await jsonFileIsValid(configPath);
  const { onPath, version } = await probeCli();

  const signals: OMCDetectionSignals = {
    homeDir: homeDirExists,
    cliOnPath: onPath,
    configValid,
  };

  // Two-of-three majority — robust against any single signal hiccup.
  const positives = Number(signals.homeDir) + Number(signals.cliOnPath) + Number(signals.configValid);
  const installed = positives >= 2;

  return {
    installed,
    signals,
    configPath,
    homeDir,
    cliVersion: version,
  };
}

async function pathIsDir(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function jsonFileIsValid(p: string): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function probeCli(): Promise<{ onPath: boolean; version?: string }> {
  try {
    const { stdout } = await execFileP('omc', ['--version'], { timeout: 1500 });
    const version = stdout.trim().split(/\s+/).pop();
    return { onPath: true, version };
  } catch {
    return { onPath: false };
  }
}
