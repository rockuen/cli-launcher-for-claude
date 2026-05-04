// v3.4.0 — slashRegistry resolveExtraSlashes() unit tests.
// Verifies: public build (empty PKM/OMC, BUILTIN_EXTRAS only), personal-override
// path via setLocalOverride(), group toggles, locale picking, prefix tagging.

import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

// slashRegistry stays as plain CommonJS so panel/*.js can require it directly.
// tsconfig.test.json opts the file in via `include` + `allowJs`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reg = require('../../src/lib/slashRegistry');
const {
  resolveExtraSlashes,
  setLocalOverride,
  getPkmCommands,
  getOmcAliases,
  getOmcSkills,
  BUILTIN_EXTRAS,
} = reg;

const T = {
  slashResume: 'Resume conversation',
  slashExport: 'Export conversation',
  slashUsage: 'Usage / token stats',
  slashEffort: 'Set reasoning effort',
  slashFast: 'Toggle Fast mode',
  slashOutputStyle: 'Switch output style',
  slashStatusline: 'Configure status line',
  slashSecurityReview: 'Security review',
  slashAgents: 'Manage subagents',
  slashMcp: 'MCP server status',
  slashHooks: 'Configure hooks',
  slashPermissions: 'Manage permissions',
  slashIde: 'IDE integration',
  slashAddDir: 'Add working directory',
  slashVim: 'Toggle Vim mode',
  slashBug: 'File a bug report',
  slashInstallGithubApp: 'Install GitHub app',
  slashUpgrade: 'Upgrade installation',
  slashMigrateInstaller: 'Migrate installer',
  slashReleaseNotes: 'Release notes',
};

const ALL_ON = { includeBuiltinExtras: true, includePkm: true, includeOmc: true };

// Sample personal override used by the override-path tests. Small enough to
// keep the test fixtures readable; mirrors the real schema.
const SAMPLE_LOCAL = {
  PKM_COMMANDS: [
    { cmd: '/blog', desc: { ko: '블로그', en: 'Blog' } },
    { cmd: '/idea', desc: { ko: '아이디어', en: 'Idea' } },
  ],
  OMC_ALIASES: [
    { cmd: '/ccg', desc: { ko: 'CCG', en: 'CCG' } },
    { cmd: '/team', desc: { ko: '팀', en: 'Team' } },
  ],
  OMC_SKILLS: [
    { cmd: '/oh-my-claudecode:autopilot', desc: { ko: '자율 실행', en: 'Autopilot' } },
    { cmd: '/oh-my-claudecode:wiki',       desc: { ko: '위키',       en: 'Wiki' } },
    { cmd: '/oh-my-claudecode:trace',      desc: { ko: '추적',       en: 'Trace' } },
  ],
};

beforeEach(() => {
  // Reset personal-override state between tests so order doesn't matter.
  setLocalOverride(null);
});

test('public build: PKM/OMC catalogs empty, BUILTIN_EXTRAS exposed', () => {
  // No setLocalOverride → public default state.
  assert.deepEqual(getPkmCommands(), []);
  assert.deepEqual(getOmcAliases(), []);
  assert.deepEqual(getOmcSkills(), []);
  assert.ok(BUILTIN_EXTRAS.length > 0, 'public build still ships BUILTIN_EXTRAS');
});

test('public build: resolveExtraSlashes(all-on) yields BUILTIN_EXTRAS only', () => {
  const out = resolveExtraSlashes('en', ALL_ON, T);
  assert.equal(out.length, BUILTIN_EXTRAS.length);
  for (const b of BUILTIN_EXTRAS) {
    assert.ok(
      out.find((e: { cmd: string }) => e.cmd === b.cmd),
      `built-in ${b.cmd} should be present in public-build extras`,
    );
  }
});

test('public build: every entry has desc resolved (no [OMC]/[PKM] prefix when no override)', () => {
  const out = resolveExtraSlashes('en', ALL_ON, T);
  for (const e of out) {
    assert.ok(
      !e.desc.startsWith('[PKM]') && !e.desc.startsWith('[OMC'),
      `public entry ${e.cmd} should not carry a personal-catalog prefix — got "${e.desc}"`,
    );
  }
});

test('setLocalOverride: PKM + OMC catalogs become live', () => {
  setLocalOverride(SAMPLE_LOCAL);
  assert.equal(getPkmCommands().length, SAMPLE_LOCAL.PKM_COMMANDS.length);
  assert.equal(getOmcAliases().length, SAMPLE_LOCAL.OMC_ALIASES.length);
  assert.equal(getOmcSkills().length, SAMPLE_LOCAL.OMC_SKILLS.length);
});

test('override + all-on: total = sample PKM + alias + skills + BUILTIN_EXTRAS', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('en', ALL_ON, T);
  const expected =
    SAMPLE_LOCAL.PKM_COMMANDS.length +
    SAMPLE_LOCAL.OMC_ALIASES.length +
    SAMPLE_LOCAL.OMC_SKILLS.length +
    BUILTIN_EXTRAS.length;
  assert.equal(out.length, expected);
});

test('override + includePkm=false: drops PKM, keeps OMC + builtins', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('en', { ...ALL_ON, includePkm: false }, T);
  const expected =
    SAMPLE_LOCAL.OMC_ALIASES.length + SAMPLE_LOCAL.OMC_SKILLS.length + BUILTIN_EXTRAS.length;
  assert.equal(out.length, expected);
  assert.equal(out.filter((e: { desc: string }) => e.desc.startsWith('[PKM]')).length, 0);
});

