import 'webextension-polyfill';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
  analyticsSettingsStore,
} from '@extension/storage';
import { t } from '@extension/i18n';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { createLogger } from './log';
import { ExecutionState } from './agent/event/types';
import { createChatModel } from './agent/helper';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DEFAULT_AGENT_OPTIONS } from './agent/types';
import { SpeechToTextService } from './services/speechToText';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { analytics } from './services/analytics';
import { getSkillsSystemInstructions } from './services/skills';
import { extractPdfTextFromUrl } from './agent/pdf';
import { buildToolPolicy } from './services/toolPolicy';
import { taskRunStore } from '@extension/storage';
import { runController } from './task/run-controller';
import { resolveApproval } from './task/approval-gate';
import { resolveLocalPdfBytes } from './task/local-file-gate';
import { resolveUserRequest } from './task/user-gate';

const logger = createLogger('background');

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
let currentPort: chrome.runtime.Port | null = null;
let uiExecutorUnsubscribe: (() => void) | null = null;
const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');
const RUNTIME_PROTOCOL_VERSION = 1;

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// Listen for debugger detached event
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  console.log('Debugger detached:', source, reason);
  if (source.tabId) {
    await runController.handleDebuggerDetached(source.tabId, reason);
    if (reason === 'canceled_by_user') await browserContext.cleanup();
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
  void runController.handleTabClosed(tabId).finally(() => {
    currentExecutor = runController.getExecutor();
  });
});

logger.info('background loaded');
runController.configure(
  async run => {
    if (run.activeTabId === undefined) throw new Error('Task has no target tab');
    await browserContext.switchTab(run.activeTabId);
    return setupExecutor(run.id, run.goal, browserContext, run.skillIds);
  },
  async (_run, pendingWrite) => {
    if (pendingWrite.tabId === undefined) return false;
    await browserContext.switchTab(pendingWrite.tabId);
    const page = await browserContext.getCurrentPage();

    if (pendingWrite.toolName === 'close_tab') {
      const tab = await chrome.tabs.get(pendingWrite.tabId).catch(() => null);
      return !tab;
    }
    if (pendingWrite.toolName === 'go_to_url' || pendingWrite.toolName === 'open_tab') {
      return page.url() !== (pendingWrite.url || '');
    }
    if (pendingWrite.toolName === 'click_element' && pendingWrite.index !== undefined) {
      return page.verifyClickEffect(pendingWrite.index, pendingWrite.url || '');
    }
    if (
      pendingWrite.expectedValueHash &&
      pendingWrite.index !== undefined &&
      (pendingWrite.toolName === 'input_text' || pendingWrite.toolName === 'select_dropdown_option')
    ) {
      const value =
        pendingWrite.toolName === 'select_dropdown_option'
          ? await page.getSelectedOptionText(pendingWrite.index)
          : await page.getInputValue(pendingWrite.index);
      if (value === null) return false;
      const data = new TextEncoder().encode(JSON.stringify(value));
      const digest = await crypto.subtle.digest('SHA-256', data);
      const hash = Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
      return hash === pendingWrite.expectedValueHash;
    }
    return false;
  },
);
void runController.initialize().catch(error => logger.error('Failed to initialize task runtime:', error));
void taskRunStore.cleanupRetention().catch(error => logger.error('Failed to cleanup task runtime retention:', error));

// Initialize analytics
analytics.init().catch(error => {
  logger.error('Failed to initialize analytics:', error);
});

// Listen for analytics settings changes
analyticsSettingsStore.subscribe(() => {
  analytics.updateSettings().catch(error => {
    logger.error('Failed to update analytics settings:', error);
  });
});

