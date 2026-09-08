// gjc model profiles.
//
// gjc bundles roles into PROFILES from a signed registry cached under the agent
// dir, activated per session with `gjc --mpreset <id>`. The launcher reads that
// registry so the picker can show what a profile binds before it is picked — a
// "Codex Pro" that resolves to gpt-5.6-sol is a hard startup failure on a
// ChatGPT Plus account, not a slower session.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(path.join(process.cwd(), 'src/lib/gjcProfiles.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

// handlers/gjcModel requires vscode unguarded (it owns QuickPick UI), so the
// pure helpers it exports need the module stubbed to be reachable from node:test.
function withGjcModel(fn: (gjcModel: any) => void) {
  const modulePath = path.join(process.cwd(), 'src/handlers/gjcModel.js');
  delete require.cache[require.resolve(modulePath)];
  const origLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'vscode') {
      return {
        env: { language: 'en' },
        window: {},
        workspace: { getConfiguration: () => ({ get: (_k: string, fb: any) => fb }) },
        QuickPickItemKind: { Separator: -1, Default: 0 },
        ConfigurationTarget: { Global: 1 },
      };
    }
    return origLoad.apply(this, [request, ...rest]);
  };
  try {
    fn(require(modulePath));
  } finally {
    (Module as any)._load = origLoad;
    delete require.cache[require.resolve(modulePath)];
  }
}

function registry(activeRevision: number, revisions: Array<{ rev: number; profiles: any[] }>) {
  return JSON.stringify({
    version: 1,
    activeRevision,
    history: revisions.map((r) => ({
      manifest: { signed: { registryRevision: r.rev } },
      profiles: { schemaVersion: '1.0.0', revision: String(r.rev), profiles: r.profiles },
    })),
  });
}

