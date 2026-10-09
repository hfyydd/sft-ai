import type { TaskRunStatus } from './types';

const transitions: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  queued: new Set(['running', 'interrupted', 'failed', 'cancelled']),
  running: new Set(['waiting_approval', 'waiting_user', 'paused', 'interrupted', 'completed', 'failed', 'cancelled']),
  waiting_approval: new Set(['waiting_user', 'running', 'interrupted', 'failed', 'cancelled']),
  waiting_user: new Set(['running', 'interrupted', 'failed', 'cancelled']),
  paused: new Set(['running', 'interrupted', 'failed', 'cancelled']),
  interrupted: new Set(['running', 'waiting_approval', 'waiting_user', 'paused', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransitionTaskRun(from: TaskRunStatus, to: TaskRunStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertTaskRunTransition(from: TaskRunStatus, to: TaskRunStatus): void {
  if (!canTransitionTaskRun(from, to)) {
    throw new Error('Invalid task run transition: ' + from + ' -> ' + to);
  }
}
