// Extract getWebviewContent and evaluate it with mocks
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');

// Find the function boundaries
const funcStartIdx = src.indexOf('function getWebviewContent(');
// Find the closing of the function - it ends with `</html>`;  and then }
const htmlEndIdx = src.indexOf("</html>`", funcStartIdx);
const funcEndIdx = src.indexOf('\n}', htmlEndIdx);
const funcCode = src.substring(funcStartIdx, funcEndIdx + 2);

// Create a module that exports the function
const moduleCode = `
${funcCode}
module.exports = getWebviewContent;
`;

// Write to temp file
const tmpFile = path.join(__dirname, '_tmp_getWebview.js');
fs.writeFileSync(tmpFile, moduleCode);

try {
  const getWebviewContent = require(tmpFile);

  const T = {
    title: 'Claude Code', send: 'Send', queueAdd: 'Queue',
    inputHint: 'Enter Send', contextUsage: 'Context',
    queueRunning: 'Running ', queueDone: 'Done',
    closeResumeLater: 'Close', clearScreen: 'Clear',
    copy: 'Copy', paste: 'Paste', pasteImage: 'Image',
    search: 'Search', toggleInputPanel: 'Input',
    openSettings: 'Settings', exportChat: 'Export',
    colorTag: 'Color', editMemo: 'Memo', setTitle: 'Title',
    zoomIn: '+', zoomOut: '-', zoomReset: '0',
    soundToggle: 'Sound', helpOverlay: '?',
    starting: 'Starting...', memoEditTip: 'Memo',
    ctxUsageTip: 'Context', pasteImageTip: 'Image',
    zoomOutTip: 'Zoom-', zoomInTip: 'Zoom+',
    exportTip: 'Export', soundToggleTip: 'Sound',
    newTabTip: 'New', searchPlaceholder: 'Search...',
    searchPrevTip: 'Prev', searchNextTip: 'Next',
    searchCloseTip: 'Close', processExited: 'Exited',
    restartBtn: 'Restart', dropFiles: 'Drop files',
    scrollBottomTip: 'Bottom', themeTitle: 'Theme',
    themeDefault: 'Default', themeMidnight: 'Midnight',
    themeOcean: 'Ocean', themeForest: 'Forest',
    themeSunset: 'Sunset', themeAurora: 'Aurora',
    themeWarm: 'Warm', inputPlaceholder: 'Type...',
    scTitle: 'Shortcuts', scSearch: 'Search',
    scZoomIn: 'Zoom+', scZoomOut: 'Zoom-',
    scZoomReset: 'Reset', scPasteImage: 'Image',
    scOpenFile: 'Open', scHistory: 'History',
    scEditorToggle: 'Toggle', scHelp: 'Help',
    scContextMenu: 'Menu', scContextActions: 'Actions',
    scClose: 'Close', ctxCopy: 'Copy',
    ctxOpenFile: 'Open', ctxSelectedText: 'Selection',
    ctxPaste: 'Paste', ctxPasteImage: 'Image',
    ctxSearch: 'Search', ctxClear: 'Clear',
    ctxExport: 'Export', ctxZoomIn: 'Zoom+',
    ctxZoomOut: 'Zoom-', ctxZoomReset: 'Reset',
    ctxEditMemo: 'Memo', ctxChangeTheme: 'Theme',
    ctxParticlesOff: 'Particles Off',
    ctxParticlesOn: 'Particles On',
    ctxSoundOff: 'Sound Off', ctxSoundOn: 'Sound On',
    ctxCloseResume: 'Close Resume',
    selectTextFirst: 'Select first',
    openFileToast: 'Open: ', ctxQuerying: 'Querying...',
    soundOnToast: 'On', soundOffToast: 'Off',
    addMemo: '+ Memo', themeApplied: 'Theme: ',
    exportingToast: 'Exporting...', exportDone: 'Done',
    exportFailToast: 'Fail', imageDone: 'Done: ',
    imageFailToast: 'Fail: ', ctxCompacted: 'Compacted',
    processErrorExit: 'Error exit',
    processNormalExit: 'Exited', resumeRestart: 'Resume',
    newStart: 'New', restartingToast: 'Restarting...',
    stRunning: 'Running', stWaiting: 'Idle',
    stAttention: 'Attention', stDone: 'Done',
    stError: 'Error', imagePasting: 'Pasting...',
    copied: 'Copied', clipboardChecking: 'Checking...',
    particlesOnToast: 'On', particlesOffToast: 'Off',
    slashCompact: 'Compact', slashClear: 'Clear',
    slashModel: 'Model', slashCost: 'Cost',
    slashHelp: 'Help', slashMemory: 'Memory',
    slashConfig: 'Config', slashReview: 'Review',
    slashPrComments: 'PR', slashDoctor: 'Doctor',
    slashInit: 'Init', slashLogin: 'Login',
    slashLogout: 'Logout', slashTerminalSetup: 'Setup',
    slashContext: 'Context', wrapUp: 'Wrap Up',
    settingsTitle: 'Settings', settingsTheme: 'Theme',
    settingsFontSize: 'Size', settingsFontFamily: 'Family',
    settingsSound: 'Sound', settingsParticles: 'Particles',
    settingsCustomButtons: 'Buttons',
    settingsCustomSlash: 'Slash',
    settingsImport: 'Import', settingsExport: 'Export',
    settingsClose: 'Close', settingsBtnAdd: 'Add',
    settingsSlashAdd: 'Add',
    settingsLabelPlaceholder: 'Label',
    settingsCommandPlaceholder: 'Command',
    settingsSlashNamePlaceholder: 'Name',
    settingsSlashContentPlaceholder: 'Content',
    cliNotInstalled: 'Not installed'
  };

  const settings = {
    fontFamily: '"D2Coding", "D2Coding ligature", Consolas, monospace',
    defaultTheme: 'default',
    soundEnabled: true,
    particlesEnabled: true
  };

  const html = getWebviewContent(
    'xterm.css', 'xterm.js', 'fit.js', 'links.js', 'search.js',
    true, 11, 'Claude Code', '', [], T, settings, []
  );

  const lines = html.split('\n');
  console.log('Total HTML lines:', lines.length);

  console.log('\n--- Lines 1075-1090 ---');
  for (let i = 1074; i < 1090 && i < lines.length; i++) {
    const num = i + 1;
    const marker = num === 1080 ? '>>>' : '   ';
    console.log(marker + ' ' + num + ': ' + lines[i].substring(0, 140));
    if (num === 1080) {
      console.log('    Length:', lines[i].length);
      if (lines[i].length >= 58) {
        console.log('    Col 58 char:', JSON.stringify(lines[i][57]));
        console.log('    Around col 58:', JSON.stringify(lines[i].substring(50, 70)));
      } else {
        console.log('    Line too short for col 58');
      }
    }
  }

  // Save full HTML
  fs.writeFileSync(path.join(__dirname, 'debug_output.html'), html);
  console.log('\nSaved full HTML to debug_output.html');

} catch(e) {
  console.error('Error:', e.message);
  console.error(e.stack);
} finally {
  try { fs.unlinkSync(tmpFile); } catch(_) {}
}
