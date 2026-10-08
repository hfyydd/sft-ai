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
      } else if (run.status === 'waiting_approval') {
        await taskRunStore.updateStatus(run.id, 'waiting_user');
        await taskRunStore.appendEvent(run.id, 'approval.recovery_required', { reason: 'service_worker_restart' });
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
    let nextStatus: TaskRunStatus | null = null;
    if (event.state === 'task.start') nextStatus = 'running';
    else if (event.state === 'task.pause') nextStatus = 'paused';
    else if (event.state === 'task.ok') nextStatus = 'completed';
    else if (event.state === 'task.fail') nextStatus = 'failed';
    else if (event.state === 'task.cancel') nextStatus = 'cancelled';

    if (nextStatus) await taskRunStore.updateStatus(run.id, nextStatus).catch(() => undefined);

    const snapshot = this.executor?.getRuntimeSnapshot();
    if (snapshot && nextStatus && TERMINAL.has(nextStatus)) {
      await taskRunStore.appendEvent(run.id, 'runtime.metrics', {
        durationMs: snapshot.durationMs,
        estimatedInputTokens: snapshot.estimatedInputTokens,
        steps: snapshot.step,
        navigator: snapshot.navigator,
        planner: snapshot.planner,
      }).catch(() => undefined);
    }
    if (snapshot && !(nextStatus && TERMINAL.has(nextStatus))) {
      await taskRunStore.saveCheckpoint({
        runId: run.id, sequence: persisted.sequence, plan: snapshot.plan, completedStepIds: snapshot.plan.filter(s => s.status === 'completed').map(s => s.id),
        memory: snapshot.memory, evidenceIds: (await taskRunStore.getEvidence(run.id, 200)).map(e => e.id), activeTabId: run.activeTabId,
        pendingWrite: snapshot.pendingWrite,
      }).catch(error => taskRunStore.appendEvent(run.id, 'runtime.checkpoint_failed', { error: String(error) }).catch(() => undefined));
    }
    for (const subscriber of this.subscribers) await subscriber(event);
  }

  async continueWithFollowUp(runId: string, task: string) {
    const run = await taskRunStore.getRun(runId);
    if (!run) throw new Error('Unknown task run');
    if (this.activeRunId && this.activeRunId !== runId) throw new Error('Another task is already active');

    if (!this.executor) {
      if (!this.factory) throw new Error('RunController executor factory is not configured');
      if (run.activeTabId !== undefined) await this.assertRecoverableTab(run.activeTabId);
      this.activeRunId = run.id;
      this.executor = await this.factory(run);
      await this.hydrateExecutor(run);
    }

    this.executor.addFollowUpTask(task);
    await taskRunStore.appendEvent(run.id, 'task.follow_up', { task });
    await taskRunStore.updateStatus(run.id, 'running');
    this.executor.subscribeExecutionEvents(event => this.onEvent(run, event));
    void this.executeDetached(run);
  }

  async startReplay(runId: string, historySessionId: string, task: string, tabId: number) {
    if (this.activeRunId) throw new Error('Another task is already active');
    const run = await taskRunStore.createRun({ id: runId, sessionId: runId, goal: task, activeTabId: tabId });
    if (!this.factory) throw new Error('RunController executor factory is not configured');
    await this.assertRecoverableTab(tabId);
    this.activeRunId = run.id;
    this.executor = await this.factory(run);
    this.executor.subscribeExecutionEvents(event => this.onEvent(run, event));
    await taskRunStore.updateStatus(run.id, 'running');
    try {
      void this.executeReplayDetached(run, historySessionId);
    } catch {
      await taskRunStore.updateStatus(run.id, 'failed').catch(() => undefined);
      throw new Error('Failed to start replay');
    }
  }

  private async executeReplayDetached(run: TaskRun, historySessionId: string) {
    try {
      await this.executor?.replayHistory(historySessionId);
    } catch (error) {
      await taskRunStore.updateStatus(run.id, 'failed').catch(() => undefined);
      await taskRunStore.appendEvent(run.id, 'runtime.replay_exception', { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    } finally {
      if (this.executor) await this.executor.cleanup();
      await this.clearIfTerminal();
    }
  }

  async handleTabClosed(tabId: number) {
    const runId = this.activeRunId;
    if (!runId) return;
    const run = await taskRunStore.getRun(runId);
    if (!run || run.activeTabId !== tabId || !ACTIVE.has(run.status)) return;
    await taskRunStore.updateStatus(runId, 'interrupted');
    await taskRunStore.appendEvent(runId, 'runtime.tab_closed', { tabId });
    if (this.executor) await this.executor.pause().catch(() => undefined);
  }

  async handleDebuggerDetached(tabId: number, reason: string) {
    const runId = this.activeRunId;
    if (!runId) return;
    const run = await taskRunStore.getRun(runId);
    if (!run || run.activeTabId !== tabId || !ACTIVE.has(run.status)) return;
    if (reason === 'canceled_by_user') {
      await this.cancel();
      return;
    }
    await taskRunStore.updateStatus(runId, 'interrupted');
    await taskRunStore.appendEvent(runId, 'runtime.debugger_detached', { tabId, reason });
    await this.executor?.pause().catch(() => undefined);
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
    const checkpoint = await taskRunStore.getCheckpoint(run.id);
    if (checkpoint?.pendingAction) {
      throw new Error('Task has a pending approval; re-approve the exact action before recovery');
    }
    if (checkpoint?.pendingUserRequest) {
      throw new Error('Task is waiting for user input; answer the persisted question before recovery');
    }
    if (checkpoint?.pendingWrite) {
      await taskRunStore.appendEvent(run.id, 'runtime.recovery_needs_verification', {
        toolName: checkpoint.pendingWrite.toolName,
        tabId: checkpoint.pendingWrite.tabId,
        url: checkpoint.pendingWrite.url,
      });
      throw new Error('Task has an unknown browser write; verify its postcondition before recovery');
    }
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