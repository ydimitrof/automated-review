import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validLinesForPatch, validateComments, hasReviewAtSha } from '../src/github.js';
import type { ChangedFile, ReviewComment } from '../src/types.js';

// Files-API patch: starts at the first @@ hunk, no "+++" header.
const APP_PATCH = `@@ -1,4 +1,6 @@
 import x from 'x';
+import y from 'y';
+import z from 'z';
 const a = 1;
-const b = 2;
+const b = 3;
 export { a };`;

const NEW_PATCH = `@@ -0,0 +1,2 @@
+export const hello = 'world';
+export const n = 42;`;

const FILES: ChangedFile[] = [
  { filename: 'src/app.ts', status: 'modified', additions: 3, deletions: 1, patch: APP_PATCH },
  { filename: 'new.ts', status: 'added', additions: 2, deletions: 0, patch: NEW_PATCH },
  { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }, // binary, no patch
];

test('validLinesForPatch: RIGHT-side lines within hunks', () => {
  // new-side lines: 1 ctx, 2 +y, 3 +z, 4 ctx, 5 +b=3, 6 ctx
  assert.deepEqual([...validLinesForPatch(APP_PATCH)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...validLinesForPatch(NEW_PATCH)].sort((a, b) => a - b), [1, 2]);
});

test('validateComments: keeps in-diff, drops off-diff, unknown, and patchless files', () => {
  const comments: ReviewComment[] = [
    { path: 'src/app.ts', line: 2, body: 'ok added' },
    { path: 'src/app.ts', line: 99, body: 'off-diff' },
    { path: 'nope.ts', line: 1, body: 'unknown file' },
    { path: 'new.ts', line: 1, body: 'ok new file' },
    { path: 'logo.png', line: 1, body: 'binary file, no patch' },
  ];
  const { valid, dropped } = validateComments(FILES, comments);
  assert.deepEqual(valid.map((c) => `${c.path}:${c.line}`), ['src/app.ts:2', 'new.ts:1']);
  assert.equal(dropped.length, 3);
});

test('hasReviewAtSha: true only when the reviewer reviewed this exact SHA', () => {
  const reviews = [
    { login: 'someone', commitId: 'HEAD1' },
    { login: 'YdimitroF', commitId: 'OLD0' }, // reviewer, but older commit
  ];
  // reviewer reviewed only an older SHA -> not reviewed at head
  assert.equal(hasReviewAtSha(reviews, 'ydimitrof', 'HEAD1'), false);
  // add the reviewer's review at head (login case-insensitive)
  reviews.push({ login: 'ydimitrof', commitId: 'HEAD1' });
  assert.equal(hasReviewAtSha(reviews, 'ydimitrof', 'HEAD1'), true);
  // someone else's review at head doesn't count
  assert.equal(hasReviewAtSha([{ login: 'other', commitId: 'HEAD1' }], 'ydimitrof', 'HEAD1'), false);
});
