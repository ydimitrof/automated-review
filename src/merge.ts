// Reconcile the verdicts of independently-reviewed batches into one.
// Any REQUEST_CHANGES wins; otherwise any COMMENT; only all-APPROVE approves.

import type { Verdict } from './types.js';

export function mergeVerdicts(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (verdicts.includes('COMMENT')) return 'COMMENT';
  return 'APPROVE';
}

/**
 * The review event to actually post. GitHub forbids APPROVE/REQUEST_CHANGES on
 * your own PR, so those downgrade to COMMENT when the PR is self-authored.
 */
export function postEventFor(verdict: Verdict, isOwnPr: boolean): Verdict {
  return isOwnPr && verdict !== 'COMMENT' ? 'COMMENT' : verdict;
}
