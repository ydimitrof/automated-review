// PR review bot — long-running daemon.
// Usage: tsx bot.ts [--config ./config.json] [--dry-run] [--once]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig, type LoadedConfig } from './src/config.js';
import { loadState, saveState, stateKey } from './src/state.js';
import {
  listOpenPRs,
  getPr,
  getChangedFiles,
  postReview,
  validateComments,
  fetchReviews,
  hasReviewAtSha,
} from './src/github.js';
import { selectCandidates } from './src/filter.js';
import { packBatches } from './src/batch.js';
import { mergeVerdicts, postEventFor } from './src/merge.js';
import { Semaphore } from './src/pool.js';
import { reviewBatch, synthesizeSummary } from './src/reviewer.js';
import { ProgressManager } from './src/progress.js';
import { log, paint, setLogSink } from './src/logger.js';
import type { PullRequest, Review, ReviewComment, ResolvedRepo, State } from './src/types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BATCH_LINES = 1500;

interface Args {
  configPath: string;
  dryRun: boolean;
  once: boolean;
  pr?: number;
  repo?: string;
}

function parseArgs(argv: string[]): Args {
  let configPath = 'config.json';
  let dryRun = false;
  let once = false;
  let pr: number | undefined;
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') configPath = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--once') once = true;
    else if (a === '--pr') pr = parseInt(argv[++i], 10);
    else if (a === '--repo') repo = argv[++i];
  }
  if (pr !== undefined && !Number.isInteger(pr)) {
    throw new Error('--pr requires an integer PR number');
  }
  return { configPath: resolve(configPath), dryRun, once, pr, repo };
}

/** Resolve which configured repo a targeted `--pr` run applies to. */
function resolveTargetRepo(cfg: LoadedConfig, repo: string | undefined): ResolvedRepo {
  if (repo) {
    const match = cfg.resolvedRepos.find((r) => r.repo === repo);
    if (!match) {
      throw new Error(`--repo ${repo} is not in config (have: ${cfg.resolvedRepos.map((r) => r.repo).join(', ')})`);
    }
    return match;
  }
  if (cfg.resolvedRepos.length === 1) return cfg.resolvedRepos[0];
  throw new Error(
    `multiple repos configured — specify --repo owner/name (one of: ${cfg.resolvedRepos.map((r) => r.repo).join(', ')})`,
  );
}

let shuttingDown = false;
let wakeFromSleep: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(() => {
      wakeFromSleep = null;
      res();
    }, ms);
    wakeFromSleep = () => {
      clearTimeout(t);
      wakeFromSleep = null;
      res();
    };
  });
}

function printDemoReview(
  progress: ProgressManager,
  repo: string,
  pr: PullRequest,
  review: Review,
  comments: ReviewComment[],
): void {
  const out = process.stdout;
  const rule = paint(out, 'dim', '════════════════════════════════════════════════════════════');
  const verdictColor = review.verdict === 'APPROVE' ? 'green' : review.verdict === 'REQUEST_CHANGES' ? 'red' : 'yellow';
  const lines: string[] = [];
  lines.push('');
  lines.push(rule);
  lines.push(paint(out, 'cyan', paint(out, 'bold', `DEMO — would post to ${repo}#${pr.number}: ${pr.title}`)));
  lines.push(paint(out, 'dim', `URL: ${pr.url}`));
  lines.push(`Verdict: ${paint(out, verdictColor, review.verdict)}`);
  lines.push(paint(out, 'cyan', '── Summary ──'));
  lines.push(review.summary);
  if (comments.length > 0) {
    lines.push(paint(out, 'cyan', `── Inline comments (${comments.length}) ──`));
    for (const c of comments) {
      lines.push(`  ${paint(out, 'bold', `${c.path}:${c.line}`)}`);
      for (const l of c.body.split('\n')) lines.push(`    ${l}`);
    }
  } else {
    lines.push(paint(out, 'dim', '── No inline comments ──'));
  }
  lines.push(rule);
  progress.print(lines.join('\n'));
}

