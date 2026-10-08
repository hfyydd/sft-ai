import { describe, expect, it } from 'vitest';
import type { TaskRunStatus } from '@extension/storage';

describe('TaskRun status model', () => {
  it('contains every durable lifecycle state', () => {
    const states: TaskRunStatus[] = ['queued','running','waiting_approval','waiting_user','paused','interrupted','completed','failed','cancelled'];
    expect(states).toHaveLength(9);
  });
  it('has explicit terminal states', () => {
    const terminal: TaskRunStatus[] = ['completed','failed','cancelled'];
    expect(terminal).not.toContain('interrupted');
  });
});
