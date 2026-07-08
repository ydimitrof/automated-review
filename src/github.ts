// GitHub I/O via the authenticated `gh` CLI, plus per-file patch parsing.

import { spawn } from 'node:child_process';
import type { ChangedFile, PullRequest, ReviewComment, Verdict } from './types.js';

interface GhPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: { login: string } | null;
  headRefOid: string;
}

/**
 * Run `gh`, optionally writing `input` to its stdin (for `--input -`). Uses
 * spawn rather than execFile because execFile silently ignores an `input`
 * option, which would send an empty body. On non-zero exit the rejection
 * includes gh's stderr (e.g. the GitHub API error message).
 */
function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`gh ${args.join(' ')} exited ${code}: ${(stderr || stdout).trim()}`));
      }
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

export async function listOpenPRs(repo: string): Promise<PullRequest[]> {
  const out = await gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,isDraft,author,headRefOid,title,url',
  ]);
  const rows = JSON.parse(out) as GhPr[];
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    url: r.url,
    isDraft: r.isDraft,
    authorLogin: r.author?.login ?? '',
    headSha: r.headRefOid,
  }));
}

export interface GhReview {
  login: string;
  commitId: string | null;
}

/** True if `reviewer` already submitted a review for exactly `headSha`. */
export function hasReviewAtSha(reviews: GhReview[], reviewer: string, headSha: string): boolean {
  const who = reviewer.toLowerCase();
  return reviews.some((r) => r.login.toLowerCase() === who && r.commitId === headSha);
}

/** Fetch a PR's submitted reviews (login + the commit each review was for). */
export async function fetchReviews(repo: string, prNumber: number): Promise<GhReview[]> {
  const out = await gh([
    'api',
    `repos/${repo}/pulls/${prNumber}/reviews`,
    '--paginate',
    '--jq',
    '.[] | {login: .user.login, commitId: .commit_id}',
  ]);
  const reviews: GhReview[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as { login: string | null; commitId: string | null };
    reviews.push({ login: o.login ?? '', commitId: o.commitId ?? null });
  }
  return reviews;
}

/** Fetch a single PR's metadata (for targeted `--pr` runs). */
export async function getPr(repo: string, prNumber: number): Promise<PullRequest> {
  const out = await gh([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'number,isDraft,author,headRefOid,title,url',
  ]);
  const r = JSON.parse(out) as GhPr;
  return {
    number: r.number,
    title: r.title,
    url: r.url,
    isDraft: r.isDraft,
    authorLogin: r.author?.login ?? '',
    headSha: r.headRefOid,
  };
}

/**
 * Fetch changed files via the Files API (paginated, per-file patches). Avoids
 * the 20k-line whole-diff cap that `gh pr diff` hits on large PRs.
 */
export async function getChangedFiles(repo: string, prNumber: number): Promise<ChangedFile[]> {
  const out = await gh([
    'api',
    `repos/${repo}/pulls/${prNumber}/files`,
    '--paginate',
    '--jq',
    '.[] | {filename, status, additions, deletions, patch}',
  ]);
  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as ChangedFile & { patch: string | null };
    files.push({
      filename: o.filename,
      status: o.status,
      additions: o.additions,
      deletions: o.deletions,
      patch: o.patch ?? undefined,
    });
  }
  return files;
}

/**
 * The set of RIGHT-side (new-file) line numbers a single-file patch touches.
 * Only these lines can carry inline review comments. The Files API `patch`
 * field starts at the first `@@` hunk (no `+++` header).
 */
export function validLinesForPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw.split('@@')[1] ?? '');
      newLine = m ? parseInt(m[1], 10) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      lines.add(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      // deletion: no RIGHT-side line consumed
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — ignore
    } else if (raw.startsWith(' ')) {
      lines.add(newLine);
      newLine++;
    } else {
      inHunk = false;
    }
  }
  return lines;
}

export function buildValidLines(files: ChangedFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.patch) map.set(f.filename, validLinesForPatch(f.patch));
  }
  return map;
}

export interface ValidatedComments {
  valid: ReviewComment[];
  dropped: ReviewComment[];
}

export function validateComments(files: ChangedFile[], comments: ReviewComment[]): ValidatedComments {
  const validLines = buildValidLines(files);
  const valid: ReviewComment[] = [];
  const dropped: ReviewComment[] = [];
  for (const c of comments) {
    if (validLines.get(c.path)?.has(c.line)) {
      valid.push(c);
    } else {
      dropped.push(c);
    }
  }
  return { valid, dropped };
}

/**
 * Post exactly one PR review. `comments` must already be validated. With no
 * valid inline comments the review is body-only.
 */
export async function postReview(
  repo: string,
  prNumber: number,
  review: { summary: string; verdict: Verdict },
  comments: ReviewComment[],
): Promise<void> {
  const payload: Record<string, unknown> = {
    body: review.summary,
    event: review.verdict,
  };
  if (comments.length > 0) {
    payload.comments = comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body,
    }));
  }
  await gh(
    ['api', '--method', 'POST', `repos/${repo}/pulls/${prNumber}/reviews`, '--input', '-'],
    JSON.stringify(payload),
  );
}
