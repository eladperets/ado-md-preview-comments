const test = require('node:test');
const assert = require('node:assert');
const { normalize, stripMarkdown, sourceText, mapLines, blockForLine, matchTreeRow } = require('../anchor.js');

test('stripMarkdown removes block and inline syntax', () => {
  assert.strictEqual(stripMarkdown('## Title'), 'Title');
  assert.strictEqual(stripMarkdown('> - [x] see [the docs](http://x/y)'), 'see the docs');
  assert.strictEqual(stripMarkdown('1. a <b>bold</b> item'), 'a bold item');
  assert.strictEqual(stripMarkdown('|---|:--:|'), '');
});

const source = [
  '# Overview',                       // 1
  '',                                 // 2
  'This is **important** text that',  // 3
  'wraps to a second line.',          // 4
  '',                                 // 5
  '- parent item',                    // 6
  '  - child `item`',                 // 7
  '',                                 // 8
  '```json',                          // 9
  '{ "effect": "deny" }',             // 10
  '```',                              // 11
  '',                                 // 12
  '| Name | Value |',                  // 13
  '|------|-------|',                 // 14
  '| foo  | bar   |',                 // 15
  '',                                 // 16
  '## Second sample with long title', // 17
  '',                                 // 18
  '```json',                          // 19
  '{ "effect": "deny" }',             // 20
  '```',                              // 21
].join('\n');

// Own text per block: nested blocks' text is not included in the parent.
const blocks = [
  'Overview',                                               // 0 h1
  'This is important text that\nwraps to a second line.',  // 1 p
  'parent item',                                            // 2 li
  'child item',                                             // 3 li (nested)
  '{ "effect": "deny" }\n',                                 // 4 pre
  'NameValue',                                              // 5 tr
  'foobar',                                                 // 6 tr
  'Second sample with long title',                          // 7 h2
  '{ "effect": "deny" }\n',                                 // 8 pre
];

test('mapLines anchors lines to rendered blocks in document order', () => {
  const map = mapLines(source, blocks);
  assert.strictEqual(map[0], 0);
  assert.strictEqual(map[3], 1, 'wrapped paragraph line');
  assert.strictEqual(map[5], 2, 'parent list item');
  assert.strictEqual(map[6], 3, 'nested list item');
  assert.strictEqual(map[9], 4, 'fenced code kept raw');
  assert.strictEqual(map[14], 6, 'table row');
  assert.strictEqual(map[19], 8, 'repeated code resolves to the block after the previous match');
});

test('blockForLine falls back to nearby lines and returns -1 out of range', () => {
  const map = mapLines(source, blocks);
  assert.strictEqual(blockForLine(map, 2), 0, 'blank line uses previous line');
  assert.strictEqual(blockForLine(map, 100), -1);
  assert.strictEqual(blockForLine(mapLines(source, ['unrelated']), 1), -1);
});

test('sourceText contains rendered paragraph text across wrapped lines', () => {
  const text = sourceText(source);
  assert.ok(text.includes(normalize('This is important text that wraps to a second line.')));
  assert.ok(!text.includes(normalize('not in the file')));
});

test('matchTreeRow matches the whole comment, not a short prefix of another one', () => {
  const long = 'This comment is long enough that ADO may truncate it in the tree row text';
  const comments = ['nit', 'nit: ADO cannot render these bullet points', long];
  assert.strictEqual(matchTreeRow('nit: ADO cannot render these bullet points1', comments), 1, 'reply count after text');
  assert.strictEqual(matchTreeRow('nit', comments), 0);
  assert.strictEqual(matchTreeRow(long.slice(0, 50), comments), 2, 'unique truncated long comment');
  assert.strictEqual(matchTreeRow('nit: something else', comments), -1);
  assert.strictEqual(matchTreeRow(long.slice(0, 50), [long, `${long} again`]), -1, 'ambiguous prefix');
});
