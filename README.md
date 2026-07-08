# PR Review Bot

A standalone, long-running daemon that automatically reviews open GitHub pull
requests across one or more repositories. It discovers PRs that need review,
produces a real review (inline comments + a verdict) with the Claude Agent SDK,
and posts it via the authenticated `gh` CLI — no manual step.

- **Multi-repo**, each with its own review language and (optionally) its own
  review instructions.
- **Handles huge PRs** — fetches changed files via the GitHub Files API (no
  20,000-line diff cap), splits them into batches, reviews each batch, and
  synthesizes one coherent review.
- **Parallel** — batches across all PRs run concurrently under one global limit.
- **Safe by default** — ships in demo mode (prints, never posts) until you flip
  a toggle.
- **Live progress bars** on a TTY; clean plain logs when piped.

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
  - [Field reference](#field-reference)
  - [Example 1 — minimal single repo](#example-1--minimal-single-repo)
  - [Example 2 — multiple repos, per-repo language](#example-2--multiple-repos-per-repo-language)
  - [Example 3 — inline instructions](#example-3--inline-instructions)
  - [Example 4 — per-repo instructions override](#example-4--per-repo-instructions-override)
  - [Example 5 — tuning for cost and speed](#example-5--tuning-for-cost-and-speed)
- [Review instructions](#review-instructions)
- [Running](#running)
  - [npm scripts](#npm-scripts)
  - [CLI flags](#cli-flags)
  - [Example runs](#example-runs)
- [Output](#output)
- [State](#state)
- [Authentication & billing](#authentication--billing)
- [Deploying as a service](#deploying-as-a-service)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Testing](#testing)

---

## How it works

Each `pollIntervalMinutes` the bot runs one pass. For every configured repo:

1. **Poll** — lists open PRs (`gh pr list`).
2. **Filter** — a PR is reviewed only if it is **open**, **not a draft**, **not
   authored by the reviewer**, and its **head SHA changed** since the last review
   (tracked in `state.json`). Everything else is skipped.
   - As a second-line guard against re-reviewing, before reviewing a candidate
     the bot also asks GitHub whether the reviewer **already submitted a review
     for the current head SHA** (`GET /pulls/{n}/reviews`, matched on
     `commit_id`). If so it skips and records the SHA in `state.json`. This means
     a lost or fresh `state.json` won't cause duplicate reviews — only genuinely
     new commits trigger a re-review. (A targeted `--pr` run bypasses this, since
     it's an explicit request.)
3. **Fetch + batch** — pulls changed files via the GitHub Files API
   (`gh api repos/{repo}/pulls/{n}/files --paginate`, per-file patches, no
   whole-diff line cap), then packs whole files into batches of up to
   `batchLines` changed lines each.
4. **Review** — each batch is a separate agent call returning
   `{ summary, verdict, comments[] }`. A big PR fans out into many batches.
5. **Merge + synthesize** — inline comments are concatenated; the verdict is
   reconciled (any `REQUEST_CHANGES` wins, else `COMMENT`, else `APPROVE`); a
   final synthesis call folds the batch summaries into one overview in the repo's
   language.
6. **Post** — each inline comment is validated against its file's patch (off-diff
   comments dropped to avoid GitHub 422s), then one review is submitted.

GitHub I/O is deterministic (`gh`); the model only produces review content.
Every agent call — all batches of all PRs plus synthesis — shares a single global
concurrency limit (`maxConcurrentReviews`).

---

## Requirements

- **Node.js** 18+ (developed on Node 26). ESM project; run with `tsx` (bundled).
- **GitHub CLI** (`gh`) authenticated as the **reviewer** account:
  ```bash
  gh auth status
  gh api user --jq .login   # must equal config.reviewer
  ```
  Reviews are posted as whoever `gh` is logged in as.
- **Claude auth** for the Agent SDK — either your Claude Code login (subscription)
  or an `ANTHROPIC_API_KEY`. See [Authentication & billing](#authentication--billing).

---

## Install

```bash
npm install
cp config.example.json config.json      # then edit config.json
$EDITOR review-instructions.md          # put your review command text here
```

---

## Configuration

Config is a single `config.json` in the project root (override the path with
`--config`). `config.json`, `state.json`, and `review-instructions.md` are
git-ignored.

### Field reference

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `reviewer` | string | yes | — | GitHub login of the reviewer. **Must equal** the `gh`-authenticated account (`gh api user --jq .login`). Used to skip the reviewer's own PRs, and reviews post as this account. |
| `pollIntervalMinutes` | number | yes | — | Minutes between passes. Measured from the start of each pass. |
| `maxConcurrentReviews` | integer | no | `4` | Global cap on concurrent agent calls (batch reviews + synthesis) across **all** PRs and repos. Lower it if you hit Claude rate limits. |
| `batchLines` | integer | no | `1500` | Changed-line budget (additions + deletions) per review batch. Whole files are never split; a single file larger than this gets its own batch. |
| `demoMode` | boolean | no | `false` | When `true`, print the review instead of posting; `state.json` is left unchanged. `config.json` ships with this `true`. |
| `reviewInstructions` | string | yes | — | Default review prompt. Inline text, or `file:./path` to read from a file. |
| `repos` | array | yes (≥1) | — | Repositories to watch. See below. |
| `repos[].repo` | string | yes | — | `"owner/name"`. |
| `repos[].language` | `en` \| `bg` \| `both` | yes | — | Language of the posted review. **Case-insensitive** (`"EN"`, `"Both"` are fine). `both` = Bulgarian then English in each comment/summary. |
| `repos[].reviewInstructions` | string | no | top-level value | Per-repo override. Inline text or `file:./path`. |

> `file:` paths are resolved relative to the **config file's** directory.

### Example 1 — minimal single repo

```json
{
  "reviewer": "octocat",
  "pollIntervalMinutes": 15,
  "reviewInstructions": "file:./review-instructions.md",
  "repos": [
    { "repo": "acme/app", "language": "en" }
  ]
}
```

### Example 2 — multiple repos, per-repo language

```json
{
  "reviewer": "octocat",
  "pollIntervalMinutes": 10,
  "maxConcurrentReviews": 4,
  "batchLines": 1500,
  "reviewInstructions": "file:./review-instructions.md",
  "repos": [
    { "repo": "acme/app", "language": "both" },
    { "repo": "acme/backend",            "language": "en"   },
    { "repo": "acme/docs",               "language": "bg"   }
  ]
}
```

### Example 3 — inline instructions

No separate file — put the prompt directly in the config:

```json
{
  "reviewer": "octocat",
  "pollIntervalMinutes": 15,
  "reviewInstructions": "Review as a senior engineer. Flag correctness bugs, security issues, missing error handling, and resource leaks. Anchor concrete problems to the changed line. Keep the summary short. Use REQUEST_CHANGES only for real defects.",
  "repos": [
    { "repo": "acme/backend", "language": "en" }
  ]
}
```

### Example 4 — per-repo instructions override

A stricter rubric for one repo, the default for the rest:

```json
{
  "reviewer": "octocat",
  "pollIntervalMinutes": 15,
  "reviewInstructions": "file:./review-instructions.md",
  "repos": [
    {
      "repo": "acme/payments",
      "language": "en",
      "reviewInstructions": "file:./payments-review.md"
    },
    { "repo": "acme/frontend", "language": "en" }
  ]
}
```

### Example 5 — tuning for cost and speed

- **Fewer, larger batches** (cheaper, less parallel): raise `batchLines`.
- **More parallelism**: raise `maxConcurrentReviews`.
- **Gentler on rate limits**: lower `maxConcurrentReviews` — coverage is
  unchanged (everything is still reviewed), it just runs less in parallel.

```json
{
  "reviewer": "octocat",
  "pollIntervalMinutes": 30,
  "maxConcurrentReviews": 2,
  "batchLines": 2500,
  "demoMode": false,
  "reviewInstructions": "file:./review-instructions.md",
  "repos": [
    { "repo": "acme/app", "language": "both" }
  ]
}
```

---

## Review instructions

`reviewInstructions` is the prompt handed to the model for each batch. Keep it
focused on *what to look for* and *how to phrase findings* — the bot supplies the
diff, the language rule, and the "call `submit_review`" mechanics.

`review-instructions.md` ships with a sensible default. Replace it with your own
review command text. Example:

```markdown
Review this pull request as an experienced engineer. Focus on:

- Correctness bugs, logic errors, and unhandled edge cases.
- Security issues (injection, auth, secrets, unsafe input handling).
- Error handling and resource cleanup on all paths.
- Readability and adherence to the surrounding code's conventions.

Anchor concrete problems to the exact changed line as inline comments. Keep the
summary short. Choose REQUEST_CHANGES only for real defects; otherwise COMMENT,
or APPROVE when the change is clean.
```

---

## Running

### npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm run demo` | `tsx bot.ts --dry-run --once` | One pass, print reviews, post nothing. Best first run. |
| `npm run pr:demo -- <n>` | `tsx bot.ts --dry-run --pr <n>` | Review one PR, print it, post nothing. |
| `npm run pr -- <n>` | `tsx bot.ts --pr <n>` | Review one PR and post it. |
| `npm run dry-run` | `tsx bot.ts --dry-run` | Daemon that prints reviews but never posts. |
| `npm run once` | `tsx bot.ts --once` | One real pass, then exit (posts unless `demoMode`). |
| `npm start` | `tsx bot.ts` | Daemon: poll → review → post → sleep → repeat. |
| `npm test` | `tsx --test tests/*.test.ts` | Unit tests. |

### CLI flags

| Flag | Effect |
|---|---|
| `--config <path>` | Use a config file other than `./config.json`. |
| `--dry-run` | Print the review instead of posting; leave state unchanged. Same effect as `demoMode: true`. |
| `--once` | Run a single pass and exit instead of looping. |
| `--pr <number>` | Review one specific PR, then exit. Bypasses the poll/filter loop — the PR is reviewed even if it's a draft, self-authored, or unchanged. |
| `--repo <owner/name>` | Which configured repo the `--pr` belongs to. Optional when only one repo is configured; required with multiple. |

`--dry-run` and `demoMode: true` are equivalent; either one suppresses posting.

The target of `--pr` must be a repo present in your config (so its `language` and
review instructions apply). It respects `demoMode`/`--dry-run`, and on a real run
it posts and records state exactly like a normal review.

### Example runs

```bash
# Safe first look — see exactly what it would post, nothing changes.
npm run demo

# Review one specific PR and print the result (single configured repo).
npm run pr:demo -- 17

# Review one PR and actually post it.
npm run pr -- 17

# Multiple repos configured — name the repo (args after -- are passed through).
npm run pr:demo -- 42 --repo acme/backend

# Same, against a different config file.
npx tsx bot.ts --dry-run --once --config ./configs/staging.json

# One real pass (posts reviews), then exit — good for cron/launchd.
npm run once

# Run the daemon for real.
npm start

# Daemon, but never post (a permanent dry-run monitor).
npm run dry-run

# Disable colored output / progress bars.
NO_COLOR=1 npm start

# Bill the API instead of your Claude Code subscription.
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Stop the daemon with `Ctrl-C` (`SIGINT`) — it finishes in-flight PRs, saves
state, clears the progress region, and exits.

---

## Output

**Log lines** are timestamped (ISO 8601 UTC) and color-coded by level:

```
2026-07-08T08:36:52.434Z [INFO] started — reviewer=octocat, repos=acme/app, interval=15m, batchLines=1500, maxConcurrent=4, demoMode=true
2026-07-08T08:36:53.433Z [INFO] skip acme/app#64: authored-by-reviewer
2026-07-08T08:36:53.433Z [INFO] skip acme/app#61: draft
2026-07-08T08:36:53.433Z [INFO] acme/app: 6 open PR(s), 4 to review
2026-07-08T08:36:53.433Z [INFO] acme/app#17: 224 file(s) in 19 batch(es)
```

**Progress bars** (TTY only) — one live bar per in-flight review, log lines
scrolling above:

```
2026-07-08T08:37:10.101Z [INFO] acme/app#66: posted COMMENT with 2 inline comment(s)
⠹ acme/app#17 [█████░░░░░░░░░░░] 6/20 41s
⠧ acme/app#68 [███████████░░░░░] 12/17 39s
```

Each bar ticks once per batch plus one for the synthesis step, then flashes
`✓ …[████████████████] 20/20` on completion.

Between passes, the wait is shown as a live countdown that ticks down in place:

```
⏳ next pass in 14:59 [████████████████████]
```

**Demo review block** (`demoMode`/`--dry-run`) — the exact review that would be
posted:

```
════════════════════════════════════════════════════════════
DEMO — would post to acme/app#66: voice input lane
URL: https://github.com/acme/app/pull/66
Verdict: COMMENT
── Summary ──
<synthesized bilingual/target-language summary>
── Inline comments (2) ──
  apps/web/app/lib/assistant-dock/useTurnstileGate.ts:67
    <comment text>
════════════════════════════════════════════════════════════
```

Color is auto-disabled when `stdout` is not a TTY (piped to a file) or when
`NO_COLOR` is set; `FORCE_COLOR=1` forces it on. Progress bars are suppressed off
a TTY, leaving plain per-batch log lines.

---

## State

`state.json` maps `owner/name#<pr>` to the last-reviewed head SHA:

```json
{
  "acme/app#66": "a1b2c3d4e5f6...",
  "acme/backend#42": "9f8e7d6c5b4a..."
}
```

A PR is re-reviewed when its head SHA changes (i.e. new commits). To **force a
re-review**, delete that entry (or the whole file) **and** use a targeted
`--pr` run — deleting state alone won't cause a re-review if a review by the
reviewer already exists on GitHub at the current SHA (the bot re-checks GitHub
and re-caches the SHA). In `demoMode`, state is never written. Writes are atomic
(temp file + rename) and safe under the concurrent pass.

---

## Authentication & billing

The Agent SDK resolves auth in this order:

1. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (pay-per-token API billing), else
2. your **Claude Code** login / OAuth credentials (counts against your Pro/Max
   subscription usage — no separate API bill).

On a machine where you're logged into Claude Code and no API key is set, reviews
use your subscription. For a headless server, set `ANTHROPIC_API_KEY` in the
bot's environment. GitHub reviews always post as the `gh`-authenticated account,
independent of Claude auth.

> "Review everything" is intentional: a large PR runs one agent call per batch
> plus one synthesis call. A 25k-line PR ≈ ~17 batches + 1 synthesis. Throttle
> with `maxConcurrentReviews`, not by dropping coverage.

---

## Deploying as a service

The daemon inherits auth from its environment, so give the service either a
`gh`-authenticated home or a token, plus `ANTHROPIC_API_KEY` if not using a
subscription login.

**launchd (macOS)** — run one pass every 15 min via `--once`:

```xml
<!-- ~/Library/LaunchAgents/com.pr-review-bot.plist -->
<dict>
  <key>Label</key><string>com.pr-review-bot</string>
  <key>WorkingDirectory</key><string>/Users/you/IdeaProjects/agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npm</string><string>run</string><string>once</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/pr-bot.log</string>
  <key>StandardErrorPath</key><string>/tmp/pr-bot.err</string>
  <key>EnvironmentVariables</key>
  <dict><key>ANTHROPIC_API_KEY</key><string>sk-ant-...</string></dict>
</dict>
```

**systemd (Linux)** — long-running daemon:

```ini
# /etc/systemd/system/pr-review-bot.service
[Service]
WorkingDirectory=/opt/agent
ExecStart=/usr/bin/npm start
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=NO_COLOR=1
Restart=always
[Install]
WantedBy=multi-user.target
```

**pm2**: `pm2 start npm --name pr-bot -- start`.

Piped/service logs are plain text (no color, no progress bars) automatically.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `config.reviewer is "X" but gh is authenticated as "Y"` (warning) | Reviews would post as `Y`. Set `reviewer` to the `gh` account, or re-auth `gh` as the intended reviewer. |
| Nothing gets reviewed | All PRs are drafts, self-authored, or unchanged since last review. Check the `skip …` log lines; delete `state.json` to force. |
| `HTTP 406 … diff exceeded 20000 lines` | Already handled — the bot uses the Files API, not `gh pr diff`. If you see this, you're on an old build. |
| `agent did not submit a review` | The model didn't call `submit_review` for a batch. That batch is skipped and retried next pass; state is untouched. |
| `dropped N off-diff inline comment(s)` | The model anchored comments to lines not in the diff; they're dropped so the post doesn't 422. Informational. |
| Rate-limit / throttling errors | Lower `maxConcurrentReviews` (and/or raise `pollIntervalMinutes`). Coverage is unchanged. |
| Binary/oversized single files | Shown in the prompt but can't carry inline comments; they still count toward the review. |

---

## Project layout

```
bot.ts                 Daemon: poll → filter → fetch → batch → review → merge → post; loop + signals.
src/
  config.ts            Load/validate config.json (zod); resolve file: instructions; normalize language.
  types.ts             Shared types (Config, PullRequest, ChangedFile, Review, …).
  github.ts            gh wrappers (listOpenPRs, getChangedFiles, postReview) + per-file patch parsing.
  filter.ts            selectCandidates — the open/not-draft/not-self/changed-SHA rule.
  batch.ts             packBatches — pack whole files under the changed-line budget.
  reviewer.ts          reviewBatch + synthesizeSummary via the Claude Agent SDK.
  merge.ts             mergeVerdicts — reconcile per-batch verdicts.
  pool.ts              Semaphore — global concurrency cap for agent calls.
  progress.ts          ProgressManager — live multi-bar TTY region.
  state.ts             Atomic state.json read/write.
  logger.ts            Timestamped, colored logging with an optional sink.
tests/                 Unit tests (filter, patch validation, batching, merge, semaphore, progress).
config.example.json    Documented sample config.
review-instructions.md Your review prompt.
```

---

## Testing

```bash
npm test
```

Covers PR filtering, per-file patch anchoring, batch packing, verdict merging,
the concurrency semaphore, and progress-bar formatting. GitHub and the model are
not called in the unit tests.
