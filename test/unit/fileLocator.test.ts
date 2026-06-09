// v3.9 — fileLocator pure-function tests. parseLocatorOutput is the safety gate
// between a raw OS-index dump (Everything es.exe / mdfind / locate) and the
// files we actually offer to open: exact basename only, recycle-bin /
// node_modules / .git noise removed, deduped, capped. The CSV fixture mirrors
// real es.exe output captured on Windows (a bare CSV plus its .lnk shortcuts).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  parseLocatorOutput,
  buildEsArgs,
  buildMdfindArgs,
  buildLocateArgs,
} = require('../../src/lib/fileLocator');

test('parseLocatorOutput keeps only the exact-basename file, drops .lnk shortcuts', () => {
  // Real es.exe capture for "_merged_erp_inbound.csv".
  const stdout = [
    'C:\\Users\\FURSYS\\Downloads\\erp-inbound\\_merged_erp_inbound.csv',
    'C:\\Users\\FURSYS\\AppData\\Roaming\\Microsoft\\Excel\\_merged_erp_inbound312585360850512396\\_merged_erp_inbound.csv.lnk',
    'C:\\Users\\FURSYS\\AppData\\Roaming\\Microsoft\\Office\\Recent\\_merged_erp_inbound.csv.LNK',
    'C:\\Users\\FURSYS\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\_merged_erp_inbound.csv.lnk',
  ].join('\r\n');
  const out = parseLocatorOutput(stdout, '_merged_erp_inbound.csv');
  assert.deepEqual(out, [
    'C:\\Users\\FURSYS\\Downloads\\erp-inbound\\_merged_erp_inbound.csv',
  ]);
});

test('parseLocatorOutput filters recycle bin, node_modules, and .git', () => {
  const stdout = [
    'C:\\$Recycle.Bin\\S-1-5-21\\foo\\package.json',
    'C:\\dev\\burst\\package.json',
    'C:\\dev\\burst\\node_modules\\.vite\\deps\\package.json',
    'C:\\dev\\burst\\.git\\modules\\x\\package.json',
  ].join('\n');
  const out = parseLocatorOutput(stdout, 'package.json');
  assert.deepEqual(out, ['C:\\dev\\burst\\package.json']);
});

test('parseLocatorOutput can include node_modules when asked', () => {
  const stdout = [
    'C:\\dev\\app\\package.json',
    'C:\\dev\\app\\node_modules\\x\\package.json',
  ].join('\n');
  const out = parseLocatorOutput(stdout, 'package.json', { excludeNodeModules: false });
  assert.equal(out.length, 2);
});

test('parseLocatorOutput dedupes case-insensitively and caps results', () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push(`C:\\d\\sub${i}\\report.csv`);
  lines.push('C:\\D\\SUB0\\REPORT.CSV'); // same path as sub0 once lowercased → dup
  const out = parseLocatorOutput(lines.join('\n'), 'report.csv', { maxResults: 10 });
  assert.equal(out.length, 10);
});

test('parseLocatorOutput matches basename case-insensitively (Windows/macOS)', () => {
  const out = parseLocatorOutput('C:\\data\\Report.CSV', 'report.csv');
  assert.deepEqual(out, ['C:\\data\\Report.CSV']);
});

test('parseLocatorOutput is case-sensitive when caseInsensitive:false (Linux)', () => {
  const stdout = '/data/Report.csv\n/data/report.csv';
  const out = parseLocatorOutput(stdout, 'report.csv', { caseInsensitive: false });
  assert.deepEqual(out, ['/data/report.csv']);
});

test('parseLocatorOutput returns [] for empty / invalid input', () => {
  assert.deepEqual(parseLocatorOutput('', 'x.csv'), []);
  assert.deepEqual(parseLocatorOutput(null, 'x.csv'), []);
  assert.deepEqual(parseLocatorOutput('a\nb', ''), []);
  assert.deepEqual(parseLocatorOutput(undefined, undefined), []);
});

test('parseLocatorOutput skips blank lines and trims surrounding space', () => {
  const out = parseLocatorOutput('\n  C:\\data\\x.csv  \n\n', 'x.csv');
  assert.deepEqual(out, ['C:\\data\\x.csv']);
});

test('buildEsArgs uses whole-filename match and a result cap', () => {
  assert.deepEqual(buildEsArgs('a b.csv', 15), ['-n', '15', 'wfn:a b.csv']);
  assert.deepEqual(buildEsArgs('x.csv'), ['-n', '20', 'wfn:x.csv']);
});

test('buildMdfindArgs queries by name', () => {
  assert.deepEqual(buildMdfindArgs('x.csv'), ['-name', 'x.csv']);
});

test('buildLocateArgs is basename + case-insensitive + limit', () => {
  assert.deepEqual(buildLocateArgs('x.csv', 5), ['-i', '-b', '-l', '5', 'x.csv']);
});
