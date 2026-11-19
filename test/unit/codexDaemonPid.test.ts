import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearStaleCodexDaemonPids, clearCodexDaemonPidsFor, codexHomeOf, _test } = require('../../src/lib/codexDaemonPid');

// The shapes Codex 0.169 writes (executableIdentity trimmed). Start times are
// 2026-11-17T23:58:53Z and 2026-11-17T23:59:00Z.
const STALE = '{"pid":2320,"processStartTime":"134394335333783614","executableIdentity":{"digest":[1,2,3]}}';
const UPDATER = '{"pid":23604,"processStartTime":"134394335405409051"}';
const STALE_MS = Date.parse('2026-11-17T23:58:53.378Z');

function makeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-pid-'));
  const dir = path.join(home, 'app-server-daemon');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  return home;
}

function has(home: string, name: string): boolean {
  return fs.existsSync(path.join(home, 'app-server-daemon', name));
}

function withHome(files: Record<string, string>, fn: (home: string) => void): void {
  _test.keptRecords.clear();
  const home = makeHome(files);
  try {
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Boot at the epoch: no record is "before boot", so the image decides.
function clear(home: string, deps: Record<string, unknown>) {
  return clearStaleCodexDaemonPids(home, { bootTimeMs: 0, platform: 'win32', ...deps });
}

test('a PID now held by a process this user may not open (svchost) is removed, daemon and updater both', () => {
  withHome({ 'daemon.pid': STALE, 'daemon-updater.pid': UPDATER, 'daemon.pid.lock': '' }, (home) => {
    const probed: number[] = [];
    const removed = clear(home, {
      signalProbe: (pid: number) => { probed.push(pid); return 'denied'; },
      imageName: () => 'svchost.exe',
    });
    assert.deepEqual(probed, [2320, 23604]);
    assert.deepEqual(removed.map((r: any) => [path.basename(r.file), r.pid, r.image, r.reason]), [
      ['daemon.pid', 2320, 'svchost.exe', 'not-codex'],
      ['daemon-updater.pid', 23604, 'svchost.exe', 'not-codex'],
    ]);
    assert.equal(has(home, 'daemon.pid'), false);
    assert.equal(has(home, 'daemon-updater.pid'), false);
    // Only the PID files: Codex's locks and logs stay.
    assert.equal(has(home, 'daemon.pid.lock'), true);
  });
});

test('Windows: a record from before this boot is removed without looking the image up', () => {
  withHome({ 'daemon.pid': STALE, 'daemon-updater.pid': UPDATER }, (home) => {
    let looked = false;
    const removed = clearStaleCodexDaemonPids(home, {
      signalProbe: () => 'denied',
      imageName: () => { looked = true; return 'codex.exe'; },
      bootTimeMs: Date.parse('2026-11-19T00:22:47Z'),
      platform: 'win32',
    });
    assert.equal(looked, false);
    assert.deepEqual(removed.map((r: any) => r.reason), ['before-boot', 'before-boot']);
    assert.equal(has(home, 'daemon.pid'), false);
  });
});

test('before-boot needs a clear margin, a Windows FILETIME and Windows', () => {
  const rec = _test.readRecord(STALE);
  assert.equal(_test.startTimeMs(rec.startTime), STALE_MS);
  // Within two minutes of boot: not trusted, the image decides.
  assert.equal(_test.startedBeforeBoot(rec, STALE_MS + 60 * 1000, 'win32'), false);
  assert.equal(_test.startedBeforeBoot(rec, STALE_MS + 3 * 60 * 1000, 'win32'), true);
  // Started after boot.
  assert.equal(_test.startedBeforeBoot(rec, STALE_MS - 1000, 'win32'), false);
  // Elsewhere the start time is not a FILETIME.
  assert.equal(_test.startedBeforeBoot(rec, Date.now(), 'darwin'), false);
  for (const v of [undefined, '', 'abc', '123', 134394335333783614, '-134394335333783614', '1'.repeat(25)]) {
    assert.equal(_test.startedBeforeBoot({ pid: 1, startTime: v }, Date.now(), 'win32'), false, String(v));
  }
});

test('a codex process that cannot be signalled (daemon from an elevated window) is kept', () => {
  for (const img of ['codex.exe', 'CODEX.EXE', 'codex']) {
    withHome({ 'daemon.pid': STALE }, (home) => {
      const removed = clear(home, { signalProbe: () => 'denied', imageName: () => img });
      assert.deepEqual(removed, []);
      assert.equal(has(home, 'daemon.pid'), true, img);
    });
  }
});

test('a kept record is not looked up again until its content changes', () => {
  withHome({ 'daemon.pid': STALE }, (home) => {
    let lookups = 0;
    const deps = { signalProbe: () => 'denied', imageName: () => { lookups++; return 'codex.exe'; } };
    clear(home, deps);
    clear(home, deps);
    assert.equal(lookups, 1);
    fs.writeFileSync(path.join(home, 'app-server-daemon', 'daemon.pid'), UPDATER, 'utf8');
    clear(home, deps);
    assert.equal(lookups, 2);
  });
});

test('alive, gone and unknown PIDs are left to Codex, without looking the image up', () => {
  for (const state of ['alive', 'gone', 'unknown']) {
    withHome({ 'daemon.pid': STALE }, (home) => {
      let looked = false;
      // Even a record from before boot: Codex handles these itself.
      const removed = clearStaleCodexDaemonPids(home, {
        signalProbe: () => state,
        imageName: () => { looked = true; return 'svchost.exe'; },
        bootTimeMs: Date.now(),
        platform: 'win32',
      });
      assert.deepEqual(removed, [], state);
      assert.equal(looked, false, state);
      assert.equal(has(home, 'daemon.pid'), true, state);
    });
  }
});

test('an image lookup that cannot tell keeps the file; one that finds no process removes it', () => {
  withHome({ 'daemon.pid': STALE }, (home) => {
    clear(home, { signalProbe: () => 'denied', imageName: () => null });
    assert.equal(has(home, 'daemon.pid'), true);
  });
  withHome({ 'daemon.pid': STALE }, (home) => {
    clear(home, { signalProbe: () => 'denied', imageName: () => '' });
    assert.equal(has(home, 'daemon.pid'), false);
  });
});

test('a file Codex rewrote while it was being checked is kept', () => {
  withHome({ 'daemon.pid': STALE }, (home) => {
    const file = path.join(home, 'app-server-daemon', 'daemon.pid');
    const fresh = '{"pid":4242,"processStartTime":"134395279729801943"}';
    const removed = clear(home, {
      signalProbe: () => 'denied',
      imageName: () => { fs.writeFileSync(file, fresh, 'utf8'); return 'svchost.exe'; },
    });
    assert.deepEqual(removed, []);
    assert.equal(fs.readFileSync(file, 'utf8'), fresh);
  });
});

test('files that are not a Codex PID record are left alone', () => {
  for (const text of ['', 'not json', '{}', 'null', '{"pid":"2320"}', '{"pid":0}', '{"pid":-5}', '{"pid":1.5}', '[2320]']) {
    withHome({ 'daemon.pid': text }, (home) => {
      let probed = false;
      clear(home, { signalProbe: () => { probed = true; return 'denied'; }, imageName: () => 'svchost.exe' });
      assert.equal(probed, false, JSON.stringify(text));
      assert.equal(has(home, 'daemon.pid'), true, JSON.stringify(text));
    });
  }
});

test('no daemon folder, no home: nothing happens and nothing throws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-pid-empty-'));
  try {
    assert.deepEqual(clearStaleCodexDaemonPids(home), []);
    assert.deepEqual(clearStaleCodexDaemonPids(''), []);
    assert.deepEqual(clearStaleCodexDaemonPids(undefined), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('imageLookup asks once per PID, null answers included', () => {
  const asked: number[] = [];
  const names: Record<number, string | null> = { 2320: 'svchost.exe', 7: null };
  const lookup = _test.imageLookup((pid: number) => { asked.push(pid); return pid in names ? names[pid] : ''; });
  assert.equal(lookup(2320), 'svchost.exe');
  assert.equal(lookup(2320), 'svchost.exe');
  assert.equal(lookup(7), null);
  assert.equal(lookup(7), null);
  assert.equal(lookup(99), '');
  assert.deepEqual(asked, [2320, 7, 99]);
});

test('parseTasklistCsv: the row for that PID only; INFO and localized lines are not rows', () => {
  const out = [
    '',
    '"svchost.exe","2320","Services","0","18,308 K"',
    '"codex.exe","23204","Console","1","43,080 K"',
  ].join('\r\n');
  assert.equal(_test.parseTasklistCsv(out, 2320), 'svchost.exe');
  assert.equal(_test.parseTasklistCsv(out, 23204), 'codex.exe');
  assert.equal(_test.parseTasklistCsv(out, 232), '');
  assert.equal(_test.parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n', 2320), '');
  assert.equal(_test.parseTasklistCsv('정보: 지정된 조건에 일치하는 작업이 없습니다.\r\n', 2320), '');
  assert.equal(_test.parseTasklistCsv('', 2320), '');
});

test('parsePsComm: basename, parentheses dropped, blank stays blank', () => {
  assert.equal(_test.parsePsComm('/sbin/launchd\n'), 'launchd');
  assert.equal(_test.parsePsComm('(codex)\n'), 'codex');
  assert.equal(_test.parsePsComm('/Users/me/.codex/packages/app-server-daemon/current/bin/codex\n'), 'codex');
  assert.equal(_test.parsePsComm('systemd'), 'systemd');
  assert.equal(_test.parsePsComm('  \n'), '');
});

test('imageName: tasklist by absolute path and PID filter; ps blank or failing cannot tell', () => {
  const calls: any[] = [];
  const win = (_pid: number) => _test.imageName(2320, (file: string, args: string[], opts: any) => {
    calls.push({ file, args, opts });
    return '"svchost.exe","2320","Services","0","18,308 K"\r\n';
  }, 'win32');
  assert.equal(win(2320), 'svchost.exe');
  assert.match(calls[0].file, /[\\/]System32[\\/]tasklist\.exe$/i);
  assert.deepEqual(calls[0].args, ['/FI', 'PID eq 2320', '/FO', 'CSV', '/NH']);
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(_test.imageName(2320, () => { throw new Error('timeout'); }, 'win32'), null);

  assert.equal(_test.imageName(1, () => '/sbin/launchd\n', 'darwin'), 'launchd');
  assert.equal(_test.imageName(1, () => '\n', 'linux'), null);
  assert.equal(_test.imageName(1, () => { const e: any = new Error('exit 1'); e.status = 1; throw e; }, 'darwin'), null);
});

test('codexHomeOf: CODEX_HOME from the spawn env (relative to the tab folder), else ~/.codex', () => {
  const abs = path.resolve('/w/.agent-sessions/.home/codex');
  assert.equal(codexHomeOf({ CODEX_HOME: abs }), abs);
  assert.equal(codexHomeOf({ CODEX_HOME: 'rel/codex' }, path.resolve('/proj')), path.resolve('/proj', 'rel/codex'));
  assert.equal(codexHomeOf({}), path.join(os.homedir(), '.codex'));
  assert.equal(codexHomeOf(undefined), path.join(os.homedir(), '.codex'));
});

test('clearCodexDaemonPidsFor logs what it removed and never throws', () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    // A record naming PID 4 / 1 from before this boot (Windows), or one with a
    // dead PID: either way nothing throws.
    withHome({ 'daemon.pid': STALE }, (home) => {
      clearCodexDaemonPidsFor({ CODEX_HOME: home });
    });
    clearCodexDaemonPidsFor(null as any);
    clearCodexDaemonPidsFor({ CODEX_HOME: '\0bad' });
  } finally {
    console.log = orig;
  }
  for (const line of logged) assert.match(line, /^\[Claude Launcher\] removed stale Codex daemon\.pid: pid 2320 /);
});

test('signalProbe and imageName on real processes: this one is alive and named, a free PID is gone', () => {
  assert.equal(_test.signalProbe(process.pid), 'alive');
  // PIDs are multiples of 4 on Windows and capped well below this elsewhere.
  const free = 0x3ffffff0;
  assert.equal(_test.signalProbe(free), 'gone');
  if (process.platform === 'win32') {
    const own = _test.imageName(process.pid);
    assert.ok(own && /node/i.test(own), `own image: ${own}`);
    assert.equal(_test.imageName(free), '');
  }
});

// The real case end to end: a PID file naming a process this user may not
// signal. Windows: PID 4 is always "System". Elsewhere: PID 1, unless it runs
// as this user (containers) — then there is nothing to test.
const systemPid = process.platform === 'win32' ? 4 : 1;

test('a PID file naming a system process is handled with the real probes', { skip: _test.signalProbe(systemPid) !== 'denied' }, () => {
  // Recorded "now", so the image decides rather than the boot time.
  const nowFiletime = ((BigInt(Date.now()) + 11644473600000n) * 10000n).toString();
  withHome({ 'daemon.pid': `{"pid":${systemPid},"processStartTime":"${nowFiletime}"}` }, (home) => {
    const img = _test.imageName(systemPid);
    const removed = clearStaleCodexDaemonPids(home);
    if (img === null || _test.isCodexImage(img)) {
      // ps could not see it (hidepid): kept.
      assert.deepEqual(removed, []);
      assert.equal(has(home, 'daemon.pid'), true);
      return;
    }
    if (process.platform === 'win32') assert.equal(img, 'System');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].pid, systemPid);
    assert.equal(removed[0].reason, 'not-codex');
    assert.equal(has(home, 'daemon.pid'), false);
  });
});

test('both Codex spawn paths clear stale daemon PIDs after the session env is built and before spawning', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf8');
  for (const [rel, call, spawn] of [
    ['src/panel/createPanel.js', "if (agent === 'codex') clearCodexDaemonPidsFor(sessionEnv, cwd);", 'createBackend({'],
    ['src/panel/restartPty.js', "if (agent === 'codex') clearCodexDaemonPidsFor(sessionEnv, entry.cwd);", 'pty.spawn(shell, args'],
  ]) {
    const src = read(rel);
    assert.match(src, /require\('\.\.\/lib\/codexDaemonPid'\)/, rel);
    const envAt = src.indexOf('const sessionEnv = { ...prepareProjectSessionEnvironment(');
    const clearAt = src.indexOf(call);
    const spawnAt = src.indexOf(spawn, envAt);
    assert.ok(envAt >= 0 && clearAt > envAt, `${rel}: clear after sessionEnv`);
    assert.ok(spawnAt > clearAt, `${rel}: clear before the spawn`);
  }
});
