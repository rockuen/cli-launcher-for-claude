// @module lib/slashRegistry — extra slash command catalog injected into the
// webview slash autocomplete dropdown. v3.4.0.
//
// Two layers, both toggle-gated independently:
//
//   1. BUILTIN_EXTRAS (public) — Claude Code built-in slashes that already had
//      i18n labels in v3.2.1 but were never spread into the live `slashCommands`
//      array (`/resume`, `/usage`, `/effort`, `/output-style`, etc.). These ship
//      with the published extension so every user gets the broader autocomplete
//      menu out of the box.
//
//   2. PKM / OMC catalogs (personal) — empty by default in the public build.
//      A maintainer (or any user who wants their own personal catalog) can
//      drop a sibling file at `src/lib/slashRegistry.local.js` to wire in their
//      own `.claude/commands/*.md` project slashes and `/oh-my-claudecode:<skill>`
//      catalog. That file is `.gitignore`d so it never lands in the published
//      vsix. See README §"Registering your own slashes" for a Claude Code
//      prompt that builds the file from your local environment.
//
// Each entry's `desc` is a `{ ko, en }` object; `resolveExtraSlashes()` flattens
// to a single string per locale before injection. The `[OMC]` / `[PKM]`
// category prefix is rendered here so the autocomplete filter can match
// either `/oh-my-claudecode` or the prefix tag.

const BUILTIN_EXTRAS = [
  // Session / context
  { cmd: '/rename',             key: 'slashRename' },
  { cmd: '/branch',             key: 'slashBranch' },
  { cmd: '/recap',              key: 'slashRecap' },
  { cmd: '/background',         key: 'slashBackground' },
  { cmd: '/tasks',              key: 'slashTasks' },
  { cmd: '/btw',                key: 'slashBtw' },
  { cmd: '/resume',             key: 'slashResume' },
  { cmd: '/export',             key: 'slashExport' },
  { cmd: '/copy',               key: 'slashCopy' },
  { cmd: '/diff',               key: 'slashDiff' },
  // Config / setup
  { cmd: '/status',             key: 'slashStatus' },
  { cmd: '/theme',              key: 'slashTheme' },
  { cmd: '/statusline',         key: 'slashStatusline' },
  { cmd: '/keybindings',        key: 'slashKeybindings' },
  { cmd: '/skills',             key: 'slashSkills' },
  { cmd: '/plugin',             key: 'slashPlugin' },
  { cmd: '/agents',             key: 'slashAgents' },
  { cmd: '/mcp',                key: 'slashMcp' },
  { cmd: '/hooks',              key: 'slashHooks' },
  { cmd: '/permissions',        key: 'slashPermissions' },
  { cmd: '/ide',                key: 'slashIde' },
  { cmd: '/add-dir',            key: 'slashAddDir' },
  { cmd: '/sandbox',            key: 'slashSandbox' },
  // Model / reasoning
  { cmd: '/effort',             key: 'slashEffort' },
  { cmd: '/fast',               key: 'slashFast' },
  // Info / account
  { cmd: '/usage',              key: 'slashUsage' },
  { cmd: '/security-review',    key: 'slashSecurityReview' },
  { cmd: '/privacy-settings',   key: 'slashPrivacySettings' },
  { cmd: '/usage-credits',      key: 'slashUsageCredits' },
  { cmd: '/upgrade',            key: 'slashUpgrade' },
  { cmd: '/feedback',           key: 'slashFeedback' },
  { cmd: '/bug',                key: 'slashBug' },
  { cmd: '/install-github-app', key: 'slashInstallGithubApp' },
  { cmd: '/install-slack-app',  key: 'slashInstallSlackApp' },
  { cmd: '/release-notes',      key: 'slashReleaseNotes' },
  // Integration / devices
  { cmd: '/mobile',             key: 'slashMobile' },
  { cmd: '/desktop',            key: 'slashDesktop' },
  { cmd: '/teleport',           key: 'slashTeleport' },
  { cmd: '/remote-control',     key: 'slashRemoteControl' },
];

// Personal catalogs — empty in the public build, replaced wholesale when the
// optional `slashRegistry.local.js` sibling file is present.
let PKM_COMMANDS = [];
let OMC_ALIASES = [];
let OMC_SKILLS = [];

function applyLocalOverride(local) {
  if (!local || typeof local !== 'object') return;
  if (Array.isArray(local.PKM_COMMANDS)) PKM_COMMANDS = local.PKM_COMMANDS;
  if (Array.isArray(local.OMC_ALIASES)) OMC_ALIASES = local.OMC_ALIASES;
  if (Array.isArray(local.OMC_SKILLS)) OMC_SKILLS = local.OMC_SKILLS;
}

try {
  // eslint-disable-next-line node/no-missing-require
  applyLocalOverride(require('./slashRegistry.local'));
} catch (e) {
  // No personal override — public build serves only BUILTIN_EXTRAS.
}

// Test seam: lets unit tests inject + reset catalogs without filesystem state.
// Pass `null` (or no arg) to reset to the empty public defaults.
function setLocalOverride(override) {
  PKM_COMMANDS = [];
  OMC_ALIASES = [];
  OMC_SKILLS = [];
  if (override) applyLocalOverride(override);
}

function pickDesc(entry, locale) {
  if (typeof entry.desc === 'object' && entry.desc) {
    return entry.desc[locale] || entry.desc.en || entry.desc.ko || '';
  }
  return entry.desc || '';
}

function tagged(prefix, desc) {
  return prefix ? `${prefix} ${desc}` : desc;
}

// resolveExtraSlashes(locale, options, T)
//   locale  — 'ko' | 'en'
//   options — { includeBuiltinExtras, includePkm, includeOmc } booleans
//   T       — translation map (used only for builtinExtras, which key into i18n)
// Returns: [{ cmd, desc }, ...] in display order. PKM first, then OMC alias,
// then OMC namespaced, then builtin extras at the end so the most-used custom
// slashes surface above the long built-in tail.
function resolveExtraSlashes(locale, options, T) {
  const opts = options || {};
  const out = [];

  if (opts.includePkm !== false) {
    for (const e of PKM_COMMANDS) {
      out.push({ cmd: e.cmd, desc: tagged('[PKM]', pickDesc(e, locale)) });
    }
  }

  if (opts.includeOmc !== false) {
    for (const e of OMC_ALIASES) {
      out.push({ cmd: e.cmd, desc: tagged('[OMC alias]', pickDesc(e, locale)) });
    }
    for (const e of OMC_SKILLS) {
      out.push({ cmd: e.cmd, desc: tagged('[OMC]', pickDesc(e, locale)) });
    }
  }

  if (opts.includeBuiltinExtras !== false) {
    for (const e of BUILTIN_EXTRAS) {
      const desc = (T && T[e.key]) || e.key;
      out.push({ cmd: e.cmd, desc: desc });
    }
  }

  return out;
}

// Snapshot-style getters — return the live catalog at call time so tests can
// observe setLocalOverride() effects without re-importing.
function getPkmCommands() { return PKM_COMMANDS.slice(); }
function getOmcAliases() { return OMC_ALIASES.slice(); }
function getOmcSkills() { return OMC_SKILLS.slice(); }

module.exports = {
  resolveExtraSlashes,
  setLocalOverride,
  getPkmCommands,
  getOmcAliases,
  getOmcSkills,
  BUILTIN_EXTRAS,
};
