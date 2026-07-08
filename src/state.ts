// Load/save state.json atomically (temp file + rename).

import { readFile, writeFile, rename } from 'node:fs/promises';
import type { State } from './types.js';

export function stateKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

let tmpCounter = 0;

export async function loadState(path: string): Promise<State> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as State;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  // Unique tmp name so concurrent saves don't clobber each other's temp file.
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}
