import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `vscode` only exists inside the extension host; stub the two surfaces
// autoSync touches.
const { windowState } = vi.hoisted(() => ({
  windowState: { handler: null as ((e: { focused: boolean }) => void) | null },
}));

vi.mock("vscode", () => ({
  window: {
    onDidChangeWindowState: (cb: (e: { focused: boolean }) => void) => {
      windowState.handler = cb;
      return { dispose: () => { windowState.handler = null; } };
    },
  },
}));

const { syncSpy } = vi.hoisted(() => ({ syncSpy: vi.fn() }));
vi.mock("../../src/account/profiles", () => ({
  syncActiveProfile: syncSpy,
}));

import { startAccountAutoSync } from "../../src/account/autoSync";

function makeContext() {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as import("vscode").ExtensionContext & {
    subscriptions: { dispose(): void }[];
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  syncSpy.mockReset();
  windowState.handler = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startAccountAutoSync", () => {
  it("does not sync during activation itself", () => {
    startAccountAutoSync(makeContext());
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("syncs once shortly after activation, then on a repeating interval", () => {
    startAccountAutoSync(makeContext());

    vi.advanceTimersByTime(20_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    // Rotation follows the access token's ~8 h cycle, so the sampling
    // cadence only has to be much finer than that.
    vi.advanceTimersByTime(5 * 60_000);
    expect(syncSpy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60_000);
    expect(syncSpy).toHaveBeenCalledTimes(3);
  });

  it("syncs when the window regains focus, not when it loses it", () => {
    startAccountAutoSync(makeContext());
    expect(windowState.handler).toBeTypeOf("function");

    windowState.handler!({ focused: false });
    expect(syncSpy).not.toHaveBeenCalled();

    windowState.handler!({ focused: true });
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows sync failures — housekeeping must never surface", () => {
    syncSpy.mockImplementation(() => {
      throw new Error("disk gone");
    });
    startAccountAutoSync(makeContext());
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
    expect(() => windowState.handler!({ focused: true })).not.toThrow();
  });

  it("stops every timer and listener on disposal", () => {
    const ctx = makeContext();
    startAccountAutoSync(ctx);
    expect(ctx.subscriptions).toHaveLength(1);

    ctx.subscriptions[0].dispose();
    vi.advanceTimersByTime(60 * 60_000);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(windowState.handler).toBeNull();
  });
});
