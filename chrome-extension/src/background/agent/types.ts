import { z } from 'zod';
import type BrowserContext from '../browser/context';
import { DEFAULT_INCLUDE_ATTRIBUTES } from '../browser/dom/views';
import type { DOMHistoryElement } from '../browser/dom/history/view';
import type MessageManager from './messages/service';
import type { EventManager } from './event/manager';
import { type Actors, type ExecutionState, AgentEvent } from './event/types';
import { AgentStepHistory } from './history';
import type { ToolPolicy } from '../services/toolPolicy';
import { taskRunStore, type PendingAction, type PendingWrite, type PlanStep } from '@extension/storage';

export interface AgentOptions {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  retryDelay: number;
  maxInputTokens: number;
  maxErrorLength: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  includeAttributes: string[];
  planningInterval: number;
  maxReplans: number;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  maxSteps: 100,
  maxActionsPerStep: 10,
  maxFailures: 3,
  retryDelay: 10,
  maxInputTokens: 128000,
  maxErrorLength: 400,
  useVision: false,
  useVisionForPlanner: true,
  includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
  planningInterval: 3,
  maxReplans: 30,
};

import { TaskMemory } from './memory';

export class AgentContext {
  controller: AbortController;
  taskId: string;
  browserContext: BrowserContext;
  messageManager: MessageManager;
  eventManager: EventManager;
  options: AgentOptions;
  paused: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  replanCount: number;
  nSteps: number;
  stepInfo: AgentStepInfo | null;
  actionResults: ActionResult[];
  stateMessageAdded: boolean;
  history: AgentStepHistory;
  finalAnswer: string | null;
  taskMemory: TaskMemory;
  toolPolicy?: ToolPolicy;
  plan: PlanStep[];
  startedAt: number;
  pendingWrite?: PendingWrite;
  approvedAction?: PendingAction;

  constructor(
    taskId: string,
    browserContext: BrowserContext,
    messageManager: MessageManager,
    eventManager: EventManager,
    options: Partial<AgentOptions>,
    toolPolicy?: ToolPolicy,
  ) {
    this.controller = new AbortController();
    this.taskId = taskId;
    this.browserContext = browserContext;
    this.messageManager = messageManager;
    this.eventManager = eventManager;
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };

