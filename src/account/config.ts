// Account module — Claude CLI home-dir constant.
//
// Originally `src/core/config.ts` in `rockuen/claude-account-switcher` v0.1.1.
// Extracted to a one-liner here so the byte-for-byte profile port can keep
// its `import { CLAUDE_DIR } from "./config"` line unchanged.
import * as os from "os";
import * as path from "path";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
