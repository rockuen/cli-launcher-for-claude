import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Shared in-memory Keychain + temp dir, hoisted so the vi.mock factories
// can see them.
const { CLAUDE_DIR, CREDENTIALS_PATH, keychain } = vi.hoisted(() => {
  const _path = require("path") as typeof import("path");
  const _os = require("os") as typeof import("os");
  const claudeDir = _path.join(_os.tmpdir(), ".claude-test-livecreds", ".claude");
  return {
    CLAUDE_DIR: claudeDir,
    CREDENTIALS_PATH: _path.join(claudeDir, ".credentials.json"),
    keychain: { secret: null as string | null, account: null as string | null },
  };
});

// Redirect CLAUDE_DIR so the file backend writes into our temp dir.
vi.mock("../../src/account/config", () => ({ CLAUDE_DIR }));

// Simulate the macOS `security` CLI with an in-memory Keychain item.
vi.mock("child_process", () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd !== "security") throw new Error(`unexpected command: ${cmd}`);
    const sub = args[0];
    if (sub === "find-generic-password") {
      if (keychain.secret === null) {
        // `security` exits non-zero when the item is absent → throws.
        throw new Error("security: SecKeychainSearchCopyNext: not found");
      }
      if (args.includes("-w")) return keychain.secret + "\n";
      // Attributes block — the `"acct"<blob>="…"` line is what
      // keychainAccount() parses out.
      return [
        'keychain: "/Users/test/Library/Keychains/login.keychain-db"',
        'class: "genp"',
        "attributes:",
        `    "acct"<blob>="${keychain.account}"`,
        '    "svce"<blob>="Claude Code-credentials"',
        "",
      ].join("\n");
    }
    if (sub === "add-generic-password") {
      const aIdx = args.indexOf("-a");
      const wIdx = args.indexOf("-w");
      keychain.account = aIdx >= 0 ? args[aIdx + 1] : null;
      keychain.secret = wIdx >= 0 ? args[wIdx + 1] : null;
      return "";
    }
    throw new Error(`unexpected security subcommand: ${sub}`);
  }),
}));

// Stable username for the fallback-account path.
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    userInfo: () => ({ ...actual.userInfo(), username: "testuser" }),
  };
});

import {
  credsBackend,
  readLiveCredsRaw,
  writeLiveCredsRaw,
  liveCredsExist,
} from "../../src/account/liveCreds";
import { execFileSync } from "child_process";

const SAMPLE = JSON.stringify({
  claudeAiOauth: {
    accessToken: "access-abc",
    refreshToken: "refresh-xyz",
    expiresAt: 1_800_000_000_000,
    subscriptionType: "max",
  },
});

/** Temporarily override process.platform; returns a restore fn. */
function setPlatform(p: NodeJS.Platform): () => void {
  const orig = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  return () => {
    if (orig) Object.defineProperty(process, "platform", orig);
  };
}

beforeEach(() => {
  keychain.secret = null;
  keychain.account = null;
  delete process.env.CLI_LAUNCHER_CREDS_BACKEND;
  vi.mocked(execFileSync).mockClear();
  fs.rmSync(path.dirname(CLAUDE_DIR), { recursive: true, force: true });
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.CLI_LAUNCHER_CREDS_BACKEND;
  fs.rmSync(path.dirname(CLAUDE_DIR), { recursive: true, force: true });
});

describe("credsBackend", () => {
  it("honors the env override = file", () => {
    process.env.CLI_LAUNCHER_CREDS_BACKEND = "file";
    expect(credsBackend()).toBe("file");
  });

  it("honors the env override = keychain", () => {
    process.env.CLI_LAUNCHER_CREDS_BACKEND = "keychain";
    expect(credsBackend()).toBe("keychain");
  });

  it("ignores an unrecognized env value and uses the platform default", () => {
    process.env.CLI_LAUNCHER_CREDS_BACKEND = "nonsense";
    const restore = setPlatform("linux");
    try {
      expect(credsBackend()).toBe("file");
    } finally {
      restore();
    }
  });

  it("defaults to keychain on darwin", () => {
    const restore = setPlatform("darwin");
    try {
      expect(credsBackend()).toBe("keychain");
    } finally {
      restore();
    }
  });

  it("defaults to file on non-darwin", () => {
    const restore = setPlatform("win32");
    try {
      expect(credsBackend()).toBe("file");
    } finally {
      restore();
    }
  });
});

describe("keychain backend", () => {
  beforeEach(() => {
    process.env.CLI_LAUNCHER_CREDS_BACKEND = "keychain";
  });

  it("readLiveCredsRaw returns null when no item exists", () => {
    expect(readLiveCredsRaw()).toBeNull();
  });

  it("liveCredsExist is false with no item, true after a write", () => {
    expect(liveCredsExist()).toBe(false);
    writeLiveCredsRaw(SAMPLE);
    expect(liveCredsExist()).toBe(true);
  });

  it("write then read round-trips the secret (trimmed)", () => {
    writeLiveCredsRaw(SAMPLE);
    expect(readLiveCredsRaw()).toBe(SAMPLE);
  });

  it("write uses -U and the username when no prior item exists", () => {
    writeLiveCredsRaw(SAMPLE);
    const call = vi
      .mocked(execFileSync)
      .mock.calls.find((c) => (c[1] as string[])[0] === "add-generic-password");
    expect(call).toBeTruthy();
    const args = call![1] as string[];
    expect(args).toContain("-U");
    expect(args[args.indexOf("-a") + 1]).toBe("testuser");
    expect(args[args.indexOf("-s") + 1]).toBe("Claude Code-credentials");
  });

  it("write reuses the existing account name instead of forking a duplicate", () => {
    // Seed an item under a non-username account, then overwrite it.
    keychain.account = "custom-acct";
    keychain.secret = "{}";
    writeLiveCredsRaw(SAMPLE);
    const addCalls = vi
      .mocked(execFileSync)
      .mock.calls.filter(
        (c) => (c[1] as string[])[0] === "add-generic-password",
      );
    const args = addCalls[addCalls.length - 1][1] as string[];
    expect(args[args.indexOf("-a") + 1]).toBe("custom-acct");
    expect(keychain.secret).toBe(SAMPLE);
  });

  it("never invokes a shell (execFileSync to the security binary + args array)", () => {
    writeLiveCredsRaw(SAMPLE);
    readLiveCredsRaw();
    for (const c of vi.mocked(execFileSync).mock.calls) {
      expect(c[0]).toBe("security");
      expect(Array.isArray(c[1])).toBe(true);
    }
  });
});

describe("file backend", () => {
  beforeEach(() => {
    process.env.CLI_LAUNCHER_CREDS_BACKEND = "file";
  });

  it("readLiveCredsRaw returns null when the file is absent", () => {
    expect(readLiveCredsRaw()).toBeNull();
  });

  it("write then read round-trips via the file", () => {
    writeLiveCredsRaw(SAMPLE);
    expect(fs.existsSync(CREDENTIALS_PATH)).toBe(true);
    expect(readLiveCredsRaw()).toBe(SAMPLE);
  });

  it("liveCredsExist reflects the file", () => {
    expect(liveCredsExist()).toBe(false);
    writeLiveCredsRaw(SAMPLE);
    expect(liveCredsExist()).toBe(true);
  });

  it("does not call security in file mode", () => {
    writeLiveCredsRaw(SAMPLE);
    readLiveCredsRaw();
    liveCredsExist();
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
