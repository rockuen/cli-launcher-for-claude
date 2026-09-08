// @module lib/gjcProfiles — gjc's signed model-profile registry + the account
// state each profile needs.
//
// On top of individual models gjc ships model PROFILES: role bundles that bind
// default/executor/architect/planner/critic at once ("Codex Pro", "Claude
// Opus", "Grok Build Pro", …). They are published as a signed registry and
// cached at <agentDir>/model-presets/state.json, and `gjc --mpreset <id>`
// activates one for a session — verified against gjc 0.16.6, where
// `--mpreset codex-eco` answered from an OpenAI model while the configured
// default profile was Anthropic.
//
// A picker needs two things beyond the profile's name. What the profile
// actually BINDS: "Codex Pro" resolves to `openai-codex/gpt-5.6-sol`, which a
// ChatGPT Plus account cannot serve at all, and picking it blind is how a gjc
// session ends at "warming workspace" instead of a prompt. And which providers
// it requires, since a profile whose provider was never logged in fails at
// startup with "requires credentials for: <provider>".
//
// Provider state comes from `gjc accounts list --json`. Note what that state
// can and cannot prove: an enabled account row does NOT mean the profile will
// run — gjc resolves model entitlement per request, and a stored, enabled
// grok-build row was observed on a home that still failed with "requires
// credentials for: grok-build". So this module reports per-provider facts and
// flags only the unambiguous negative (no account row at all, or every row
// disabled) rather than promising that anything else works.

const fs = require('fs');
const path = require('path');

function profileRegistryPath(agentDir) {
  return path.join(agentDir, 'model-presets', 'state.json');
}

// roleBindings entries are a model string or a fallback chain of them.
function _firstBinding(binding) {
  if (typeof binding === 'string') return binding;
  if (Array.isArray(binding)) {
    for (const entry of binding) {
      if (typeof entry === 'string' && entry) return entry;
    }
  }
  return '';
}

// The provider sets that can satisfy a profile. `requiredProviders` is the
// primary set; `alternativeProviderGroups` lists interchangeable substitutes
// (regional Xiaomi plans, for instance). Empty for provider-agnostic profiles.
function _providerGroups(profile) {
  const groups = [];
  const primary = Array.isArray(profile.requiredProviders) ? profile.requiredProviders.filter((p) => typeof p === 'string' && p) : [];
  if (primary.length) groups.push(primary);
  const alts = Array.isArray(profile.alternativeProviderGroups) ? profile.alternativeProviderGroups : [];
  for (const alt of alts) {
    if (!Array.isArray(alt)) continue;
    const clean = alt.filter((p) => typeof p === 'string' && p);
    if (clean.length) groups.push(clean);
  }
  return groups;
}

// Parse the ACTIVE revision out of the registry cache. gjc keeps every accepted
// revision in `history` and names the live one in `activeRevision`, so reading
// the last entry blind would serve a rolled-back registry.
function parseProfileRegistry(raw) {
  let state;
  try { state = JSON.parse(raw); } catch (_) { return []; }
  const history = Array.isArray(state && state.history) ? state.history : [];
  if (!history.length) return [];
  const active = history.find((h) => {
    const signed = h && h.manifest && h.manifest.signed;
    return signed && signed.registryRevision === state.activeRevision;
  }) || history[history.length - 1];
  const list = active && active.profiles && Array.isArray(active.profiles.profiles)
    ? active.profiles.profiles
    : [];
  const out = [];
  for (const profile of list) {
    if (!profile || typeof profile.id !== 'string' || !profile.id) continue;
    out.push({
      id: profile.id,
      displayName: (typeof profile.displayName === 'string' && profile.displayName) ? profile.displayName : profile.id,
      group: (typeof profile.providerGroup === 'string' && profile.providerGroup) ? profile.providerGroup : 'OTHER',
      defaultBinding: _firstBinding(profile.roleBindings && profile.roleBindings.default),
      providerGroups: _providerGroups(profile),
    });
  }
  return out;
}

// Best-effort read of the registry. The project-scoped agent dir may not carry
// one yet (gjc fetches it on first run), so callers pass the real home as a
// fallback: the registry is a machine-wide signed cache, not project state.
function readProfiles(agentDir, fallbackAgentDir) {
  for (const dir of [agentDir, fallbackAgentDir]) {
    if (!dir) continue;
    try {
      const profiles = parseProfileRegistry(fs.readFileSync(profileRegistryPath(dir), 'utf8'));
      if (profiles.length) return profiles;
    } catch (_) {}
  }
  return [];
}

// provider id → 'available' (an enabled row exists) | 'disabled' (rows exist,
// all disabled) | absent from the map (no row at all). `disabled` covers both
// gjc's explicit flag and a failed health probe, since either state makes the
// account unusable until the user logs in again.
function providerStatusFromAccounts(accountsJson) {
  const status = new Map();
  let parsed = accountsJson;
  if (typeof accountsJson === 'string') {
    try { parsed = JSON.parse(accountsJson); } catch (_) { return status; }
  }
  const accounts = Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [];
  for (const account of accounts) {
    if (!account || typeof account.provider !== 'string' || !account.provider) continue;
    const health = account.health && account.health.status;
    const usable = !account.disabled && health !== 'failed';
    if (usable) status.set(account.provider, 'available');
    else if (!status.has(account.provider)) status.set(account.provider, 'disabled');
  }
  return status;
}

// Per-provider facts for one profile, plus the single conclusion that is safe
// to draw: `noCredentials` when not one required provider has a usable account,
// which is exactly gjc's "requires credentials for: …" startup failure.
// Provider-agnostic profiles (no required providers) report nothing.
function describeProfileProviders(profile, statusMap) {
  const groups = (profile && profile.providerGroups) || [];
  const seen = [];
  const marks = new Map();
  for (const group of groups) {
    for (const provider of group) {
      if (marks.has(provider)) continue;
      const state = statusMap && statusMap.get ? (statusMap.get(provider) || 'none') : 'none';
      marks.set(provider, state);
      seen.push({ id: provider, status: state });
    }
  }
  // Nothing required is trivially satisfiable (provider-agnostic open-weight
  // profiles); otherwise one whole group has to be usable.
  const satisfiable = groups.length === 0
    || groups.some((group) => group.every((p) => marks.get(p) === 'available'));
  return {
    providers: seen,
    satisfiable,
    noCredentials: seen.length > 0 && seen.every((p) => p.status !== 'available'),
  };
}

module.exports = {
  profileRegistryPath,
  parseProfileRegistry,
  readProfiles,
  providerStatusFromAccounts,
  describeProfileProviders,
};
