// @module util/braceExpand — minimal shell-style {a,b,c} expander.
//
// Supports comma-separated alternatives in one or more braces, with simple
// nesting via recursion. Empty alternatives ({a,,b} → ['a','','b'] then
// trimmed at the call site) and unbalanced braces fall through unchanged so
// non-brace strings round-trip identically.
//
// Why this lives here: file/folder click handlers receive whatever the user
// selected verbatim. A common pattern in agent output is
// `.omc/state/team/X/workers/worker-{1,2,3}/answer.md` — without expansion
// the path never resolves on disk.

const MAX_EXPANSIONS = 32; // safety cap so pathological input cannot blow up

function expandBraces(input) {
  if (typeof input !== 'string') return [String(input)];
  if (!input.includes('{') || !input.includes('}')) return [input];

  // Match the first balanced (non-nested) {a,b,...} group. Bail out
  // unchanged if no comma-bearing group is present.
  const m = input.match(/^(.*?)\{([^{}]+)\}(.*)$/s);
  if (!m) return [input];
  const [, prefix, body, suffix] = m;
  if (!body.includes(',')) return [input];

  const alternatives = body.split(',');
  const results = [];
  for (const alt of alternatives) {
    if (results.length >= MAX_EXPANSIONS) break;
    const composed = prefix + alt + suffix;
    const sub = expandBraces(composed);
    for (const s of sub) {
      if (results.length >= MAX_EXPANSIONS) break;
      results.push(s);
    }
  }
  return results.length > 0 ? results : [input];
}

module.exports = { expandBraces };
