import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';
import { analytics } from '../services/analytics';
import type { ToolPolicy } from '../services/toolPolicy';
import { taskRunStore } from '@extension/storage';
import type { TaskCheckpoint, PlanStep } from '@extension/storage';
import { classifyFailure, recoveryAdvice } from './recovery';
import { advancePlan, mergePlan, normalizePlanSteps } from './plan';
import { TaskVerifier } from './roles/verifier';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  /** System-prompt fragment built from enabled and selected skills. */
  skillsInstructions?: string;
  /** Chat session ID used for replay history; taskId remains the durable run ID. */
  historySessionId?: string;
  toolPolicy?: ToolPolicy;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private readonly historySessionId: string;
  private readonly taskVerifier: TaskVerifier;
  private tasks: string[] = [];
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
      extraArgs?.toolPolicy,
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.historySessionId = extraArgs?.historySessionId ?? taskId;
    this.taskVerifier = new TaskVerifier(plannerLLM);
    this.tasks.push(task);
    const skillsInstructions = extraArgs?.skillsInstructions?.trim() ?? '';
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep, skillsInstructions);
    this.plannerPrompt = new PlannerPrompt(skillsInstructions);

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  hydrateRuntime(checkpoint?: TaskCheckpoint) {
    if (!checkpoint) return;
    this.context.plan = [...checkpoint.plan];
    this.context.taskMemory.loadFacts(checkpoint.memory);
    this.context.approvedAction = checkpoint.approvedAction;
    this.context.pendingWrite = checkpoint.pendingWrite;
    if (checkpoint.nSteps !== undefined) this.context.nSteps = checkpoint.nSteps;
    if (checkpoint.replanCount !== undefined) this.context.replanCount = checkpoint.replanCount;
    if (checkpoint.startedAt !== undefined) this.context.startedAt = checkpoint.startedAt;
    if (checkpoint.finalAnswer !== undefined) this.context.finalAnswer = checkpoint.finalAnswer;
  }

  getPlan(): PlanStep[] { return this.context.plan.map(step => ({ ...step, evidenceIds: [...step.evidenceIds] })); }
  async switchToSafeActiveTabAfterClose(closedTabId: number): Promise<number | undefined> {
    const [activeTabs, allTabs] = await Promise.all([
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []),
      chrome.tabs.query({ lastFocusedWindow: true }).catch(() => []),
    ]);
    const ordered = [
      ...activeTabs,
      ...allTabs.filter(tab => !activeTabs.some(active => active.id === tab.id)),
    ];
    for (const tab of ordered) {
      if (tab.id === undefined || tab.id === closedTabId || !tab.url || tab.url.startsWith('chrome-extension://')) continue;
      try {
        await this.context.browserContext.switchTab(tab.id);
        return tab.id;
      } catch {
        // A candidate may be removed or denied by URL policy; continue to the next.
      }
    }
    return undefined;
  }

  async getActiveTabId(): Promise<number | undefined> {
    try {
      return (await this.context.browserContext.getCurrentPage()).tabId;
    } catch {
      return undefined;
    }
  }



  getRuntimeSnapshot() {
    const navigatorInfo = this.navigator.getRuntimeInfo();
    const plannerInfo = this.planner.getRuntimeInfo();
    return {
      memory: this.context.taskMemory.getFacts(),
      plan: this.getPlan(),
      step: this.context.nSteps,
      replanCount: this.context.replanCount,
      finalAnswer: this.context.finalAnswer,
      startedAt: this.context.startedAt,
      durationMs: Date.now() - this.context.startedAt,
      estimatedInputTokens: this.context.messageManager.getEstimatedTokenCount(),
      navigator: navigatorInfo,
      planner: plannerInfo,
      pendingWrite: this.context.pendingWrite,
      approvedAction: this.context.approvedAction,
    };
  }

  subscribeExecutionEvents(callback: EventCallback): () => void {
    return this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      const steps = this.context.plan.length ? this.context.plan : (planOutput.result.steps ?? []);
      const missingPlan = planOutput.result.web_task === true && steps.length === 0;
      const invalidStatus = steps.some(step => !['completed','skipped'].includes(step.status));
      const missingEvidence = planOutput.result.web_task && steps.some(step => step.status === 'completed' && step.evidenceIds.length === 0);
      const invalid = missingPlan || invalidStatus || missingEvidence;
      if (invalid) {
        logger.info('Planner marked done but required plan steps remain incomplete');
        return false;
      }
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  private async verifyCompletion(planOutput: AgentOutput<PlannerOutput> | null): Promise<boolean> {
    if (!this.checkTaskCompletion(planOutput)) return false;
    const webTask = planOutput?.result?.web_task === true;
    // Web tasks must not bypass deterministic evidence/step checks by returning
    // an empty plan. Non-web tasks are explicitly accepted by TaskVerifier.
    const evidence = await taskRunStore.getEvidence(this.context.taskId, 50).catch(() => []);
    try {
      const result = await this.taskVerifier.verify(
        this.tasks[this.tasks.length - 1],
        this.context.plan,
        evidence,
        webTask,
      );
      if (!result.passed) {
        await this.context.emitEvent(
          Actors.VERIFIER,
          ExecutionState.STEP_FAIL,
          '完成核验未通过：' + result.reason,
        );
        return false;
      }
      await this.context.emitEvent(
        Actors.VERIFIER,
        ExecutionState.STEP_OK,
        '完成核验通过' + (result.evidenceIds.length ? '，证据：' + result.evidenceIds.join(', ') : ''),
      );
      return true;
    } catch (error) {
      await this.context.emitEvent(
        Actors.VERIFIER,
        ExecutionState.STEP_FAIL,
        '完成核验异常：' + (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    const context = this.context;
    const isFreshRun = context.nSteps === 0 && context.replanCount === 0 && context.finalAnswer === null;
    if (isFreshRun) context.startedAt = Date.now();
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // Run planner periodically for guidance
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          navigatorDone = false;
          context.replanCount++;
          if (context.replanCount > context.options.maxReplans) {
            throw new MaxFailuresReachedError('达到最大重规划次数，停止自动循环');
          }
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (await this.verifyCompletion(latestPlanOutput)) {
            break;
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate();

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status with the same evidence/plan validation used by the planner gate.
      const isCompleted = await this.verifyCompletion(latestPlanOutput);

      if (isCompleted) {
        const finalMessage = await this.buildFinalAnswerWithEvidence(this.context.finalAnswer || this.context.taskId, latestPlanOutput?.result?.web_task === true);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
        const error = new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, error.message);
        void analytics.trackTaskFailed(this.context.taskId, analytics.categorizeError(error));
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.historySessionId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async buildFinalAnswerWithEvidence(answer: string, webTask: boolean): Promise<string> {
    if (!webTask) return answer;
    const evidence = await taskRunStore.getEvidence(this.context.taskId, 50).catch(() => []);
    if (!evidence.length) return answer + '\n\n来源未能持久化，结论请人工核验。';
    const requiredIds = new Set(this.context.plan.flatMap(step => step.evidenceIds));
    const selected = requiredIds.size ? evidence.filter(item => requiredIds.has(item.id)) : evidence;
    const citations = (selected.length ? selected : evidence)
      .slice(0, 20)
      .map(item =>
        '- ' + item.id + ' · ' + (item.title || '页面') + ' · ' + item.url +
        (item.pageNumber ? ' · 第' + item.pageNumber + '页' : ''),
      )
      .join('\n');
    return answer + '\n\n来源证据：\n' + citations;
  }

  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner(结构化输出偶发解析失败,自动重试一次)
      let planOutput = await this.planner.execute();
      if (!planOutput.result) {
        logger.info('Planner returned no result, retrying once...');
        planOutput = await this.planner.execute();
      }
      if (planOutput.result) {
        const normalized = normalizePlanSteps(planOutput.result.steps, planOutput.result.next_steps);
        this.context.plan = mergePlan(this.context.plan, normalized);
        this.context.messageManager.addPlan(
          JSON.stringify({ ...planOutput.result, steps: this.context.plan }),
          positionForPlan,
        );
        await taskRunStore.appendEvent(this.context.taskId, 'plan.updated', {
          steps: this.context.plan,
          replanCount: this.context.replanCount,
        }).catch(() => undefined);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      if (context.paused || context.stopped) return false;

      const navOutput = await this.navigator.execute();

      if (context.paused || context.stopped) return false;

      context.nSteps++;
      if (navOutput.error) throw new Error(navOutput.error);
      context.consecutiveFailures = 0;

      for (const result of context.actionResults) {
        if (result.error) {
          context.taskMemory.add(
            `动作执行出错:${String(result.error).slice(0, 150)}。后续避免重复同样的失败。`,
          );
        }
      }

      if (navOutput.result?.done) {
        this.context.plan = advancePlan(this.context.plan, true);
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);

      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }

      const failureClass = classifyFailure(error);
      context.taskMemory.add(
        `失败分类:${failureClass}。恢复策略:${recoveryAdvice(failureClass)}。`,
      );
      if (context.plan.some(step => step.status === 'running')) {
        context.plan = advancePlan(context.plan, false);
      }

      if (error instanceof URLNotAllowedError) {
        context.taskMemory.add(
          `目标 URL 被安全策略阻止(${String(error.message).slice(0, 120)})。chrome:// 等浏览器内部页面无法访问,请改用普通 http(s) 页面。`,
        );
      } else {
        context.taskMemory.add(
          `第 ${context.nSteps + 1} 步执行失败:${String(error).slice(0, 180)}。下一步必须改变方法,不要重复同样的操作。`,
        );
      }

      context.consecutiveFailures++;
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  getPendingWrite() {
    return this.context.pendingWrite;
  }

  clearPendingWrite() {
    this.context.pendingWrite = undefined;
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