async function reviewPr(
  cfg: LoadedConfig,
  sem: Semaphore,
  progress: ProgressManager,
  repoCfg: ResolvedRepo,
  pr: PullRequest,
  demoMode: boolean,
  state: State,
  statePath: string,
): Promise<void> {
  const key = stateKey(repoCfg.repo, pr.number);
  log.info(`reviewing ${key} (${pr.headSha.slice(0, 7)}): ${pr.title}`);

  const files = await getChangedFiles(repoCfg.repo, pr.number);
  if (files.length === 0) {
    log.warn(`${key}: no changed files, skipping`);
    return;
  }

  const batches = packBatches(files, cfg.batchLines ?? DEFAULT_BATCH_LINES);
  log.info(`${key}: ${files.length} file(s) in ${batches.length} batch(es)`);

  // total ticks: one per batch review + one for the synthesis/merge step.
  progress.start(key, `${repoCfg.repo}#${pr.number}`, batches.length + 1);
  try {
    // Review batches in parallel; each agent call is gated by the global semaphore.
    const results = await Promise.all(
      batches.map((batchFiles, i) =>
        sem
          .run(() =>
            reviewBatch({
              instructions: repoCfg.resolvedInstructions,
              language: repoCfg.language,
              prTitle: pr.title,
              files: batchFiles,
              batchIndex: i,
              batchCount: batches.length,
            }),
          )
          .catch((err) => {
            log.error(`${key}: batch ${i + 1}/${batches.length} failed`, err);
            return null;
          })
          .finally(() => progress.tick(key)),
      ),
    );

    const ok = results.filter((r): r is Review => r !== null);
    if (ok.length === 0) {
      log.error(`${key}: all ${batches.length} batch(es) failed; will retry next pass`);
      return;
    }
    if (ok.length < batches.length) {
      log.warn(`${key}: ${batches.length - ok.length} batch(es) failed; merging the rest`);
    }

    const allComments = ok.flatMap((r) => r.comments);
    const verdict = mergeVerdicts(ok.map((r) => r.verdict));
    const summary = await sem
      .run(() =>
        synthesizeSummary({ language: repoCfg.language, prTitle: pr.title, summaries: ok.map((r) => r.summary) }),
      )
      .catch((err) => {
        log.error(`${key}: synthesis failed, concatenating summaries`, err);
        return ok.map((r, i) => `Batch ${i + 1}:\n${r.summary}`).join('\n\n');
      });
    progress.tick(key); // synthesis step complete

    const { valid, dropped } = validateComments(files, allComments);
    if (dropped.length > 0) {
      log.warn(`${key}: dropped ${dropped.length} off-diff inline comment(s)`);
    }

    // GitHub forbids APPROVE/REQUEST_CHANGES on your own PR — only COMMENT is
    // allowed. Self-authored PRs are normally filtered out, but a targeted
    // `--pr` run can reach one, so downgrade the event to COMMENT.
    const postEvent = postEventFor(verdict, pr.authorLogin === cfg.reviewer);
    if (postEvent !== verdict) {
      log.warn(`${key}: cannot ${verdict} your own PR — posting as COMMENT`);
    }

    const merged: Review = { summary, verdict: postEvent, comments: valid };
    if (demoMode) {
      printDemoReview(progress, repoCfg.repo, pr, merged, valid);
      log.info(`${key}: demo mode — not posted, state unchanged`);
      return;
    }

    await postReview(repoCfg.repo, pr.number, { summary, verdict: postEvent }, valid);
    state[key] = pr.headSha;
    await saveState(statePath, state);
    log.info(`${key}: posted ${postEvent} with ${valid.length} inline comment(s)`);
  } finally {
    progress.finish(key);
  }
}

