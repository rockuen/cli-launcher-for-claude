/**
 * Pure, vscode-free helpers for CCG artifact parsing and pair matching.
 * Extracted so unit tests can import without a vscode mock.
 * CcgArtifactWatcher imports from here.
 */

import * as path from 'path';
import type { CcgArtifact, CcgPair, CcgProvider } from '../types/ccg';

export const PAIR_WINDOW_MS = 5 * 60 * 1000;

export function detectProvider(fileName: string): CcgProvider | null {
  if (fileName.startsWith('codex-')) return 'codex';
  if (fileName.startsWith('gemini-')) return 'gemini';
  if (fileName.startsWith('claude-')) return 'claude';
  return null;
}

/**
 * Extract provider, slug, and timestamp from a CCG artifact filename like
 * `codex-i-m-working-on-cli-launcher-2026-04-17T13-14-53-009Z.md`.
 * Returns null if the filename does not match any known provider prefix.
 */
export function parseArtifactFilename(fileName: string): {
  provider: CcgProvider;
  slug: string;
  timestampMs: number | null;
} | null {
  const provider = detectProvider(fileName);
  if (!provider) return null;
  const withoutExt = fileName.replace(/\.md$/, '');
  const body = withoutExt.slice(provider.length + 1);
  const tsMatch = body.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!tsMatch) {
    return { provider, slug: body, timestampMs: null };
  }
  const tsToken = tsMatch[1];
  const slug = body.slice(0, body.length - tsToken.length - 1);
  const iso = tsToken.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
  const parsed = Date.parse(iso);
  return { provider, slug, timestampMs: Number.isNaN(parsed) ? null : parsed };
}

export function parseArtifactMarkdown(
  filePath: string,
  provider: CcgProvider,
  raw: string,
  mtimeMs: number,
): CcgArtifact | null {
  const fileName = path.basename(filePath);
  const parsed = parseArtifactFilename(fileName);
  const slug = parsed?.slug ?? fileName;
  const timestampMs = parsed?.timestampMs ?? null;

  const createdAtField = extractField(raw, 'Created at');
  const createdFromField = createdAtField ? Date.parse(createdAtField) : NaN;
  const createdAt = Number.isFinite(createdFromField)
    ? (createdFromField as number)
    : timestampMs ?? mtimeMs;

  const exitCodeField = extractField(raw, 'Exit code');
  const exitCode =
    exitCodeField !== null && /^-?\d+$/.test(exitCodeField.trim())
      ? Number(exitCodeField.trim())
      : null;

  const originalTask = extractSection(raw, 'Original task') ?? '';
  const finalPrompt = extractSection(raw, 'Final prompt') ?? '';
  const rawOutput = extractRawOutput(raw) ?? '';

  const keySource = originalTask || finalPrompt || slug;
  const questionKey = normalizeKey(keySource);

  return {
    filePath,
    fileName,
    provider,
    createdAt,
    mtimeMs,
    exitCode,
    originalTask: originalTask.trim(),
    finalPrompt: finalPrompt.trim(),
    rawOutput: rawOutput.trim(),
    questionKey,
    slug,
  };
}

/**
 * Pair artifacts by temporal proximity within PAIR_WINDOW_MS. CCG emits codex
 * + gemini almost simultaneously so time beats questionKey as the primary
 * pairing signal. Unpaired artifacts appear as single-provider entries.
 */
export function buildPairs(artifacts: CcgArtifact[]): CcgPair[] {
  const remaining = [...artifacts].sort((a, b) => a.createdAt - b.createdAt);
  const pairs: CcgPair[] = [];
  const used = new Set<string>();

  for (const artifact of remaining) {
    if (used.has(artifact.filePath)) continue;
    used.add(artifact.filePath);

    const partners: Record<'codex' | 'gemini' | 'claude', CcgArtifact | null> = {
      codex: null,
      gemini: null,
      claude: null,
    };
    partners[artifact.provider] = artifact;

    for (const other of remaining) {
      if (used.has(other.filePath)) continue;
      if (other.provider === artifact.provider) continue;
      if (Math.abs(other.createdAt - artifact.createdAt) > PAIR_WINDOW_MS) continue;
      if (partners[other.provider]) continue;
      partners[other.provider] = other;
      used.add(other.filePath);
    }

    const artifactsInPair = [partners.codex, partners.gemini, partners.claude].filter(
      (a): a is CcgArtifact => a !== null,
    );
    const earliest = artifactsInPair.reduce(
      (min, a) => (a.createdAt < min ? a.createdAt : min),
      artifact.createdAt,
    );
    const anchor = partners.codex ?? partners.gemini ?? partners.claude ?? artifact;
    const title = summarizeTitle(anchor.originalTask || anchor.finalPrompt || anchor.slug);

    pairs.push({
      id: `${earliest}:${anchor.questionKey.slice(0, 24)}`,
      questionKey: anchor.questionKey,
      createdAt: earliest,
      codex: partners.codex,
      gemini: partners.gemini,
      claude: partners.claude,
      title,
    });
  }

  return pairs.sort((a, b) => b.createdAt - a.createdAt);
}

function extractField(raw: string, label: string): string | null {
  const re = new RegExp(`^-\\s+${label}:\\s*(.+)$`, 'm');
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function extractSection(raw: string, heading: string): string | null {
  const re = new RegExp(`## ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function extractRawOutput(raw: string): string | null {
  const section = extractSection(raw, 'Raw output');
  if (!section) return null;
  const fence = section.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
  if (fence) return fence[1];
  return section;
}

function normalizeKey(source: string): string {
  return source
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim()
    .slice(0, 160);
}

function summarizeTitle(source: string): string {
  const clean = source.replace(/\s+/g, ' ').trim();
  if (!clean) return 'CCG session';
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
