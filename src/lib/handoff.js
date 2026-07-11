// @module lib/handoff — build a handoff note from an extracted message list.
//
// PoC: raw-text injection. The note is formatted as a markdown block that
// primes the receiving agent with the prior conversation context.
//
// Replacement point: swap buildHandoffNote() with an AI-summarisation call
// when a smarter context compression step is ready.

const { t } = require('../i18n');

/**
 * Build a markdown handoff note from a list of messages.
 *
 * @param {Array<{role: string, text: string}>} messages — from extractMessages()
 * @param {{ fromAgent: string, cwd: string }} meta
 * @returns {string} ready-to-inject prompt string (ends with '\r' for PTY)
 */
function buildHandoffNote(messages, meta) {
  const { fromAgent, cwd } = meta;
  const lines = [];
  lines.push(t('handoffNoteHeader').replace('{0}', fromAgent));
  lines.push(t('handoffNoteCwd').replace('{0}', cwd));
  lines.push('');
  lines.push(t('handoffNoteHistory'));
  for (const m of messages) {
    const label = m.role === 'user' ? t('handoffNoteUser') : t('handoffNoteAssistant');
    lines.push(`**${label}** ${m.text}`);
    lines.push('');
  }
  lines.push('---');
  lines.push(t('handoffNoteContinue'));
  // Append CR so the PTY treats this as a submitted message.
  return lines.join('\n') + '\r';
}

module.exports = { buildHandoffNote };
