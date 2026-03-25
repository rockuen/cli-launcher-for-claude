const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('debug_output.html', 'utf8');

const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>', scriptStart);
const script = html.substring(scriptStart, scriptEnd);

// Use vm.Script which gives better error info
try {
  new vm.Script(script, { filename: 'webview.js' });
  console.log('Script parsed OK');
} catch(e) {
  console.error('SYNTAX ERROR:', e.message);
  console.error('Stack:', e.stack.substring(0, 500));

  // Try to find line from message
  const lineMatch = e.stack.match(/webview\.js:(\d+)/);
  if (lineMatch) {
    const errLine = parseInt(lineMatch[1]);
    console.log('\nError at line:', errLine);
    const lines = script.split('\n');
    for (let i = Math.max(0, errLine - 5); i <= Math.min(lines.length - 1, errLine + 3); i++) {
      const marker = (i + 1) === errLine ? '>>>' : '   ';
      console.log(marker + ' ' + (i + 1) + ': ' + lines[i].substring(0, 200));
    }
  }
}
