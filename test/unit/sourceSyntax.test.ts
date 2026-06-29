// Guard: every src/**/*.js must parse. The build's tsc only covers src/**/*.ts
// (allowJs:false), and webview client scripts live INSIDE template literals in
// .js files — so a stray backtick / ${ in a webview-embedded comment or string
// silently breaks the enclosing template literal and only explodes when the
// module is require()d at runtime (e.g. opening the settings panel). This test
// runs `node --check` on every source .js so that class of error fails CI, not
// the user. (Regression: v3.17.0 settingsPanel.js telegram comment used
// backticks inside the webview template literal → "Unexpected identifier 'gjc'".)

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('all src/**/*.js parse under node --check (template-literal/syntax guard)', () => {
  const srcDir = path.join(process.cwd(), 'src');
  const files = listJsFiles(srcDir);
  assert.ok(files.length > 0, 'expected to find source .js files');
  const failures: string[] = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e: any) {
      const msg = (e && (e.stderr || e.message) || '').toString().split('\n').slice(0, 4).join(' ');
      failures.push(`${path.relative(process.cwd(), f)}: ${msg}`);
    }
  }
  assert.equal(failures.length, 0, `source .js syntax errors:\n${failures.join('\n')}`);
});