// Listen for simple messages (e.g., from options page)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'resolve_local_file_read' && msg.runId && msg.requestId && msg.dataBase64) {
    resolveLocalPdfBytes({ runId: msg.runId, requestId: msg.requestId, dataBase64: msg.dataBase64 })
      .then(ok => sendResponse({ ok }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg?.type === 'debug_pdf_extract' && msg.url) {
    extractPdfTextFromUrl(msg.url, { cMapUrl: chrome.runtime.getURL('cmaps/'), maxChars: 3000 })
      .then(r =>
        sendResponse({
          ok: true,
          numPages: r.numPages,
          extractedPages: r.extractedPages,
          chars: r.text.length,
          head: r.text.slice(0, 300),
        }),
      )
      .catch(e => sendResponse({ ok: false, error: String(e).slice(0, 300) }));
    return true; // 异步响应
  }
});

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    const senderUrl = port.sender?.url;
    const senderId = port.sender?.id;

    if (!senderUrl || senderId !== chrome.runtime.id || senderUrl !== SIDE_PANEL_URL) {
      logger.warning('Blocked unauthorized side-panel-connection', senderId, senderUrl);
      port.disconnect();
      return;
    }

    currentPort = port;

    port.onMessage.addListener(async message => {
      try {
        switch (message.type) {
          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            logger.info('new_task', message.tabId, message.task);
            await browserContext.switchTab(message.tabId);
            const run = await taskRunStore.getRun(message.taskId).catch(() => undefined);
            if (run) {
              return port.postMessage({ type: 'error', error: `任务 ${message.taskId} 已存在，请使用继续/恢复操作` });
            }
            await runController.createAndStart({
              runId: message.taskId,
              sessionId: message.taskId,
              goal: message.task,
              tabId: message.tabId,
              skillIds: message.skillIds || [],
              createExecutor: async taskRun => {
                await browserContext.switchTab(message.tabId);
                return setupExecutor(taskRun.id, taskRun.goal, browserContext, message.skillIds || []);
              },
            });
            currentExecutor = runController.getExecutor();
            if (currentExecutor) subscribeToExecutorEvents(currentExecutor);
            break;
          }

          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            await browserContext.switchTab(message.tabId);
            const run = await taskRunStore.getRun(message.taskId).catch(() => undefined);
            if (!run) return port.postMessage({ type: 'error', error: '原任务不存在，请重新创建任务' });

            await runController.continueWithFollowUp(run.id, message.task);
            currentExecutor = runController.getExecutor();
            if (currentExecutor) subscribeToExecutorEvents(currentExecutor);
            break;
          }

          case 'user_intervention_response': {
            if (!message.runId || !message.nonce || typeof message.answer !== 'string') {
              return port.postMessage({ type: 'error', error: '无效的用户介入响应' });
            }
            const ok = await resolveUserRequest({ runId: message.runId, nonce: message.nonce, answer: message.answer });
            if (ok) {
              if (!runController.getExecutor()) {
                await runController.resume(message.runId).catch(error => logger.warning('User response accepted; resume deferred:', error));
                currentExecutor = runController.getExecutor();
                if (currentExecutor) subscribeToExecutorEvents(currentExecutor);
              }
              return port.postMessage({ type: 'success' });
            }
            return port.postMessage({ type: 'error', error: '用户介入请求已过期或无效' });
          }

          case 'approve_action':
          case 'reject_action': {
            if (!message.runId || !message.nonce || !message.parameterHash) {
              return port.postMessage({ type: 'error', error: 'Invalid approval request' });
            }
            const ok = await resolveApproval({
              runId: message.runId,
              nonce: message.nonce,
              parameterHash: message.parameterHash,
              approved: message.type === 'approve_action',
            });
            if (ok && message.type === 'approve_action' && !runController.getExecutor()) {
              await runController.resume(message.runId).catch(error => logger.warning('Approval accepted; resume deferred:', error));
              currentExecutor = runController.getExecutor();
              if (currentExecutor) subscribeToExecutorEvents(currentExecutor);
            }
            return port.postMessage({ type: ok ? 'success' : 'error', error: ok ? undefined : 'Approval is stale or invalid' });
          }

          case 'get_run_snapshot': {
            if (!message.runId) return port.postMessage({ type: 'error', error: 'Missing runId' });
            try {
              const snapshot = await runController.snapshot(message.runId, Number(message.afterSequence || 0));
              return port.postMessage({ type: 'run_snapshot', version: RUNTIME_PROTOCOL_VERSION, snapshot });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
            }
          }

          case 'get_run_events_before': {
            if (!message.runId) return port.postMessage({ type: 'error', error: 'Missing runId' });
            try {
              const events = await taskRunStore.getEventsBefore(
                message.runId,
                Number(message.beforeSequence || Number.MAX_SAFE_INTEGER),
                Math.min(Number(message.limit || 100), 200),
              );
              return port.postMessage({ type: 'run_events_before', version: RUNTIME_PROTOCOL_VERSION, events });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
            }
          }

          case 'get_run_events': {
            if (!message.runId) return port.postMessage({ type: 'error', error: 'Missing runId' });
            try {
              const events = await taskRunStore.getEvents(
                message.runId,
                Number(message.afterSequence || 0),
                Math.min(Number(message.limit || 200), 500),
              );
              return port.postMessage({ type: 'run_events', version: RUNTIME_PROTOCOL_VERSION, events });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
            }
          }

          case 'get_run_evidence': {
            if (!message.runId) return port.postMessage({ type: 'error', error: 'Missing runId' });
            try {
              const evidence = await taskRunStore.getEvidence(message.runId, Number(message.limit || 200));
              return port.postMessage({ type: 'run_evidence', evidence });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
            }
          }

          case 'subscribe_run': {
            if (!message.runId) return port.postMessage({ type: 'error', error: 'Missing runId' });
            const run = await taskRunStore.getRun(message.runId);
            if (!run) return port.postMessage({ type: 'error', error: 'Unknown task run' });
            const executor = runController.getExecutor();
            if (executor && runController.getRunId() === message.runId) {
              if (uiExecutorUnsubscribe) uiExecutorUnsubscribe();
              uiExecutorUnsubscribe = subscribeToExecutorEvents(executor);
            }
            const snapshot = await runController.snapshot(message.runId, Number(message.afterSequence || 0));
            for (const event of snapshot.events) {
              port.postMessage({
                type: 'run_event',
                version: RUNTIME_PROTOCOL_VERSION,
                event: {
                  id: event.id,
                  runId: event.runId,
                  sequence: event.sequence,
                  type: event.type,
                  timestamp: event.timestamp,
                  payload: event.payload,
                  actor: event.payload && typeof event.payload === 'object' && 'actor' in event.payload ? (event.payload as any).actor : 'system',
                  state: event.type,
                  data: event.payload && typeof event.payload === 'object' && 'data' in event.payload ? (event.payload as any).data : { taskId: run.id, step: 0, maxSteps: 0, details: '' },
                  timestamp: event.timestamp,
                },
              });
            }
            return port.postMessage({ type: 'subscribed_run', version: RUNTIME_PROTOCOL_VERSION, runId: message.runId });
          }

          case 'cancel_task': {
            try {
              await runController.cancel();
              currentExecutor = null;
              return port.postMessage({ type: 'success' });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : t('bg_errors_noRunningTask') });
            }
          }

          case 'resume_task': {
            try {
              await runController.resume(message.taskId);
              currentExecutor = runController.getExecutor();
              if (currentExecutor) subscribeToExecutorEvents(currentExecutor);
              return port.postMessage({ type: 'success' });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : t('bg_cmd_resumeTask_noTask') });
            }
          }

          case 'pause_task': {
            try {
              await runController.pause();
              return port.postMessage({ type: 'success' });
            } catch (error) {
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : t('bg_errors_noRunningTask') });
            }
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            const page = await browserContext.switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              const browserState = await browserContext.getState(true);
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: t('bg_cmd_state_printed') });
            } catch (error) {
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: t('bg_cmd_state_failed') });
            }
          }

          case 'nohighlight': {
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: t('bg_cmd_nohighlight_ok') });
          }

          case 'speech_to_text': {
            try {
              if (!message.audio) {
                return port.postMessage({
                  type: 'speech_to_text_error',
                  error: t('bg_cmd_stt_noAudioData'),
                });
              }

              logger.info('Processing speech-to-text request...');

              // Get all providers for speech-to-text service
              const providers = await llmProviderStore.getAllProviders();

              // Create speech-to-text service with all providers
              const speechToTextService = await SpeechToTextService.create(providers);

              // Extract base64 audio data (remove data URL prefix if present)
              let base64Audio = message.audio;
              if (base64Audio.startsWith('data:')) {
                base64Audio = base64Audio.split(',')[1];
              }

              // Transcribe audio
              const transcribedText = await speechToTextService.transcribeAudio(base64Audio);

              logger.info('Speech-to-text completed successfully');
              return port.postMessage({
                type: 'speech_to_text_result',
                text: transcribedText,
              });
            } catch (error) {
              logger.error('Speech-to-text failed:', error);
              return port.postMessage({
                type: 'speech_to_text_error',
                error: error instanceof Error ? error.message : t('bg_cmd_stt_failed'),
              });
            }
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            if (!message.historySessionId) return port.postMessage({ type: 'error', error: t('bg_cmd_replay_noHistory') });
            try {
              await browserContext.switchTab(message.tabId);
              const existing = await taskRunStore.getRun(message.taskId).catch(() => undefined);
              if (existing) return port.postMessage({ type: 'error', error: '回放任务已经存在' });
              await runController.startReplay(message.taskId, message.historySessionId, message.task || ('Replay ' + message.historySessionId), message.tabId);
              currentExecutor = runController.getExecutor();
              if (currentExecutor) subscribeToExecutorEvents(currentExecutor);
            } catch (error) {
              logger.error('Replay failed:', error);
              return port.postMessage({ type: 'error', error: error instanceof Error ? error.message : t('bg_cmd_replay_failed') });
            }
            break;
          }

          default:
            return port.postMessage({ type: 'error', error: t('errors_cmd_unknown', [message.type]) });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : t('errors_unknown'),
        });
      }
    });

    port.onDisconnect.addListener(() => {
      // Closing the Side Panel only disconnects the UI. The durable task continues.
      console.log('Side panel disconnected');
      currentPort = null;
    });
  }
});

