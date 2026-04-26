/**
 * Pure, vscode-free helpers for HUD data parsing.
 * Kept separate so unit tests can import without triggering the vscode module.
 */
import type { HUDStdinCache } from '../types/hud';

/**
 * Parse raw JSON string into HUDStdinCache, returning null on any error.
 */
export function parseHudJson(raw: string): HUDStdinCache | null {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as HUDStdinCache;
  } catch {
    return null;
  }
}