test('override + includeOmc=false: drops both alias and skills', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('en', { ...ALL_ON, includeOmc: false }, T);
  const expected = SAMPLE_LOCAL.PKM_COMMANDS.length + BUILTIN_EXTRAS.length;
  assert.equal(out.length, expected);
  assert.equal(out.filter((e: { desc: string }) => e.desc.startsWith('[OMC')).length, 0);
});

test('override + includeBuiltinExtras=false: drops only the built-in tail', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('en', { ...ALL_ON, includeBuiltinExtras: false }, T);
  const expected =
    SAMPLE_LOCAL.PKM_COMMANDS.length +
    SAMPLE_LOCAL.OMC_ALIASES.length +
    SAMPLE_LOCAL.OMC_SKILLS.length;
  assert.equal(out.length, expected);
  for (const b of BUILTIN_EXTRAS) {
    assert.equal(out.find((e: { cmd: string }) => e.cmd === b.cmd), undefined);
  }
});

test('override: PKM entries are tagged [PKM]', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('ko', ALL_ON, T);
  for (const p of SAMPLE_LOCAL.PKM_COMMANDS) {
    const found = out.find((e: { cmd: string }) => e.cmd === p.cmd);
    assert.ok(found, `PKM ${p.cmd} should be present`);
    assert.ok(
      found.desc.startsWith('[PKM] '),
      `PKM ${p.cmd} should start with "[PKM] " — got "${found.desc}"`,
    );
  }
});

test('override: OMC alias entries are tagged [OMC alias]', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('ko', ALL_ON, T);
  for (const a of SAMPLE_LOCAL.OMC_ALIASES) {
    const found = out.find((e: { cmd: string }) => e.cmd === a.cmd);
    assert.ok(found, `alias ${a.cmd} should be present`);
    assert.ok(
      found.desc.startsWith('[OMC alias] '),
      `alias ${a.cmd} should start with "[OMC alias] " — got "${found.desc}"`,
    );
  }
});

test('override: OMC skill entries are tagged [OMC] (not [OMC alias])', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('ko', ALL_ON, T);
  for (const s of SAMPLE_LOCAL.OMC_SKILLS) {
    const found = out.find((e: { cmd: string }) => e.cmd === s.cmd);
    assert.ok(found, `skill ${s.cmd} should be present`);
    assert.ok(
      found.desc.startsWith('[OMC] ') && !found.desc.startsWith('[OMC alias]'),
      `skill ${s.cmd} should start with "[OMC] " — got "${found.desc}"`,
    );
  }
});

test('every resolved cmd starts with /', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('en', ALL_ON, T);
  for (const e of out) {
    assert.ok(e.cmd.startsWith('/'), `cmd "${e.cmd}" should start with /`);
  }
});

test('locale=ko vs en pick different desc strings for personal catalog', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const koOut = resolveExtraSlashes(
    'ko',
    { includeBuiltinExtras: false, includePkm: true, includeOmc: false },
    T,
  );
  const enOut = resolveExtraSlashes(
    'en',
    { includeBuiltinExtras: false, includePkm: true, includeOmc: false },
    T,
  );
  assert.equal(koOut.length, enOut.length);
  // Sample fixtures use distinct ko/en strings.
  let differingCount = 0;
  for (let i = 0; i < koOut.length; i++) {
    if (koOut[i].desc !== enOut[i].desc) differingCount++;
  }
  assert.ok(differingCount > 0, 'expected at least one PKM desc to differ ko vs en');
});

test('builtin extras pick desc from T map by key', () => {
  const out = resolveExtraSlashes(
    'en',
    { includeBuiltinExtras: true, includePkm: false, includeOmc: false },
    T,
  );
  const resume = out.find((e: { cmd: string }) => e.cmd === '/resume');
  assert.ok(resume);
  assert.equal(resume.desc, T.slashResume);
  const usage = out.find((e: { cmd: string }) => e.cmd === '/usage');
  assert.ok(usage);
  assert.equal(usage.desc, T.slashUsage);
});

test('missing T falls back to key name (no crash)', () => {
  const out = resolveExtraSlashes(
    'en',
    { includeBuiltinExtras: true, includePkm: false, includeOmc: false },
    {},
  );
  assert.equal(out.length, BUILTIN_EXTRAS.length);
  for (const e of out) {
    assert.ok(typeof e.desc === 'string' && e.desc.length > 0);
  }
});

test('empty options object defaults to all-on (per-flag default true)', () => {
  setLocalOverride(SAMPLE_LOCAL);
  const out = resolveExtraSlashes('en', {}, T);
  const expected =
    SAMPLE_LOCAL.PKM_COMMANDS.length +
    SAMPLE_LOCAL.OMC_ALIASES.length +
    SAMPLE_LOCAL.OMC_SKILLS.length +
    BUILTIN_EXTRAS.length;
  assert.equal(out.length, expected);
});

test('setLocalOverride(null) resets PKM/OMC catalogs back to empty', () => {
  setLocalOverride(SAMPLE_LOCAL);
  assert.ok(getPkmCommands().length > 0);
  setLocalOverride(null);
  assert.deepEqual(getPkmCommands(), []);
  assert.deepEqual(getOmcAliases(), []);
  assert.deepEqual(getOmcSkills(), []);
});

test('setLocalOverride: partial override only replaces provided arrays', () => {
  setLocalOverride(SAMPLE_LOCAL);
  // Now override with just PKM — alias/skills should reset to empty per the
  // applyLocalOverride contract (setLocalOverride wipes first, then applies).
  setLocalOverride({ PKM_COMMANDS: [{ cmd: '/x', desc: { ko: 'x', en: 'x' } }] });
  assert.equal(getPkmCommands().length, 1);
  assert.deepEqual(getOmcAliases(), []);
  assert.deepEqual(getOmcSkills(), []);
});
