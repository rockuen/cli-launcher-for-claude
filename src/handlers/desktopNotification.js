// @module handlers/desktopNotification — cross-platform OS toast.
// Windows: Win10+ toast via PowerShell + WinRT. macOS: osascript display notification.
// Linux: not implemented (no-op).
//
// showDesktopNotification(tabTitle) → "CLI Launcher" / <tab title> (the guessed
// turn-end and prompt notifications). With a body (v3.28.0, an agent's own
// `cli-launcher notify` message) → <tab title> / <body>.

// Tab titles keep the old conservative character set. A body is the agent's
// sentence, so punctuation stays; control characters go and it is capped.
function cleanTitle(s) {
  return String(s || '').replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ\s\-_]/g, '');
}
function cleanBody(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

function showDesktopNotification(tabTitle, body) {
  const { execFile } = require('child_process');
  const title = cleanTitle(tabTitle || 'Claude Code');
  const hasBody = typeof body === 'string' && cleanBody(body) !== '';
  const line1 = hasBody ? (title || 'CLI Launcher') : 'CLI Launcher';
  const line2 = hasBody ? cleanBody(body) : title;
  if (process.platform === 'win32') {
    // The text travels in environment variables, never inside the script: an
    // agent's message is untrusted, and PowerShell also ends a single-quoted
    // string at typographic quotes (‘ ’ ‚ ‛), so escaping ' alone is not enough.
    const psCmd = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
      '$n = $t.GetElementsByTagName("text");',
      '$n.Item(0).AppendChild($t.CreateTextNode($env:CLI_LAUNCHER_TOAST_TITLE)) | Out-Null;',
      '$n.Item(1).AppendChild($t.CreateTextNode($env:CLI_LAUNCHER_TOAST_BODY)) | Out-Null;',
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($t);',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("CLI Launcher").Show($toast)'
    ].join(' ');
    const env = { ...process.env, CLI_LAUNCHER_TOAST_TITLE: line1, CLI_LAUNCHER_TOAST_BODY: line2 };
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { timeout: 5000, env }, () => {});
  } else if (process.platform === 'darwin') {
    // Same idea: the text arrives as script arguments, not inside the source.
    // A leading "-" would be read as an osascript option.
    const arg = (s) => s.replace(/^-+/, '');
    execFile('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
      arg(line1), arg(line2),
    ], { timeout: 5000 }, () => {});
  }
}

module.exports = { showDesktopNotification, _test: { cleanTitle, cleanBody } };
