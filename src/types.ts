// Shared types for the PR review bot.

export type Language = 'en' | 'bg' | 'both';

export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface RepoConfig {
  /** "owner/name" */
  repo: string;
  language: Language;
  /** Optional per-repo override; inline text or "file:./path". */
  reviewInstructions?: string;
}

export interface Config {
  /** GitHub login of the reviewer; must equal the gh-authenticated account. */
  reviewer: string;
  pollIntervalMinutes: number;
  /** Max concurrent agent (review/synthesis) calls across all PRs and batches. Default 4. */
  maxConcurrentReviews?: number;
  /** Changed-line budget per review batch. Default 1500. */
  batchLines?: number;
  /** Default review instructions; inline text or "file:./path". */
  reviewInstructions: string;
  repos: RepoConfig[];
  /** When true, print the review instead of posting it. CLI --dry-run also forces this. */
  demoMode?: boolean;
}

/** A repo config with its review instructions fully resolved to text. */
export interface ResolvedRepo extends RepoConfig {
  resolvedInstructions: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  authorLogin: string;
  headSha: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface Review {
  summary: string;
  verdict: Verdict;
  comments: ReviewComment[];
}

/** One changed file from the GitHub Files API. `patch` absent for binary/oversized files. */
export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** state.json maps `${repo}#${prNumber}` -> last-reviewed head SHA. */
export type State = Record<string, string>;
