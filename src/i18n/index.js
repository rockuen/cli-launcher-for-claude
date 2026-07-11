// @module i18n — Runtime locale resolution and translation lookup.
// Loads per-locale strings from ./en and ./ko. Falls back to English for missing keys.
//
// English is the default. Korean strings are used ONLY when the editor display
// language starts with 'ko'. The vscode require is guarded so this module (and
// therefore t()) can be required from vscode-free contexts — pure-helper unit
// tests (node:test) and modules that guard their own vscode import — where it
// resolves to English rather than throwing.

let vscode = null;
try { vscode = require('vscode'); } catch (_) { vscode = null; }

const LOCALES = {
  en: require('./en'),
  ko: require('./ko'),
};

function getLocale() {
  const lang = (vscode && vscode.env && vscode.env.language) || 'en';
  return lang.startsWith('ko') ? 'ko' : 'en';
}

function t(key) {
  const locale = getLocale();
  return LOCALES[locale]?.[key] || LOCALES.en[key] || key;
}

// Returns the entire strings object for the current locale.
// Used when passing translations to the webview in one shot.
function getTranslations() {
  return LOCALES[getLocale()] || LOCALES.en;
}

module.exports = { LOCALES, getLocale, t, getTranslations };
