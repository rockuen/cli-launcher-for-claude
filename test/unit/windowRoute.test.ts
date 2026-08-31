// Window routing for session deep links — which window resumes the link, and
// which pending hand-off records a window is allowed to claim.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const { isCwdInWorkspace, routeForLink, shouldClaimPending, normalizePath, PENDING_TTL_MS } = require(
  path.join(process.cwd(), 'src/lib/windowRoute')
) as {
  isCwdInWorkspace: (cwd: any, folders: string[]) => boolean;
  routeForLink: (link: any, folders: string[]) => 'here' | 'elsewhere';
  shouldClaimPending: (p: any, folders: string[], now: number, ttl?: number) => boolean;
  normalizePath: (p: any) => string;
  PENDING_TTL_MS: number;
};

const isWin = process.platform === 'win32';
const ROOT = isWin ? 'C:\\dev\\burst' : '/home/u/dev/burst';
const NESTED = isWin ? 'C:\\dev\\burst\\src-tauri' : '/home/u/dev/burst/src-tauri';
const OTHER = isWin ? 'C:\\dev\\bywon' : '/home/u/dev/bywon';
// The classic prefix trap: startsWith() alone would call this a child of ROOT.
const SIBLING_PREFIX = ROOT + '2';

test('isCwdInWorkspace: the folder itself and its descendants match', () => {
  assert.equal(isCwdInWorkspace(ROOT, [ROOT]), true);
  assert.equal(isCwdInWorkspace(NESTED, [ROOT]), true);
});

test('isCwdInWorkspace: an unrelated folder does not match', () => {
  assert.equal(isCwdInWorkspace(OTHER, [ROOT]), false);
});

test('isCwdInWorkspace: a sibling sharing the name prefix does not match', () => {
  assert.equal(isCwdInWorkspace(SIBLING_PREFIX, [ROOT]), false);
});

test('isCwdInWorkspace: a trailing separator is not a different folder', () => {
  assert.equal(isCwdInWorkspace(ROOT + (isWin ? '\\' : '/'), [ROOT]), true);
});

test('isCwdInWorkspace: multi-root — any folder may own the session', () => {
  assert.equal(isCwdInWorkspace(NESTED, [OTHER, ROOT]), true);
});

test('isCwdInWorkspace: empty / missing input never matches', () => {
  assert.equal(isCwdInWorkspace('', [ROOT]), false);
  assert.equal(isCwdInWorkspace(null, [ROOT]), false);
  assert.equal(isCwdInWorkspace(ROOT, []), false);
  assert.equal(isCwdInWorkspace(ROOT, undefined as any), false);
});

if (isWin) {
  test('isCwdInWorkspace: Windows paths compare case- and separator-insensitively', () => {
    assert.equal(isCwdInWorkspace('c:/DEV/Burst/src', ['C:\\dev\\burst']), true);
  });

  test('normalizePath: Windows form is lowercased with backslashes, no trailing sep', () => {
    assert.equal(normalizePath('C:/Dev/Burst/'), 'c:\\dev\\burst');
  });
} else {
  test('isCwdInWorkspace: POSIX paths stay case-sensitive', () => {
    assert.equal(isCwdInWorkspace('/home/u/dev/BURST', ['/home/u/dev/burst']), false);
  });
}

test('routeForLink: a link with no cwd resumes in the window that received it', () => {
  assert.equal(routeForLink({}, []), 'here');
  assert.equal(routeForLink({ cwd: null }, [ROOT]), 'here');
});

test('routeForLink: own workspace resumes here, another folder is handed off', () => {
  assert.equal(routeForLink({ cwd: NESTED }, [ROOT]), 'here');
  assert.equal(routeForLink({ cwd: OTHER }, [ROOT]), 'elsewhere');
});

test('shouldClaimPending: fresh record addressed at this workspace is claimed', () => {
  const now = 1_000_000;
  assert.equal(shouldClaimPending({ cwd: NESTED, ts: now - 500 }, [ROOT], now), true);
});

test('shouldClaimPending: a stale record is left alone', () => {
  const now = 1_000_000;
  assert.equal(shouldClaimPending({ cwd: ROOT, ts: now - PENDING_TTL_MS - 1 }, [ROOT], now), false);
});

test('shouldClaimPending: a record for another folder is not claimed', () => {
  const now = 1_000_000;
  assert.equal(shouldClaimPending({ cwd: OTHER, ts: now }, [ROOT], now), false);
});

test('shouldClaimPending: records with no cwd or no timestamp are ignored', () => {
  const now = 1_000_000;
  assert.equal(shouldClaimPending({ ts: now }, [ROOT], now), false);
  assert.equal(shouldClaimPending({ cwd: ROOT }, [ROOT], now), false);
  assert.equal(shouldClaimPending(null, [ROOT], now), false);
  assert.equal(shouldClaimPending('nope', [ROOT], now), false);
});
