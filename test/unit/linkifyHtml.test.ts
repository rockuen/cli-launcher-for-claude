// v3.4.3 — readerRender.linkifyHtml() unit tests.
// Verifies plain-text URL/path/folder autolinking inside the reader area
// without double-wrapping inside protected tags (<pre>, <code>, <a>,
// <script>, <style>).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// readerRender stays as plain CommonJS so panel/*.js requires it directly.
// tsconfig.test.json already opts the file in via include + allowJs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { linkifyHtml, LINKIFY_EXTENSIONS } = require('../../src/lib/readerRender');

const countAnchors = (s: string) => (s.match(/<a /g) || []).length;

test('linkifyHtml: empty / undefined returns empty string', () => {
  assert.equal(linkifyHtml(''), '');
  assert.equal(linkifyHtml(undefined), '');
  assert.equal(linkifyHtml(null), '');
});

test('linkifyHtml: http URL is wrapped with auto-link class', () => {
  const out = linkifyHtml('see https://example.com today');
  assert.match(
    out,
    /<a href="https:\/\/example\.com" class="auto-link">https:\/\/example\.com<\/a>/,
  );
});

test('linkifyHtml: https URL with deep path + query', () => {
  const out = linkifyHtml('docs at https://x.io/a/b?c=1&d=2 ok');
  assert.match(out, /<a href="https:\/\/x\.io\/a\/b\?c=1&d=2" class="auto-link">/);
});

test('linkifyHtml: trailing sentence punctuation stays outside the URL', () => {
  const out = linkifyHtml('visit https://example.com.');
  // Period must not be inside href or visible text.
  assert.match(out, /<a href="https:\/\/example\.com" class="auto-link">https:\/\/example\.com<\/a>\./);
});

test('linkifyHtml: URL inside inline <code> IS linkified (Claude often backtick-quotes paths)', () => {
  // v3.4.4 — inline `<code>` is no longer treated as a protected region.
  // Multi-line code blocks (`<pre>`) stay protected; this test guards the
  // backtick-quoted path / URL case which is the common Claude output shape.
  const out = linkifyHtml('see <code>https://example.com</code>');
  assert.match(out, /<a href="https:\/\/example\.com" class="auto-link">/);
  assert.match(out, /<code>/); // outer <code> wrapper preserved
});

test('linkifyHtml: file path inside inline <code> IS linkified', () => {
  const out = linkifyHtml('open <code>/Users/foo/bar.md</code> please');
  assert.match(out, /<a href="\/Users\/foo\/bar\.md" class="auto-link">/);
  assert.match(out, /<code>/);
});

test('linkifyHtml: URL inside <pre> block is NOT linkified', () => {
  // Multi-line code block: linkifying random tokens inside a long snippet
  // would be noisy, so the protection stays.
  const html = '<pre>https://example.com\n/path/foo.md</pre>';
  assert.equal(linkifyHtml(html), html);
});

test('linkifyHtml: <pre><code>…</code></pre> block stays fully protected', () => {
  const html = '<pre><code>https://example.com\n/path/foo.md</code></pre>';
  assert.equal(linkifyHtml(html), html);
});

test('linkifyHtml: existing <a> is preserved + nearby plain path still wraps', () => {
  const html = '<a href="/x.md">x</a> and /Users/foo/bar.md';
  const out = linkifyHtml(html);
  assert.equal(countAnchors(out), 2, 'existing anchor + one new anchor');
  assert.match(out, /<a href="\/Users\/foo\/bar\.md" class="auto-link">/);
  assert.match(out, /<a href="\/x\.md">x<\/a>/); // intact
});

test('linkifyHtml: absolute POSIX path with .md extension', () => {
  const out = linkifyHtml('open /Users/rockuen/foo.md please');
  assert.match(
    out,
    /<a href="\/Users\/rockuen\/foo\.md" class="auto-link">\/Users\/rockuen\/foo\.md<\/a>/,
  );
});

test('linkifyHtml: tilde-prefixed path ~/Documents/notes.txt', () => {
  const out = linkifyHtml('~/Documents/notes.txt is mine');
  assert.match(out, /<a href="~\/Documents\/notes\.txt" class="auto-link">/);
});

test('linkifyHtml: file path with :LINE suffix preserved', () => {
  const out = linkifyHtml('see /src/foo.ts:42 there');
  assert.match(out, /<a href="\/src\/foo\.ts:42" class="auto-link">\/src\/foo\.ts:42<\/a>/);
});

test('linkifyHtml: folder ending with trailing slash', () => {
  const out = linkifyHtml('go to /Users/rockuen/Projects/ now');
  assert.match(
    out,
    /<a href="\/Users\/rockuen\/Projects\/" class="auto-link">\/Users\/rockuen\/Projects\/<\/a>/,
  );
});

