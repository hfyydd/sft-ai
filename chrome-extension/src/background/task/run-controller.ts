import { taskRunStore, type PendingWrite, type TaskRun, type TaskRunStatus } from '@extension/storage';
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
  private verifier: ((run: TaskRun, pendingWrite: PendingWrite) => Promise<boolean>) | null = null;
  private executorSubscription: (() => void) | null = null;

  configure(factory: RunControllerFactory, verifier?: (run: TaskRun, pendingWrite: PendingWrite) => Promise<boolean>) {
    this.factory = factory;
    this.verifier = verifier ?? null;
  }

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
    const persistedActive = await taskRunStore.listActiveRuns();
    if (persistedActive.some(existing => existing.id !== input.runId && existing.status !== 'interrupted')) {
      throw new Error('Another persisted task run is already active');
    }
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
      try {
        this.executor = await this.factory(run);
        await this.hydrateExecutor(run);
        this.executorSubscription?.();
        this.executorSubscription = this.executor.subscribeExecutionEvents(event => this.onEvent(run, event));
        await taskRunStore.updateStatus(run.id, 'running');
        void this.executeDetached(run);
        return run;
      } catch (error) {
        this.executorSubscription?.();
        this.executorSubscription = null;
        this.executor = null;
        await taskRunStore.updateStatus(run.id, 'failed').catch(() => undefined);
        await taskRunStore.appendEvent(run.id, 'runtime.start_failed', { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        this.activeRunId = null;
        throw error;
      }
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
    const observedTabId = await this.executor?.getActiveTabId();
    if (observedTabId !== undefined) {
      await taskRunStore.updateStatus(run.id, event.state === 'task.cancel' ? 'cancelled' : (await taskRunStore.getRun(run.id))?.status ?? 'running', {
        activeTabId: observedTabId,
      }).catch(() => undefined);
    }
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
      const currentCheckpoint = await taskRunStore.getCheckpoint(run.id).catch(() => undefined);
      await taskRunStore.saveCheckpoint({
        runId: run.id,
        sequence: persisted.sequence,
        plan: snapshot.plan,
        completedStepIds: snapshot.plan.filter(s => s.status === 'completed').map(s => s.id),
        memory: snapshot.memory,
        evidenceIds: (await taskRunStore.getEvidence(run.id, 200)).map(e => e.id),
        activeTabId: observedTabId ?? run.activeTabId,
        pendingWrite: snapshot.pendingWrite,
        approvedAction: snapshot.approvedAction ?? currentCheckpoint?.approvedAction,
        pendingAction: currentCheckpoint?.pendingAction,
        pendingUserRequest: currentCheckpoint?.pendingUserRequest,
        pendingFileRead: currentCheckpoint?.pendingFileRead,
      }).catch(async error => {
        if (error instanceof Error && error.message === 'Stale checkpoint') return;

        await taskRunStore.updateStatus(run.id, 'paused').catch(() => undefined);
        await taskRunStore.appendEvent(run.id, 'runtime.checkpoint_failed', { error: String(error) }).catch(() => undefined);
        await this.executor?.pause().catch(() => undefined);
      });
    }
    for (const subscriber of this.subscribers) await subscriber(event);
  }

  async continueWithFollowUp(runId: string, task: string) {
    const run = await taskRunStore.getRun(runId);
    if (!run) throw new Error('Unknown task run');
    if (this.activeRunId && this.activeRunId !== runId) throw new Error('Another task is already active');

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('终态任务不能直接追加 Follow-up，请创建新的任务运行');
    }

    if (run.status === 'interrupted' && !this.executor) {
      if (!this.factory) throw new Error('RunController executor factory is not configured');
      if (run.activeTabId !== undefined) await this.assertRecoverableTab(run.activeTabId);
      const checkpoint = await taskRunStore.getCheckpoint(run.id);
      if (checkpoint?.pendingAction || checkpoint?.pendingUserRequest) {
        throw new Error('该任务仍在等待审批或用户输入，不能直接追加 Follow-up');
      }
      if (checkpoint?.pendingWrite) {
        const verified = this.verifier ? await this.verifier(run, checkpoint.pendingWrite) : false;
        if (!verified) throw new Error('任务存在未确认的浏览器写操作，请先恢复并核验');
        const event = await taskRunStore.appendEvent(run.id, 'runtime.recovery_verified', { toolName: checkpoint.pendingWrite.toolName });
        await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: event.sequence, pendingWrite: undefined });
      }
      this.activeRunId = run.id;
      this.executor = await this.factory(run);
      await this.hydrateExecutor(run);
    }

    if (!this.executor) {
      if (!this.factory) throw new Error('RunController executor factory is not configured');
      if (run.activeTabId !== undefined) await this.assertRecoverableTab(run.activeTabId);
      this.activeRunId = run.id;
      this.executor = await this.factory(run);
      await this.hydrateExecutor(run);
    }

    if (run.status === 'paused') await this.executor.resume();
    this.executor.addFollowUpTask(task);
    await taskRunStore.appendEvent(run.id, 'task.follow_up', { task });
    await taskRunStore.updateStatus(run.id, 'running');
    this.executorSubscription?.();
    this.executorSubscription = this.executor.subscribeExecutionEvents(event => this.onEvent(run, event));
    void this.executeDetached(run);
  }

  async startReplay(runId: string, historySessionId: string, task: string, tabId: number) {
    if (this.activeRunId) throw new Error('Another task is already active');
    const run = await taskRunStore.createRun({ id: runId, sessionId: runId, goal: task, activeTabId: tabId });
    if (!this.factory) throw new Error('RunController executor factory is not configured');
    await this.assertRecoverableTab(tabId);
    this.activeRunId = run.id;
    this.executor = await this.factory(run);
    this.executorSubscription?.();
    this.executorSubscription = this.executor.subscribeExecutionEvents(event => this.onEvent(run, event));
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
    if (this.executor) {
      await this.executor.cleanup().catch(() => undefined);
      this.executorSubscription?.();
      this.executorSubscription = null;
      this.executor = null;
    }
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
    if (this.executor) {
      await this.executor.cleanup().catch(() => undefined);
      this.executorSubscription?.();
      this.executorSubscription = null;
      this.executor = null;
    }
  }

  async pause(runId?: string) {
    const targetId = this.activeRunId ?? runId;
    if (!targetId) throw new Error('No active task');
    if (this.executor && this.activeRunId === targetId) await this.executor.pause();
    await taskRunStore.appendEvent(targetId, 'task.pause', { reason: 'user_command' });
    await taskRunStore.updateStatus(targetId, 'paused');
  }

  async resume(runId?: string) {
    if (this.executor) {
      const targetId = this.activeRunId;
      if (runId && targetId && runId !== targetId) throw new Error('Task run mismatch');
      if (targetId) {
        const pendingWrite = this.executor.getPendingWrite();
        if (pendingWrite) {
          const run = await taskRunStore.getRun(targetId);
          if (!run) throw new Error('Unknown task run');
          const verified = this.verifier ? await this.verifier(run, pendingWrite) : false;
          if (!verified) {
            await taskRunStore.appendEvent(targetId, 'runtime.recovery_needs_verification', {
              toolName: pendingWrite.toolName,
              tabId: pendingWrite.tabId,
              url: pendingWrite.url,
            });
            throw new Error('未确认的浏览器写操作必须先完成后置条件核验');
          }
          const event = await taskRunStore.appendEvent(targetId, 'runtime.recovery_verified', {
            toolName: pendingWrite.toolName,
            parameterHash: pendingWrite.parameterHash,
          });
          this.executor.clearPendingWrite();
          const checkpoint = await taskRunStore.getCheckpoint(targetId);
          if (checkpoint) await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: event.sequence, pendingWrite: undefined });
        }
        await this.executor.resume();
        await taskRunStore.appendEvent(targetId, 'task.resume', { reason: 'user_command' });
        await taskRunStore.updateStatus(targetId, 'running');
      }
      return;
    }
    if (runId) { await this.recover(runId); return; }
    throw new Error('No recoverable task');
  }

  async cancel(runId?: string) {
    const targetId = this.activeRunId ?? runId;
    if (!targetId) throw new Error('No active task');
    if (this.executor && this.activeRunId === targetId) await this.executor.cancel();
    await taskRunStore.appendEvent(targetId, 'task.cancel', { reason: 'user_command' }).catch(() => undefined);
    await taskRunStore.updateStatus(targetId, 'cancelled').catch(() => undefined);
    if (this.activeRunId === targetId && !this.executor) await this.clearIfTerminal();
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
      const verified = this.verifier ? await this.verifier(run, checkpoint.pendingWrite) : false;
      if (!verified) {
        await taskRunStore.appendEvent(run.id, 'runtime.recovery_needs_verification', {
          toolName: checkpoint.pendingWrite.toolName,
          tabId: checkpoint.pendingWrite.tabId,
          url: checkpoint.pendingWrite.url,
        });
        throw new Error('Task has an unknown browser write; verify its postcondition before recovery');
      }
      const event = await taskRunStore.appendEvent(run.id, 'runtime.recovery_verified', {
        toolName: checkpoint.pendingWrite.toolName,
      });
      await taskRunStore.saveCheckpoint({
        ...checkpoint,
        sequence: event.sequence,
        pendingWrite: undefined,
      });
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
      this.executorSubscription?.();
      this.executorSubscription = null;
      this.executor = null;
      this.activeRunId = null;
    }
  }
}

export const runController = new RunController();