import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from '../src/filter.js';
import { stateKey } from '../src/state.js';
import type { PullRequest, State } from '../src/types.js';

function pr(overrides: Partial<PullRequest>): PullRequest {
  return {
    number: 1,
    title: 't',
    url: 'u',
    isDraft: false,
    authorLogin: 'someone',
    headSha: 'aaa',
    ...overrides,
  };
}

const REPO = 'owner/name';
const REVIEWER = 'me';

test('drops drafts, self-authored, and unchanged-SHA; keeps changed/new', () => {
  const state: State = {
    [stateKey(REPO, 4)]: 'sha-old', // PR 4 last reviewed at sha-old
    [stateKey(REPO, 5)]: 'sha-same', // PR 5 already reviewed at current sha
  };
  const prs = [
    pr({ number: 1, isDraft: true }), // draft -> skip
    pr({ number: 2, authorLogin: REVIEWER }), // self -> skip
    pr({ number: 3, headSha: 'brand-new' }), // never reviewed -> review
    pr({ number: 4, headSha: 'sha-new' }), // changed since last review -> review
    pr({ number: 5, headSha: 'sha-same' }), // unchanged -> skip
  ];

  const { toReview, skipped } = selectCandidates(REPO, prs, REVIEWER, state);

  assert.deepEqual(toReview.map((p) => p.number).sort(), [3, 4]);
  const reasons = Object.fromEntries(skipped.map((s) => [s.pr.number, s.reason]));
  assert.deepEqual(reasons, { 1: 'draft', 2: 'authored-by-reviewer', 5: 'already-reviewed' });
});
