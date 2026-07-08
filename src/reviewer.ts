// Produce structured PR reviews via the Claude Agent SDK.
// A large PR is split into batches; each batch is reviewed independently and a
// final synthesis pass merges the batch summaries into one coherent overview.

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ChangedFile, Language, Review, ReviewComment, Verdict } from './types.js';

function languageDirective(language: Language): string {
  switch (language) {
    case 'en':
      return 'Write ALL review text (summary and every comment) in English.';
    case 'bg':
      return 'Write ALL review text (summary and every comment) in Bulgarian.';
    case 'both':
      return 'Write ALL review text (summary and every comment) in BOTH Bulgarian and English — Bulgarian first, then English, separated by a blank line.';
  }
}

function renderFiles(files: ChangedFile[]): string {
  return files
    .map((f) => {
      const header = `### FILE: ${f.filename}  (${f.status}, +${f.additions}/-${f.deletions})`;
      const body = f.patch
        ? f.patch
        : '(no patch available — binary or too large; cannot comment inline on this file)';
      return `${header}\n${body}`;
    })
    .join('\n\n');
}

/**
 * Review one batch of changed files. Returns the structured review, or null if
 * the agent failed to submit one.
 */
export async function reviewBatch(params: {
  instructions: string;
  language: Language;
  prTitle: string;
  files: ChangedFile[];
  batchIndex: number;
  batchCount: number;
}): Promise<Review | null> {
  let captured: Review | null = null;

  const submitReview = tool(
    'submit_review',
    'Submit the completed review for this batch of files.',
    {
      summary: z.string().describe('Summary of findings for these files (the review body).'),
      verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('Verdict for this batch.'),
      comments: z
        .array(
          z.object({
            path: z.string().describe('File path exactly as shown after "### FILE:".'),
            line: z.number().int().positive().describe('Line number on the RIGHT (new) side of the patch.'),
            body: z.string().describe('The inline comment text.'),
          }),
        )
        .describe('Inline comments anchored to changed lines. May be empty.'),
    },
    async (args) => {
      captured = {
        summary: args.summary,
        verdict: args.verdict as Verdict,
        comments: args.comments as ReviewComment[],
      };
      return { content: [{ type: 'text', text: 'Review recorded.' }] };
    },
  );

  const reviewServer = createSdkMcpServer({ name: 'review', version: '1.0.0', tools: [submitReview] });

  const batchNote =
    params.batchCount > 1
      ? `This is batch ${params.batchIndex + 1} of ${params.batchCount} for this PR. Review only the files below; other files are handled in other batches.`
      : '';

  const prompt = [
    'You are reviewing a GitHub pull request. Follow these review instructions:',
    '',
    '--- REVIEW INSTRUCTIONS ---',
    params.instructions,
    '--- END INSTRUCTIONS ---',
    '',
    languageDirective(params.language),
    '',
    `Pull request title: ${params.prTitle}`,
    batchNote,
    '',
    'For inline comments, `path` must be a file path shown after "### FILE:" and',
    '`line` must be a line number present on the new (RIGHT) side of that file\'s patch.',
    'Do not comment on files without a shown patch.',
    '',
    '--- CHANGED FILES ---',
    renderFiles(params.files),
    '--- END CHANGED FILES ---',
    '',
    'When finished, call `submit_review` exactly once. Do not produce other output.',
  ].join('\n');

  const q = query({
    prompt,
    options: {
      model: 'opus',
      mcpServers: { review: reviewServer },
      allowedTools: ['mcp__review__submit_review'],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      maxTurns: 8,
    },
  });

  for await (const message of q) {
    if (message.type === 'result') break;
  }
  return captured;
}

/**
 * Merge per-batch summaries into one coherent overview. Falls back to the
 * concatenated summaries if the synthesis call yields nothing.
 */
export async function synthesizeSummary(params: {
  language: Language;
  prTitle: string;
  summaries: string[];
}): Promise<string> {
  const fallback = params.summaries.map((s, i) => `Batch ${i + 1}:\n${s}`).join('\n\n');
  if (params.summaries.length <= 1) {
    return params.summaries[0] ?? '';
  }

  const prompt = [
    'You are synthesizing a single pull request review summary from the per-batch',
    'summaries below (the PR was reviewed in parts). Produce ONE coherent overview:',
    'what the PR does, the most important findings, and any blocking concerns.',
    'Do not invent findings not present below. Be concise.',
    '',
    languageDirective(params.language),
    '',
    `Pull request title: ${params.prTitle}`,
    '',
    '--- BATCH SUMMARIES ---',
    params.summaries.map((s, i) => `[Batch ${i + 1}]\n${s}`).join('\n\n'),
    '--- END BATCH SUMMARIES ---',
    '',
    'Output only the final synthesized summary text.',
  ].join('\n');

  const q = query({
    prompt,
    options: {
      model: 'opus',
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      maxTurns: 2,
    },
  });

  let text = '';
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype === 'success' && typeof (message as { result?: unknown }).result === 'string') {
        text = (message as { result: string }).result;
      }
      break;
    }
  }
  return text.trim() || fallback;
}