test('linkifyHtml: tilde folder ~/Projects/', () => {
  const out = linkifyHtml('~/Projects/ holds all repos');
  assert.match(out, /<a href="~\/Projects\/" class="auto-link">/);
});

test('linkifyHtml: unknown extension is NOT autolinked', () => {
  // .qzx is not in LINKIFY_EXTENSIONS — left as plain text to avoid false
  // positives on arbitrary words containing dots.
  const out = linkifyHtml('see /Users/foo/weird.qzx here');
  assert.doesNotMatch(out, /<a /);
});

test('linkifyHtml: punctuation around path is excluded from href', () => {
  const out = linkifyHtml('open (/path/file.md) for context');
  // Closing `)` should land outside the anchor.
  assert.match(
    out,
    /\(<a href="\/path\/file\.md" class="auto-link">\/path\/file\.md<\/a>\)/,
  );
});

test('linkifyHtml: path inside <a> from marked stays a single anchor', () => {
  // Simulates marked output for `[file](/x/y.md)`.
  const html = '<a href="/x/y.md">file</a>';
  const out = linkifyHtml(html);
  assert.equal(countAnchors(out), 1);
  assert.equal(out, html);
});

test('linkifyHtml: multiple paths in same paragraph all wrap', () => {
  const out = linkifyHtml('compare /a.md and /b.md and /c.md');
  assert.equal(countAnchors(out), 3);
});

test('linkifyHtml: URL + file path + folder mixed, no overlap', () => {
  const out = linkifyHtml('see https://x.io , /a.md , /b/');
  assert.equal(countAnchors(out), 3);
  assert.match(out, /<a href="https:\/\/x\.io" class="auto-link">/);
  assert.match(out, /<a href="\/a\.md" class="auto-link">/);
  assert.match(out, /<a href="\/b\/" class="auto-link">/);
});

test('linkifyHtml: <script> region is protected', () => {
  const html = '<script>const url = "https://x.io"; const p = "/a.md";</script>';
  assert.equal(linkifyHtml(html), html);
});


test('LINKIFY_EXTENSIONS: covers common extensions used in Claude responses', () => {
  for (const ext of ['md', 'json', 'ts', 'tsx', 'py', 'sh', 'png', 'pdf', 'log']) {
    assert.ok(
      LINKIFY_EXTENSIONS.includes(ext),
      `extension "${ext}" should be in LINKIFY_EXTENSIONS`,
    );
  }
});

test('linkifyHtml: bare filename (README.md) is linkified', () => {
  const out = linkifyHtml('open README.md please');
  assert.match(out, /<a href="README\.md" class="auto-link">README\.md<\/a>/);
});

test('linkifyHtml: bare relative path src/foo.ts is linkified', () => {
  const out = linkifyHtml('check src/foo.ts now');
  assert.match(out, /<a href="src\/foo\.ts" class="auto-link">src\/foo\.ts<\/a>/);
});

test('linkifyHtml: bare filename inside inline <code>', () => {
  const out = linkifyHtml('see <code>README.md</code> there');
  assert.match(out, /<a href="README\.md" class="auto-link">/);
  assert.match(out, /<code>/);
});

test('linkifyHtml: bare filename + absolute path coexist (one anchor each)', () => {
  const out = linkifyHtml('compare /Users/foo/a.md and bar.md');
  assert.equal((out.match(/<a /g) || []).length, 2);
  assert.match(out, /<a href="\/Users\/foo\/a\.md"/);
  assert.match(out, /<a href="bar\.md"/);
});

test('linkifyHtml: bare unknown extension stays plain text', () => {
  // .qzx is not in LINKIFY_EXTENSIONS — bare regex must respect the same
  // extension list to avoid wrapping arbitrary tokens with dots.
  const out = linkifyHtml('weird.qzx file here');
  assert.doesNotMatch(out, /<a /);
});

test('linkifyHtml: bare filename with :LINE suffix preserves both', () => {
  const out = linkifyHtml('see foo.ts:42 there');
  assert.match(out, /<a href="foo\.ts:42" class="auto-link">foo\.ts:42<\/a>/);
});

test('linkifyHtml: arbitrary noise around path does not break wrapping', () => {
  const out = linkifyHtml('first /one.md, then /two.md! and finally /three.md.');
  assert.equal(countAnchors(out), 3);
  // Each trailing punctuation should sit OUTSIDE the anchor.
  assert.match(out, /<a href="\/one\.md" class="auto-link">\/one\.md<\/a>,/);
  assert.match(out, /<a href="\/two\.md" class="auto-link">\/two\.md<\/a>!/);
  assert.match(out, /<a href="\/three\.md" class="auto-link">\/three\.md<\/a>\./);
});
