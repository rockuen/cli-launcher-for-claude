/**
 * Pure, vscode-free formatting helpers for HUD display.
 * Kept separate so unit tests can import without triggering the vscode module.
 */

/** Shorten a model display name by stripping the "claude-" prefix and parentheticals. */
export function shortModel(name?: string): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/\s*\(.*?\)\s*/g, '').replace(/^claude-/i, '').trim();
  return cleaned || name;
}

/** Format a USD cost value for compact status bar display. */
export function formatUsd(v: number): string {
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 100) return `$${v.toFixed(1)}`;
  return `$${Math.round(v)}`;
}