async function setupExecutor(taskId: string, task: string, browserContext: BrowserContext, skillIds: string[] = []) {
  const providers = await llmProviderStore.getAllProviders();
  // if no providers, need to display the options page
  if (Object.keys(providers).length === 0) {
    throw new Error(t('bg_setup_noApiKeys'));
  }

  // Clean up any legacy validator settings for backward compatibility
  await agentModelStore.cleanupLegacyValidatorSettings();

  const agentModels = await agentModelStore.getAllAgentModels();
  // verify if every provider used in the agent models exists in the providers
  for (const agentModel of Object.values(agentModels)) {
    if (!providers[agentModel.provider]) {
      throw new Error(t('bg_setup_noProvider', [agentModel.provider]));
    }
  }

  const navigatorModel = agentModels[AgentNameEnum.Navigator];
  if (!navigatorModel) {
    throw new Error(t('bg_setup_noNavigatorModel'));
  }
  // Log the provider config being used for the navigator
  const navigatorProviderConfig = providers[navigatorModel.provider];
  const navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);

  let plannerLLM: BaseChatModel | null = null;
  const plannerModel = agentModels[AgentNameEnum.Planner];
  if (plannerModel) {
    // Log the provider config being used for the planner
    const plannerProviderConfig = providers[plannerModel.provider];
    plannerLLM = createChatModel(plannerProviderConfig, plannerModel);
  }

  // Apply firewall settings to browser context
  const firewall = await firewallStore.getFirewall();
  if (firewall.enabled) {
    browserContext.updateConfig({
      allowedUrls: firewall.allowList,
      deniedUrls: firewall.denyList,
    });
  } else {
    browserContext.updateConfig({
      allowedUrls: [],
      deniedUrls: [],
    });
  }

  const generalSettings = await generalSettingsStore.getSettings();
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    displayHighlights: false, // 元素高亮框已按需求移除
  });

  // 任务标签页由 new_task/follow_up_task/replay 在创建 Executor 前显式绑定。
  // 不再静默读取活动标签页，避免任务在用户切换窗口后漂移到另一页面。

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    skillsInstructions: await getSkillsSystemInstructions(skillIds),
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
    },
    generalSettings: generalSettings,
    toolPolicy: await buildToolPolicy(skillIds),
  });

  return executor;
}

// Update subscribeToExecutorEvents to use port
function subscribeToExecutorEvents(executor: Executor): () => void {
  // Clear previous event listeners to prevent multiple subscriptions
  if (uiExecutorUnsubscribe) uiExecutorUnsubscribe();
  uiExecutorUnsubscribe = executor.subscribeExecutionEvents(async event => {
    try {
      if (currentPort) {
        currentPort.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      uiExecutorUnsubscribe?.();
      uiExecutorUnsubscribe = null;
      currentExecutor = null;
      await runController.clearIfTerminal();
    }
  });
  return uiExecutorUnsubscribe ?? (() => undefined);
}