async function runPass(
  cfg: LoadedConfig,
  sem: Semaphore,
  progress: ProgressManager,
  demoMode: boolean,
  state: State,
  statePath: string,
): Promise<void> {
  // Phase 1: list + filter each repo (cheap, sequential).
  const candidates: Array<{ repoCfg: ResolvedRepo; pr: PullRequest }> = [];
  let stateDirty = false;
  for (const repoCfg of cfg.resolvedRepos) {
    if (shuttingDown) return;
    try {
      const prs = await listOpenPRs(repoCfg.repo);
      const { toReview, skipped } = selectCandidates(repoCfg.repo, prs, cfg.reviewer, state);
      for (const s of skipped) {
        if (s.reason !== 'already-reviewed') {
          log.info(`skip ${stateKey(repoCfg.repo, s.pr.number)}: ${s.reason}`);
        }
      }
      // Second-line defence against re-reviewing: even if state.json has no
      // record (e.g. lost/fresh), skip a PR the reviewer already reviewed at
      // this exact head SHA on GitHub, and cache that into state.
      for (const pr of toReview) {
        if (shuttingDown) return;
        const key = stateKey(repoCfg.repo, pr.number);
        try {
          const reviews = await fetchReviews(repoCfg.repo, pr.number);
          if (hasReviewAtSha(reviews, cfg.reviewer, pr.headSha)) {
            log.info(`skip ${key}: already reviewed at ${pr.headSha.slice(0, 7)} on GitHub`);
            if (!demoMode && state[key] !== pr.headSha) {
              state[key] = pr.headSha;
              stateDirty = true;
            }
            continue;
          }
        } catch (err) {
          log.warn(`${key}: could not check existing GitHub reviews; proceeding to review`);
        }
        candidates.push({ repoCfg, pr });
      }
      log.info(`${repoCfg.repo}: ${prs.length} open PR(s), ${candidates.filter((c) => c.repoCfg === repoCfg).length} to review`);
    } catch (err) {
      log.error(`${repoCfg.repo}: could not list/process PRs`, err);
    }
  }

  if (stateDirty) await saveState(statePath, state);
  if (candidates.length === 0 || shuttingDown) return;

  // Phase 2: process PRs concurrently; all agent calls share the global semaphore.
  log.info(
    `reviewing ${candidates.length} PR(s), up to ${cfg.maxConcurrentReviews ?? DEFAULT_CONCURRENCY} concurrent agent call(s)`,
  );
  await Promise.all(
    candidates.map(({ repoCfg, pr }) =>
      reviewPr(cfg, sem, progress, repoCfg, pr, demoMode, state, statePath).catch((err) =>
        log.error(`${stateKey(repoCfg.repo, pr.number)}: review failed`, err),
      ),
    ),
  );
}

async function checkReviewerIdentity(reviewer: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    const account = stdout.trim();
    if (account && account !== reviewer) {
      log.warn(
        `config.reviewer is "${reviewer}" but gh is authenticated as "${account}" — reviews will post as "${account}"`,
      );
    }
  } catch (err) {
    log.warn(`could not verify gh authenticated account: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig(args.configPath);
  const demoMode = Boolean(cfg.demoMode) || args.dryRun;
  const statePath = resolve('state.json');
  const state = await loadState(statePath);
  const sem = new Semaphore(cfg.maxConcurrentReviews ?? DEFAULT_CONCURRENCY);
  const progress = new ProgressManager();
  if (progress.enabled) setLogSink((line) => progress.print(line));

  const onSignal = (sig: string) => {
    log.info(`shutdown requested (${sig}) — finishing in-flight PRs`);
    shuttingDown = true;
    if (wakeFromSleep) wakeFromSleep();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // Targeted run: review one PR by number, bypassing the poll/filter loop.
  if (args.pr !== undefined) {
    const repoCfg = resolveTargetRepo(cfg, args.repo);
    log.info(`targeted run — ${repoCfg.repo}#${args.pr} (filters bypassed, demoMode=${demoMode})`);
    if (!demoMode) await checkReviewerIdentity(cfg.reviewer);
    try {
      const pr = await getPr(repoCfg.repo, args.pr);
      await reviewPr(cfg, sem, progress, repoCfg, pr, demoMode, state, statePath);
    } catch (err) {
      log.error(`${repoCfg.repo}#${args.pr}: review failed`, err);
    }
    progress.stop();
    log.info('exiting');
    return;
  }

  log.info(
    `started — reviewer=${cfg.reviewer}, repos=${cfg.resolvedRepos.map((r) => r.repo).join(',')}, ` +
      `interval=${cfg.pollIntervalMinutes}m, batchLines=${cfg.batchLines ?? DEFAULT_BATCH_LINES}, ` +
      `maxConcurrent=${cfg.maxConcurrentReviews ?? DEFAULT_CONCURRENCY}, demoMode=${demoMode}`,
  );
  await checkReviewerIdentity(cfg.reviewer);

  const intervalMs = cfg.pollIntervalMinutes * 60_000;
  do {
    const startedAt = Date.now();
    await runPass(cfg, sem, progress, demoMode, state, statePath);
    if (args.once || shuttingDown) break;
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, intervalMs - elapsed);
    log.info(`pass complete — sleeping ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  } while (!shuttingDown);

  progress.stop();
  log.info('exiting');
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
