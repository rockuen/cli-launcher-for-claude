import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'settingsPanel.js'), 'utf8');
}

test('Chief settings panel exposes credential and project fields', () => {
  const source = readSource();

  assert.match(source, /addChiefInput\(\s*'chief\.apiKey',[\s\S]*'API Token'/);
  assert.match(source, /addChiefInput\(\s*'chief\.projectId',[\s\S]*'Project ID'/);
  assert.match(source, /addChiefInput\(\s*'chief\.baseUrl',[\s\S]*'API Base URL'/);
  assert.match(source, /input\.type = secret \? 'password' : 'text'/);
});

test('Chief credential settings are loaded and allowed for writes', () => {
  const source = readSource();

  for (const key of ['chief.apiKey', 'chief.projectId', 'chief.baseUrl']) {
    assert.match(source, new RegExp(`cfg\\.get\\('${key.replace('.', '\\.')}'`));
    assert.match(source, new RegExp(`'${key.replace('.', '\\.')}'`));
  }
});