    this.paused = false;
    this.stopped = false;
    this.nSteps = 0;
    this.consecutiveFailures = 0;
    this.replanCount = 0;
    this.stepInfo = null;
    this.actionResults = [];
    this.stateMessageAdded = false;
    this.history = new AgentStepHistory();
    this.finalAnswer = null;
    this.taskMemory = new TaskMemory();
    this.toolPolicy = toolPolicy;
    this.plan = [];
    this.startedAt = Date.now();
  }

  async beginToolWrite(toolName: string, args: unknown, index?: number): Promise<PendingWrite | undefined> {
    const sideEffectTools = new Set([
      'click_element','input_text','select_dropdown_option','send_keys','fill_form',
      'go_to_url','open_tab','close_tab','go_back','switch_tab','search_google',
    ]);
    if (!sideEffectTools.has(toolName)) return undefined;

    let tabId: number | undefined;
    let url: string | undefined;
    try {
      const page = await this.browserContext.getCurrentPage();
      tabId = page.tabId;
      url = page.url();
    } catch {
      // Best-effort page metadata lookup; policy and execution continue without cached tab metadata.
    }

    const argsObject = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    const expectedUrl = typeof argsObject.url === 'string'
      ? argsObject.url
      : undefined;
    const expectedValue = typeof argsObject.text === 'string'
      ? argsObject.text
      : undefined;
    const parameterSource = JSON.stringify(args ?? null);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parameterSource));
    const parameterHash = Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
    let expectedValueHash: string | undefined;
    if (expectedValue !== undefined) {
      const valueDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(expectedValue)));
      expectedValueHash = Array.from(new Uint8Array(valueDigest)).map(v => v.toString(16).padStart(2, '0')).join('');
    }

    const pendingWrite: PendingWrite = {
      toolName, parameterHash, tabId, url, expectedUrl,
      startedAt: Date.now(), index, expectedValueHash, phase: 'executing',
    };
    this.pendingWrite = pendingWrite;

    try {
      const event = await taskRunStore.appendEvent(this.taskId, 'tool.requested', pendingWrite);
      const checkpoint = await taskRunStore.getCheckpoint(this.taskId);
      await taskRunStore.saveCheckpoint({
        runId: this.taskId,
        sequence: event.sequence,
        plan: checkpoint?.plan ?? this.plan,
        completedStepIds: checkpoint?.completedStepIds ?? this.plan.filter(step => step.status === 'completed').map(step => step.id),
        memory: checkpoint?.memory ?? this.taskMemory.getFacts(),
        evidenceIds: checkpoint?.evidenceIds ?? [],
        activeTabId: tabId ?? checkpoint?.activeTabId,
        navigatorState: checkpoint?.navigatorState,
        pendingAction: checkpoint?.pendingAction,
        approvedAction: checkpoint?.approvedAction,
        pendingWrite,
        pendingUserRequest: checkpoint?.pendingUserRequest,
        pendingFileRead: checkpoint?.pendingFileRead,
      });
    } catch (error) {
      this.paused = true;
      throw new Error('无法持久化浏览器写操作检查点：' + (error instanceof Error ? error.message : String(error)));
    }
    return pendingWrite;
  }

  async finishToolWrite(result: ActionResult | undefined) {
    if (!this.pendingWrite) return;
    if (result?.error) {
      this.taskMemory.add('浏览器写操作结果未知：' + result.error.slice(0, 180) + '。恢复前必须先核验后置条件。');
      await taskRunStore.appendEvent(this.taskId, 'runtime.unknown_side_effect', {
        toolName: this.pendingWrite.toolName,
        parameterHash: this.pendingWrite.parameterHash,
        error: result.error,
      }).catch(() => undefined);
      return;
    }
    const event = await taskRunStore.appendEvent(this.taskId, 'tool.completed', {
      toolName: this.pendingWrite.toolName,
      parameterHash: this.pendingWrite.parameterHash,
    }).catch(() => undefined);
    const checkpoint = await taskRunStore.getCheckpoint(this.taskId).catch(() => undefined);
    if (event && checkpoint) {
      await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: event.sequence, pendingWrite: undefined }).catch(() => undefined);
    }
    this.pendingWrite = undefined;
  }

  async emitEvent(actor: Actors, state: ExecutionState, eventDetails: string) {
    const event = new AgentEvent(actor, state, {
      taskId: this.taskId,
      step: this.nSteps,
      maxSteps: this.options.maxSteps,
      details: eventDetails,
    });
    await this.eventManager.emit(event);
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
  }

  async stop() {
    this.stopped = true;
    setTimeout(() => this.controller.abort(), 300);
  }
}

export class AgentStepInfo {
  stepNumber: number;
  maxSteps: number;

  constructor(params: { stepNumber: number; maxSteps: number }) {
    this.stepNumber = params.stepNumber;
    this.maxSteps = params.maxSteps;
  }
}

export class ActionResult {
  isDone: boolean;
  success: boolean;
  extractedContent: string | null;
  error: string | null;
  includeInMemory: boolean;
  interactedElement: DOMHistoryElement | null;
  sideEffectUnknown: boolean;

  constructor(params: Partial<ActionResult> = {}) {
    this.isDone = params.isDone ?? false;
    this.success = params.success ?? false;
    this.interactedElement = params.interactedElement ?? null;
    this.extractedContent = params.extractedContent ?? null;
    this.error = params.error ?? null;
    this.includeInMemory = params.includeInMemory ?? false;
    this.sideEffectUnknown = params.sideEffectUnknown ?? false;
  }
}

export type WrappedActionResult = ActionResult & {
  toolCallId: string;
};

export class StepMetadata {
  stepStartTime: number;
  stepEndTime: number;
  inputTokens: number;
  stepNumber: number;

  constructor(stepStartTime: number, stepEndTime: number, inputTokens: number, stepNumber: number) {
    this.stepStartTime = stepStartTime;
    this.stepEndTime = stepEndTime;
    this.inputTokens = inputTokens;
    this.stepNumber = stepNumber;
  }

  /**
   * Calculate step duration in seconds
   */
  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime;
  }
}

export const agentBrainSchema = z
  .object({
    evaluation_previous_goal: z.string(),
    memory: z.string(),
    next_goal: z.string(),
  })
  .describe('Current state of the agent');

export type AgentBrain = z.infer<typeof agentBrainSchema>;

// Make AgentOutput generic with Zod schema
export interface AgentOutput<T = unknown> {
  /**
   * The unique identifier for the agent
   */
  id: string;

  /**
   * The result of the agent's step
   */
  result?: T;
  /**
   * The error that occurred during the agent's action
   */
  error?: string;
}
