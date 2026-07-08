import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

async function withTempConfig(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'prbot-cfg-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizes language case and resolves file: + per-repo override', async () => {
  await withTempConfig(
    {
      'config.json': JSON.stringify({
        reviewer: 'me',
        pollIntervalMinutes: 15,
        reviewInstructions: 'file:./default.md',
        repos: [
          { repo: 'a/one', language: 'EN' },
          { repo: 'a/two', language: 'Both', reviewInstructions: 'inline override' },
        ],
      }),
      'default.md': 'default instructions',
    },
    async (dir) => {
      const cfg = await loadConfig(join(dir, 'config.json'));
      assert.equal(cfg.resolvedRepos[0].language, 'en');
      assert.equal(cfg.resolvedRepos[1].language, 'both');
      assert.equal(cfg.resolvedRepos[0].resolvedInstructions, 'default instructions');
      assert.equal(cfg.resolvedRepos[1].resolvedInstructions, 'inline override');
    },
  );
});

test('rejects an invalid repo slug', async () => {
  await withTempConfig(
    {
      'config.json': JSON.stringify({
        reviewer: 'me',
        pollIntervalMinutes: 15,
        reviewInstructions: 'x',
        repos: [{ repo: 'not-a-slug', language: 'en' }],
      }),
    },
    async (dir) => {
      await assert.rejects(loadConfig(join(dir, 'config.json')));
    },
  );
});
