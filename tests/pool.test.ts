import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/pool.js';

test('Semaphore caps concurrency', async () => {
  const sem = new Semaphore(3);
  let active = 0;
  let peak = 0;
  const task = () =>
    sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });

  await Promise.all(Array.from({ length: 9 }, task));
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
});

test('Semaphore releases its slot even when the task throws', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error('boom'); }));
  // If the slot leaked, this would deadlock and the test would time out.
  const value = await sem.run(async () => 42);
  assert.equal(value, 42);
});
