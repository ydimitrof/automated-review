// Pack changed files into review batches under a changed-line budget.
// Whole files are never split; a file larger than the budget gets its own batch.

import type { ChangedFile } from './types.js';

function changedLines(f: ChangedFile): number {
  return f.additions + f.deletions;
}

export function packBatches(files: ChangedFile[], batchLines: number): ChangedFile[][] {
  const budget = Math.max(1, batchLines);
  const batches: ChangedFile[][] = [];
  let current: ChangedFile[] = [];
  let currentLines = 0;

  for (const f of files) {
    const size = changedLines(f);
    if (current.length > 0 && currentLines + size > budget) {
      batches.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(f);
    currentLines += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
