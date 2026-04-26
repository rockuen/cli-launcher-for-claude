import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type { CcgArtifact, CcgSnapshot } from '../types/ccg';
import {
  detectProvider,
  parseArtifactFilename,
  parseArtifactMarkdown,
  buildPairs,
} from './ccgHelpers';

export { parseArtifactFilename, buildPairs } from './ccgHelpers';

const ASK_DIR = '.omc/artifacts/ask';
const RECONCILE_MS = 8000;

/**
 * Hybrid watcher for CCG artifacts: FileSystemWatcher for responsiveness +
 * periodic reconcile to catch partial writes and missed rename events.
 * Follows the same pattern as SessionHistoryWatcher / MissionWatcher.
 */
export class CcgArtifactWatcher extends EventEmitter {
  private root: string | null = null;
  private fsWatcher: vscode.FileSystemWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private cache = new Map<string, { mtimeMs: number; size: number; artifact: CcgArtifact }>();
  private lastSnapshot: CcgSnapshot | null = null;

  constructor(private readonly logger: (msg: string) => void) {
    super();
  }

  get currentRoot(): string | null {
    return this.root;
  }

  start(projectRoot: string): void {
    this.stop();
    this.root = projectRoot;

    const pattern = new vscode.RelativePattern(projectRoot, `${ASK_DIR}/*.md`);
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const debounced = () => this.scheduleScan(250);
    this.fsWatcher.onDidCreate(debounced);
    this.fsWatcher.onDidChange(debounced);
    this.fsWatcher.onDidDelete(debounced);

    this.pollTimer = setInterval(() => this.scan(), RECONCILE_MS);
    this.scan();
    this.logger(`[claudeCodeLauncher.ccg] watching ${path.join(projectRoot, ASK_DIR)}`);
  }

  stop(): void {
    this.fsWatcher?.dispose();
    this.fsWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.root = null;
    this.cache.clear();
    this.lastSnapshot = null;
  }

  snapshot(): CcgSnapshot | null {
    return this.lastSnapshot;
  }

  forceRefresh(): void {
    this.scan();
  }

  private scheduleScan(delayMs: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scan();
    }, delayMs);
  }

  private scan(): void {
    if (!this.root) return;
    const askDir = path.join(this.root, ASK_DIR);
    let entries: string[];
    try {
      entries = fs.readdirSync(askDir);
    } catch {
      this.emitSnapshot({ pairs: [], scannedAt: Date.now(), root: this.root });
      return;
    }

    const artifacts: CcgArtifact[] = [];
    const seenPaths = new Set<string>();

    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const provider = detectProvider(name);
      if (!provider) continue;

      const full = path.join(askDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seenPaths.add(full);

      const cached = this.cache.get(full);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        artifacts.push(cached.artifact);
        continue;
      }

      let raw: string;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      // Skip partial writes (header without Raw output section).
      if (raw.length < 40 || (!raw.includes('## Original task') && !raw.includes('## Raw output'))) {
        continue;
      }

      const parsed = parseArtifactMarkdown(full, provider, raw, stat.mtimeMs);
      if (!parsed) continue;
      this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, artifact: parsed });
      artifacts.push(parsed);
    }

    for (const key of Array.from(this.cache.keys())) {
      if (!seenPaths.has(key)) this.cache.delete(key);
    }

    const pairs = buildPairs(artifacts);
    this.emitSnapshot({ pairs, scannedAt: Date.now(), root: this.root });
  }

  private emitSnapshot(next: CcgSnapshot): void {
    if (this.lastSnapshot && sameSnapshot(this.lastSnapshot, next)) return;
    this.lastSnapshot = next;
    this.emit('snapshot', next);
  }
}

function sameSnapshot(a: CcgSnapshot, b: CcgSnapshot): boolean {
  if (a.pairs.length !== b.pairs.length) return false;
  for (let i = 0; i < a.pairs.length; i++) {
    const pa = a.pairs[i];
    const pb = b.pairs[i];
    if (pa.id !== pb.id) return false;
    if (pa.createdAt !== pb.createdAt) return false;
    if (signature(pa.codex) !== signature(pb.codex)) return false;
    if (signature(pa.gemini) !== signature(pb.gemini)) return false;
    if (signature(pa.claude) !== signature(pb.claude)) return false;
  }
  return true;
}

function signature(a: CcgArtifact | null): string {
  if (!a) return 'x';
  return `${a.filePath}:${a.mtimeMs}`;
}
