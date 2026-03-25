// Generate actual HTML by requiring extension module parts
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');

// Extract just the getWebviewContent function
const funcStart = src.indexOf('function getWebviewContent(');
const funcEnd = src.indexOf('\n}\n', src.indexOf("</html>`", funcStart));
const funcCode = src.substring(funcStart, funcEnd + 2);

// Wrap it so we can call it
const wrapper = funcCode + '\nreturn getWebviewContent(...args);';

const T = {
  title: 'Claude Code', send: 'Send', queueAdd: 'Queue',
  inputHint: 'Enter: Send / Shift+Enter: Newline',
  contextUsage: 'Context', queueRunning: 'Running ',
  queueDone: 'Done', closeResumeLater: 'Close',
  clearScreen: 'Clear', copy: 'Copy', paste: 'Paste',
  pasteImage: 'Image', search: 'Search',
  toggleInputPanel: 'Input', openSettings: 'Settings',
  exportChat: 'Export', colorTag: 'Color', editMemo: 'Memo',
  setTitle: 'Title', zoomIn: '+', zoomOut: '-', zoomReset: '0',
  soundToggle: 'Sound', helpOverlay: '?',
  settingsTitle: 'Settings', settingsTheme: 'Theme',
  settingsFontSize: 'Font Size', settingsFontFamily: 'Font Family',
  settingsSound: 'Sound', settingsParticles: 'Particles',
  settingsCustomButtons: 'Custom Buttons',
  settingsCustomSlash: 'Custom Slash',
  settingsImport: 'Import', settingsExport: 'Export',
  settingsClose: 'Close', settingsBtnAdd: 'Add',
  settingsSlashAdd: 'Add', settingsLabelPlaceholder: 'Label',
  settingsCommandPlaceholder: 'Command',
  settingsSlashNamePlaceholder: 'Name',
  settingsSlashContentPlaceholder: 'Content',
  cliNotInstalled: 'Not installed', wrapUp: 'Wrap Up'
};

try {
  const fn = new Function('args', wrapper);
  const html = fn([
    'xterm.css', 'xterm.js', 'fit.js', 'links.js', 'search.js',
    true, 11, 'Claude Code', '', [], T, {}, []
  ]);

  const lines = html.split('\n');
  console.log('Total generated HTML lines:', lines.length);

  // Show lines around 1080
  console.log('\n--- Lines 1075-1090 ---');
  for (let i = 1074; i < 1090 && i < lines.length; i++) {
    const lineNum = i + 1;
    const marker = lineNum === 1080 ? '>>>' : '   ';
    const line = lines[i];
    console.log(marker + ' ' + lineNum + ' (len=' + line.length + '): ' + line.substring(0, 120));
    if (lineNum === 1080) {
      console.log('    col 58: char=' + JSON.stringify(line.charAt(57)) + ' around=' + JSON.stringify(line.substring(50, 70)));
    }
  }

  // Save full HTML for inspection
  fs.writeFileSync(path.join(__dirname, 'debug_output.html'), html);
  console.log('\nFull HTML saved to debug_output.html');
} catch(e) {
  console.error('Error:', e.message);
  console.error(e.stack);
}
