import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NO_COLOR = '1'; // assert on plain text, not ANSI codes

const { formatBarLine } = await import('../src/progress.js');

test('formatBarLine renders gauge, counts, spinner and elapsed', () => {
  const bar = { label: 'owner/repo#7', total: 4, done: 1, startMs: 1000, finished: false };
  const line = formatBarLine(process.stdout, bar, 0, 6000);
  // done/total = 1/4 -> filled = round(16*0.25) = 4
  assert.match(line, /\[████░{12}\]/);
  assert.match(line, /1\/4/);
  assert.match(line, /owner\/repo#7/);
  assert.match(line, /5s/); // (6000-1000)/1000
  assert.match(line, /^⠋ /); // spinner frame 0, running
});

test('finished bar shows a check and full gauge', () => {
  const bar = { label: 'r#1', total: 2, done: 2, startMs: 0, finished: true };
  const line = formatBarLine(process.stdout, bar, 3, 2000);
  assert.match(line, /^✓ /);
  assert.match(line, /\[█{16}\]/);
  assert.match(line, /2\/2/);
});
