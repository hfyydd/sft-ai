import { describe, expect, it } from 'vitest';
import { canTransitionTaskRun, assertTaskRunTransition } from '@extension/storage';

describe('RunController durable lifecycle', () => {
  it('allows the normal run, approval, pause and recovery lifecycle', () => {
    const transitions = [
      ['queued', 'running'],
      ['running', 'waiting_approval'],
      ['waiting_approval', 'waiting_user'],
      ['waiting_user', 'running'],
      ['running', 'paused'],
      ['paused', 'running'],
      ['running', 'interrupted'],
      ['interrupted', 'running'],
      ['running', 'completed'],
    ] as const;
    for (const [from, to] of transitions) {
      expect(canTransitionTaskRun(from, to)).toBe(true);
      expect(() => assertTaskRunTransition(from, to)).not.toThrow();
    }
  });

  it('refuses to pause a run while an approval or user response is pending', () => {
    expect(canTransitionTaskRun('waiting_approval', 'paused')).toBe(false);
    expect(canTransitionTaskRun('waiting_user', 'paused')).toBe(false);
  });

  it('does not permit terminal tasks to resume', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(canTransitionTaskRun(status, 'running')).toBe(false);
      expect(() => assertTaskRunTransition(status, 'running')).toThrow('Invalid task run transition');
    }
  });

  it('allows an explicit user cancellation from each non-terminal state', () => {
    for (const status of ['queued', 'running', 'waiting_approval', 'waiting_user', 'paused', 'interrupted'] as const) {
      expect(canTransitionTaskRun(status, 'cancelled')).toBe(true);
    }
  });
});