test('parseProfileRegistry reads the active revision, not the newest one', () => {
  // gjc keeps every accepted revision and can be pinned or rolled back, so the
  // live profile set is the one activeRevision names.
  const raw = registry(1, [
    { rev: 1, profiles: [{ id: 'codex-pro', displayName: 'Codex Pro', providerGroup: 'CODEX', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-5.6-sol:medium' } }] },
    { rev: 2, profiles: [{ id: 'rolled-forward', displayName: 'Rolled Forward', providerGroup: 'CODEX', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-6:medium' } }] },
  ]);

  const profiles = mod.parseProfileRegistry(raw);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'codex-pro');
  assert.equal(profiles[0].displayName, 'Codex Pro');
  assert.equal(profiles[0].group, 'CODEX');
  assert.equal(profiles[0].defaultBinding, 'openai-codex/gpt-5.6-sol:medium');
  assert.deepEqual(profiles[0].providerGroups, [['openai-codex']]);
});

test('parseProfileRegistry normalizes bindings, groups and junk entries', () => {
  const raw = registry(3, [{
    rev: 3,
    profiles: [
      // a fallback chain, not a single model
      { id: 'claude-opus', roleBindings: { default: ['anthropic/claude-opus-5:xhigh', 'anthropic/claude-opus-4-6:xhigh'] }, requiredProviders: ['anthropic'] },
      // interchangeable regional plans
      { id: 'mimo-medium', displayName: 'Mimo Medium', providerGroup: 'MIMO', requiredProviders: ['xiaomi'], alternativeProviderGroups: [['xiaomi-token-plan-cn', 'xiaomi']], roleBindings: { default: 'xiaomi/mimo-v2.5-pro:medium' } },
      // provider-agnostic (open weights)
      { id: 'open-weights-glm', displayName: 'GLM', providerGroup: 'OPEN WEIGHTS', requiredProviders: [], roleBindings: { default: 'glm-5.2:medium' } },
      null,
      { displayName: 'no id' },
    ],
  }]);

  const profiles = mod.parseProfileRegistry(raw);
  assert.deepEqual(profiles.map((p: any) => p.id), ['claude-opus', 'mimo-medium', 'open-weights-glm']);
  assert.equal(profiles[0].displayName, 'claude-opus', 'displayName falls back to the id');
  assert.equal(profiles[0].group, 'OTHER', 'a profile with no providerGroup still groups');
  assert.equal(profiles[0].defaultBinding, 'anthropic/claude-opus-5:xhigh', 'the head of a fallback chain is the binding');
  assert.deepEqual(profiles[1].providerGroups, [['xiaomi'], ['xiaomi-token-plan-cn', 'xiaomi']]);
  assert.deepEqual(profiles[2].providerGroups, []);
});

test('parseProfileRegistry survives a corrupt or empty registry', () => {
  assert.deepEqual(mod.parseProfileRegistry('not json'), []);
  assert.deepEqual(mod.parseProfileRegistry('{}'), []);
  assert.deepEqual(mod.parseProfileRegistry(JSON.stringify({ activeRevision: 1, history: [] })), []);
});

// The project-scoped agent dir has no registry until gjc fetches one, and the
// registry is a machine-wide signed cache rather than project state — so the
// real home is a legitimate fallback.
test('readProfiles falls back to the real home when the project home has no registry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gjc-profiles-'));
  const project = path.join(dir, 'project', 'agent');
  const real = path.join(dir, 'real', 'agent');
  fs.mkdirSync(path.join(real, 'model-presets'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(real, 'model-presets', 'state.json'),
    registry(1, [{ rev: 1, profiles: [{ id: 'grok-build-pro', requiredProviders: ['grok-build'], roleBindings: { default: 'grok-build/grok-build' } }] }]),
  );

  assert.deepEqual(mod.readProfiles(project, real).map((p: any) => p.id), ['grok-build-pro']);
  assert.deepEqual(mod.readProfiles(project, null), [], 'no registry anywhere is empty, not a throw');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('providerStatusFromAccounts marks a provider usable only when a live row exists', () => {
  const accounts = JSON.stringify({
    ok: true,
    accounts: [
      // one dead row, one live row for the same provider → usable
      { provider: 'anthropic', disabled: true, disabledCause: 'auth_failure', health: { status: 'failed' } },
      { provider: 'anthropic', disabled: false, health: { status: 'unknown' } },
      // present but revoked
      { provider: 'grok-build', disabled: true, health: { status: 'failed' } },
      // enabled flag but a failed probe is still unusable
      { provider: 'xai', disabled: false, health: { status: 'failed' } },
      { provider: 'openai-codex', disabled: false, health: { status: 'unknown' } },
      null,
    ],
  });

  const status = mod.providerStatusFromAccounts(accounts);
  assert.equal(status.get('anthropic'), 'available');
  assert.equal(status.get('grok-build'), 'disabled');
  assert.equal(status.get('xai'), 'disabled');
  assert.equal(status.get('openai-codex'), 'available');
  assert.equal(status.get('google-antigravity'), undefined, 'a provider with no row is absent, not "disabled"');

  assert.equal(mod.providerStatusFromAccounts('not json').size, 0);
  assert.equal(mod.providerStatusFromAccounts(null).size, 0);
});

test('describeProfileProviders reports facts and flags only the certain failure', () => {
  const status = mod.providerStatusFromAccounts(JSON.stringify({
    accounts: [
      { provider: 'openai-codex', disabled: false, health: { status: 'unknown' } },
      { provider: 'grok-build', disabled: true, health: { status: 'failed' } },
    ],
  }));
  const [codex, grok, combo, agnostic] = mod.parseProfileRegistry(registry(1, [{
    rev: 1,
    profiles: [
      { id: 'codex-pro', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-5.6-sol:medium' } },
      { id: 'grok-build-pro', requiredProviders: ['grok-build'], roleBindings: { default: 'grok-build/grok-build' } },
      { id: 'opus-codex', requiredProviders: ['anthropic', 'openai-codex'], roleBindings: { default: 'anthropic/claude-opus-5:xhigh' } },
      { id: 'open-weights-glm', requiredProviders: [], roleBindings: { default: 'glm-5.2:medium' } },
    ],
  }]));

  const codexReport = mod.describeProfileProviders(codex, status);
  assert.equal(codexReport.satisfiable, true);
  assert.equal(codexReport.noCredentials, false);

  // The exact state that made every launcher gjc session fail with
  // "requires credentials for: grok-build".
  const grokReport = mod.describeProfileProviders(grok, status);
  assert.equal(grokReport.satisfiable, false);
  assert.equal(grokReport.noCredentials, true);
  assert.deepEqual(grokReport.providers, [{ id: 'grok-build', status: 'disabled' }]);

  // A combo with one provider missing is not satisfiable, but it is not the
  // certain "nothing is logged in" failure either — no warning is asserted.
  const comboReport = mod.describeProfileProviders(combo, status);
  assert.equal(comboReport.satisfiable, false);
  assert.equal(comboReport.noCredentials, false);
  assert.deepEqual(comboReport.providers, [{ id: 'anthropic', status: 'none' }, { id: 'openai-codex', status: 'available' }]);

  const agnosticReport = mod.describeProfileProviders(agnostic, status);
  assert.deepEqual(agnosticReport.providers, []);
  assert.equal(agnosticReport.noCredentials, false, 'a provider-agnostic profile is never flagged');
  assert.equal(agnosticReport.satisfiable, true, 'requiring nothing is satisfied, not unsatisfiable');
});

// The registry carries 60+ profiles across every provider gjc supports. A list
// dominated by subscriptions the user does not have buries the ones they do.
test('the picker shows profiles for the providers this machine knows, or all of them', () => withGjcModel((gjcModel) => {
  const profiles = mod.parseProfileRegistry(registry(1, [{
    rev: 1,
    profiles: [
      { id: 'codex-pro', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-5.6-sol:medium' } },
      { id: 'kimi-coding-plan-pro', requiredProviders: ['kimi-code'], roleBindings: { default: 'kimi-code/k3:max' } },
      { id: 'open-weights-glm', requiredProviders: [], roleBindings: { default: 'glm-5.2:medium' } },
    ],
  }]));
  const known = mod.providerStatusFromAccounts(JSON.stringify({
    accounts: [{ provider: 'openai-codex', disabled: true, health: { status: 'failed' } }],
  }));

  // A disabled row still counts as "this is one of my subscriptions".
  assert.deepEqual(
    gjcModel._relevantProfiles(profiles, known).map((p: any) => p.id),
    ['codex-pro', 'open-weights-glm'],
  );
  // Nothing known → hiding everything would be worse than showing everything.
  assert.deepEqual(
    gjcModel._relevantProfiles(profiles, new Map()).map((p: any) => p.id),
    ['codex-pro', 'kimi-coding-plan-pro', 'open-weights-glm'],
    'with no account state the whole registry is offered',
  );
}));

test('profile detail names the bound model and the unusable providers', () => withGjcModel((gjcModel) => {
  const [profile] = mod.parseProfileRegistry(registry(1, [{
    rev: 1,
    profiles: [{ id: 'codex-pro', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-5.6-sol:medium' } }],
  }]));

  const usable = gjcModel._profileDetail(profile, { providers: [{ id: 'openai-codex', status: 'available' }], satisfiable: true, noCredentials: false });
  assert.ok(usable.includes('openai-codex/gpt-5.6-sol:medium'), 'the bound model is visible before picking');
  assert.ok(usable.includes('openai-codex ✓'));

  const dead = gjcModel._profileDetail(profile, { providers: [{ id: 'openai-codex', status: 'none' }], satisfiable: false, noCredentials: true });
  assert.ok(dead.includes('openai-codex ✗'));
  assert.ok(/requires credentials|로그인/.test(dead), 'the certain failure is spelled out');
}));

test('profile items group by subscription and mark the active profile', () => withGjcModel((gjcModel) => {
  const profiles = mod.parseProfileRegistry(registry(1, [{
    rev: 1,
    profiles: [
      { id: 'codex-eco', displayName: 'Codex Eco', providerGroup: 'CODEX', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-5.6-terra:low' } },
      { id: 'codex-pro', displayName: 'Codex Pro', providerGroup: 'CODEX', requiredProviders: ['openai-codex'], roleBindings: { default: 'openai-codex/gpt-5.6-sol:medium' } },
      { id: 'grok-build-pro', displayName: 'Grok Build Pro', providerGroup: 'GROK', requiredProviders: ['grok-build'], roleBindings: { default: 'grok-build/grok-build' } },
    ],
  }]));
  const status = mod.providerStatusFromAccounts(JSON.stringify({
    accounts: [{ provider: 'openai-codex', disabled: false, health: { status: 'unknown' } }],
  }));

  const items = gjcModel._profileItems(profiles, status, 'codex-pro');
  const separators = items.filter((i: any) => i.kind === -1).map((i: any) => i.label);
  assert.deepEqual(separators, ['CODEX', 'GROK'], 'one separator per subscription, no repeats');

  const picks = items.filter((i: any) => i._profile);
  assert.deepEqual(picks.map((i: any) => i._profile), ['codex-eco', 'codex-pro', 'grok-build-pro']);
  assert.ok(picks[1].label.startsWith('$(check) '), 'the saved profile is marked');
  assert.ok(!picks[0].label.startsWith('$(check) '));
  assert.ok(picks[0].detail.includes('openai-codex/gpt-5.6-terra:low'));
  assert.ok(/requires credentials|로그인/.test(picks[2].detail), 'the profile with no login says so');
}));

// A profile only reaches gjc through --mpreset, and only on a fresh session: a
// resume restores the session's own choice, so forcing it would override what
// the user picked inside the session.
test('gjc profile reaches the spawn as --mpreset on fresh sessions only', () => {
  const createPanel = fs.readFileSync(path.join(process.cwd(), 'src/panel/createPanel.js'), 'utf8');
  const restartPty = fs.readFileSync(path.join(process.cwd(), 'src/panel/restartPty.js'), 'utf8');

  for (const [name, source, guard] of [
    ['createPanel', createPanel, 'if (!session?.sessionId) {'],
    ['restartPty', restartPty, 'if (!entry.sessionId) {'],
  ] as Array<[string, string, string]>) {
    const guardAt = source.indexOf(guard);
    const presetAt = source.indexOf("'--mpreset'");
    assert.ok(presetAt > guardAt && guardAt !== -1, `${name} passes --mpreset inside the fresh-session guard`);
    assert.ok(source.includes("get('gjc.profile', '')"), `${name} reads gjc.profile`);
  }
});
