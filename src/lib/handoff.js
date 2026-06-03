// @module lib/handoff — build a handoff note from an extracted message list.
//
// PoC: raw-text injection. The note is formatted as a markdown block that
// primes the receiving agent with the prior conversation context.
//
// Replacement point: swap buildHandoffNote() with an AI-summarisation call
// when a smarter context compression step is ready.

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
  lines.push(`# 이전 대화 인계 (from ${fromAgent})`);
  lines.push(`작업 폴더: ${cwd}`);
  lines.push('');
  lines.push('## 대화 내역');
  for (const m of messages) {
    const label = m.role === 'user' ? '[사용자]' : '[어시스턴트]';
    lines.push(`**${label}** ${m.text}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('위 맥락을 이어서 작업해줘.');
  // Append CR so the PTY treats this as a submitted message.
  return lines.join('\n') + '\r';
}

module.exports = { buildHandoffNote };
