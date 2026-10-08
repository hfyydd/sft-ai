import { taskRunStore, type TaskRun, type TaskRunStatus } from '@extension/storage';
import type { Executor } from '../agent/executor';
import type { AgentEvent } from '../agent/event/types';

const TERMINAL = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set<TaskRunStatus>(['queued', 'running', 'waiting_approval', 'waiting_user', 'paused', 'interrupted']);

export interface RunControllerFactory {
  (run: TaskRun): Promise<Executor>;
}

export class RunController {
  private executor: Executor | null = null;
  private activeRunId: string | null = null;
  private factory: RunControllerFactory | null = null;
  private subscribers = new Set<(event: AgentEvent) => Promise<void> | void>();
  private starting = false;

  configure(factory: RunControllerFactory) { this.factory = factory; }

  subscribe(callback: (event: AgentEvent) => Promise<void> | void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async initialize() {
    const active = await taskRunStore.listActiveRuns();
    for (const run of active) {
      if (run.status === 'running' || run.status === 'queued') {
        await taskRunStore.updateStatus(run.id, 'interrupted');
        await taskRunStore.appendEvent(run.id, 'runtime.interrupted', { reason: 'service_worker_restart' });
      }
    }
  }

  async createAndStart(input: { runId: string; sessionId: string; goal: string; tabId: number; skillIds?: string[]; createExecutor?: RunControllerFactory }) {
    if (this.activeRunId) throw new Error('Another task is already active');
    const run = await taskRunStore.createRun({
      id: input.runId, sessionId: input.sessionId, goal: input.goal, activeTabId: input.tabId, skillIds: input.skillIds ?? [],
    });
    if (input.createExecutor) this.factory = input.createExecutor;
    return this.start(run);
  }

  async start(run: TaskRun) {
    if (this.starting) throw new Error('Task runtime is starting');
    if (this.activeRunId && this.activeRunId !== run.id) throw new Error('Another task is already active');
    if (!this.factory) throw new Error('RunController executor factory is not configured');
    this.starting = true;
    try {
      if (run.activeTabId !== undefined) await this.assertRecoverableTab(run.activeTabId);
      this.activeRunId = run.id;
      this.executor = await this.factory(run);
      await this.hydrateExecutor(run);
      this.executor.subscribeExecutionEvents(event => this.onEvent(run, event));
      await taskRunStore.updateStatus(run.id, 'running');
      void this.executeDetached(run);
      return run;
    } finally {
      this.starting = false;
    }
  }

  private async executeDetached(run: TaskRun) {
    try { await this.executor?.execute(); } catch (error) {
      await taskRunStore.updateStatus(run.id, 'failed').catch(() => undefined);
      await taskRunStore.appendEvent(run.id, 'runtime.exception', { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    } finally {
      if (this.executor) await this.executor.cleanup();
      await this.clearIfTerminal();
    }
  }

  private async hydrateExecutor(run: TaskRun) {
    const checkpoint = await taskRunStore.getCheckpoint(run.id);
    this.executor?.hydrateRuntime(checkpoint);
  }

  private async assertRecoverableTab(tabId: number) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id || !tab.url) throw new Error('Task recovery target tab is unavailable');
    return tab;
  }

  private async onEvent(run: TaskRun, event: AgentEvent) {
    const persisted = await taskRunStore.appendEvent(run.id, event.state, {
      actor: event.actor, data: event.data, timestamp: event.timestamp,
    });
    for (const subscriber of this.subscribers) await subscriber(event);

    let nextStatus: TaskRunStatus | null = null;
    if (event.state === 'task.start') nextStatus = 'running';
    else if (event.state === 'task.pause') nextStatus = 'paused';
    else if (event.state === 'task.ok') nextStatus = 'completed';
    else if (event.state === 'task.fail') nextStatus = 'failed';
    else if (event.state === 'task.cancel') nextStatus = 'cancelled';

    if (nextStatus) await taskRunStore.updateStatus(run.id, nextStatus).catch(() => undefined);

    const snapshot = this.executor?.getRuntimeSnapshot();
    if (snapshot && !(nextStatus && TERMINAL.has(nextStatus))) {
      await taskRunStore.saveCheckpoint({
        runId: run.id, sequence: persisted.sequence, plan: snapshot.plan, completedStepIds: snapshot.plan.filter(s => s.status === 'completed').map(s => s.id),
        memory: snapshot.memory, evidenceIds: (await taskRunStore.getEvidence(run.id, 200)).map(e => e.id), activeTabId: run.activeTabId,
      }).catch(error => taskRunStore.appendEvent(run.id, 'runtime.checkpoint_failed', { error: String(error) }).catch(() => undefined));
    }
  }

  async pause() {
    if (!this.executor || !this.activeRunId) throw new Error('No active task');
    await this.executor.pause();
    await taskRunStore.updateStatus(this.activeRunId, 'paused');
  }

  async resume(runId?: string) {
    if (this.executor) {
      await this.executor.resume();
      if (this.activeRunId) await taskRunStore.updateStatus(this.activeRunId, 'running');
      return;
    }
    if (runId) { await this.recover(runId); return; }
    throw new Error('No recoverable task');
  }

  async cancel() {
    if (!this.executor || !this.activeRunId) throw new Error('No active task');
    await this.executor.cancel();
    await taskRunStore.updateStatus(this.activeRunId, 'cancelled').catch(() => undefined);
  }

  async recover(runId: string) {
    const run = await taskRunStore.getRun(runId);
    if (!run) throw new Error('Unknown task run');
    if (!ACTIVE.has(run.status) || run.status === 'queued') throw new Error('Run is not recoverable');
    if (this.activeRunId && this.activeRunId !== run.id) throw new Error('Another task is already active');
    if (!this.factory) throw new Error('RunController executor factory is not configured');
    await this.assertRecoverableTab(run.activeTabId ?? -1);
    return this.start({ ...run, status: 'running' });
  }

  async snapshot(runId: string, afterSequence = 0) { return taskRunStore.getSnapshot(runId, afterSequence); }
  getExecutor() { return this.executor; }
  getRunId() { return this.activeRunId; }

  async clearIfTerminal() {
    if (!this.activeRunId) return;
    const run = await taskRunStore.getRun(this.activeRunId);
    if (run && TERMINAL.has(run.status)) {
      this.executor = null;
      this.activeRunId = null;
    }
  }
}

export const runController = new RunController();