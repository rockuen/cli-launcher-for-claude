import { defineConfig } from "vitest/config";

// Vitest covers ONLY the `test/account/**` lane — the byte-for-byte
// port from `rockuen/claude-account-switcher` v0.1.1 relies on
// `vi.mock` / `vi.hoisted` to redirect `~/.claude` to a tmp dir, and
// rewriting 90 tests for `node --test` would have meant touching the
// frozen contract. Everything under `test/unit/**` stays on the
// existing `node --test` lane (see package.json `test:node`).
export default defineConfig({
  test: {
    include: ["test/account/**/*.test.ts"],
    environment: "node",
  },
});
