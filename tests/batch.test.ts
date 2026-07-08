import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBatches } from '../src/batch.js';
import type { ChangedFile } from '../src/types.js';

function f(name: string, lines: number): ChangedFile {
  return { filename: name, status: 'modified', additions: lines, deletions: 0 };
}

test('packs whole files under the budget', () => {
  const files = [f('a', 400), f('b', 400), f('c', 400), f('d', 400)];
  const batches = packBatches(files, 1000);
  // a+b=800 <=1000; adding c=1200 >1000 -> new batch. c+d=800.
  assert.deepEqual(
    batches.map((b) => b.map((x) => x.filename)),
    [['a', 'b'], ['c', 'd']],
  );
});

test('a single oversized file gets its own batch', () => {
  const files = [f('small', 100), f('huge', 5000), f('tail', 100)];
  const batches = packBatches(files, 1000);
  assert.deepEqual(
    batches.map((b) => b.map((x) => x.filename)),
    [['small'], ['huge'], ['tail']],
  );
});

test('everything fits in one batch when under budget', () => {
  const files = [f('a', 100), f('b', 100)];
  assert.equal(packBatches(files, 1500).length, 1);
});
