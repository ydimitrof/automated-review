// Load and validate config.json; resolve `file:` review-instruction references.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Config, ResolvedRepo } from './types.js';

const repoSchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be "owner/name"'),
  // Accept any case ("EN", "Bg", "Both", …) and normalize to the canonical form.
  language: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase() : v),
    z.enum(['en', 'bg', 'both']),
  ),
  reviewInstructions: z.string().min(1).optional(),
});

const configSchema = z.object({
  reviewer: z.string().min(1),
  pollIntervalMinutes: z.number().positive(),
  maxConcurrentReviews: z.number().int().positive().optional(),
  reviewInstructions: z.string().min(1),
  repos: z.array(repoSchema).min(1),
  demoMode: z.boolean().optional(),
});

/**
 * Resolve an instruction value: if it starts with "file:", read that file
 * (relative to the config file's directory); otherwise return it verbatim.
 */
async function resolveInstructions(value: string, baseDir: string): Promise<string> {
  if (value.startsWith('file:')) {
    const path = resolve(baseDir, value.slice('file:'.length).trim());
    const text = await readFile(path, 'utf8');
    if (!text.trim()) {
      throw new Error(`review instructions file is empty: ${path}`);
    }
    return text;
  }
  return value;
}

export interface LoadedConfig extends Config {
  resolvedRepos: ResolvedRepo[];
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = configSchema.parse(JSON.parse(raw));
  const baseDir = dirname(resolve(configPath));

  const defaultInstructions = await resolveInstructions(parsed.reviewInstructions, baseDir);

  const resolvedRepos: ResolvedRepo[] = [];
  for (const r of parsed.repos) {
    const resolvedInstructions = r.reviewInstructions
      ? await resolveInstructions(r.reviewInstructions, baseDir)
      : defaultInstructions;
    resolvedRepos.push({ ...r, resolvedInstructions });
  }

  return { ...parsed, resolvedRepos };
}
