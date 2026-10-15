import { describe, expect, it } from 'vitest';
import { loadTasks, validate } from './run.ts';

describe('benchmark tasks', () => {
  it('each check fails on the starting project and passes with the reference solution', async () => {
    const report = await validate(await loadTasks());
    expect(report.filter((r) => !r.ok)).toEqual([]);
    expect(report.length).toBeGreaterThanOrEqual(12);
  }, 120_000);
});
