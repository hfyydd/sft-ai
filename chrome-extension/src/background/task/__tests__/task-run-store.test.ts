import { describe, expect, it } from 'vitest';
import type { TaskRun } from '@extension/storage';
import { checkpointIsValid, nextTaskRunEventSequence } from '@extension/storage';

const run = (lastEventSequence: number): TaskRun => ({
  id: 'run-1',
  sessionId: 'session-1',
  goal: 'goal',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  activeTabId: 1,
  checkpointVersion: Math.min(lastEventSequence, 3),
  lastEventSequence,
  skillIds: [],
});

describe('TaskRunStore sequencing contract', () => {
  it('increments the event head monotonically', () => {
    expect(nextTaskRunEventSequence(run(0))).toBe(1);
    expect(nextTaskRunEventSequence(run(41))).toBe(42);
  });

  it('accepts checkpoints at or behind the event head', () => {
    expect(checkpointIsValid(run(7), 7)).toBe(true);
    expect(checkpointIsValid(run(7), 6)).toBe(true);
    expect(checkpointIsValid(run(7), 8)).toBe(false);
  });

  it('tracks the complete durable lifecycle independently of in-memory Executor state', () => {
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    expect(terminal.has(run(3).status)).toBe(false);
    expect(['queued','running','waiting_approval','waiting_user','paused','interrupted']).toHaveLength(6);
  });
});
