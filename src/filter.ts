// Pure PR-selection logic: which open PRs need a (re-)review.

import type { PullRequest, State } from './types.js';
import { stateKey } from './state.js';

export type SkipReason = 'draft' | 'authored-by-reviewer' | 'already-reviewed';

export interface Selection {
  toReview: PullRequest[];
  skipped: Array<{ pr: PullRequest; reason: SkipReason }>;
}

/**
 * A PR is reviewed only if it is not a draft, not authored by the reviewer, and
 * its head SHA differs from the last-reviewed SHA (or was never reviewed).
 */
export function selectCandidates(
  repo: string,
  prs: PullRequest[],
  reviewer: string,
  state: State,
): Selection {
  const toReview: PullRequest[] = [];
  const skipped: Selection['skipped'] = [];
  for (const pr of prs) {
    if (pr.isDraft) {
      skipped.push({ pr, reason: 'draft' });
    } else if (pr.authorLogin === reviewer) {
      skipped.push({ pr, reason: 'authored-by-reviewer' });
    } else if (state[stateKey(repo, pr.number)] === pr.headSha) {
      skipped.push({ pr, reason: 'already-reviewed' });
    } else {
      toReview.push(pr);
    }
  }
  return { toReview, skipped };
}
