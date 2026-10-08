/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from 'react';
import { FiArrowLeft, FiSettings } from 'react-icons/fi';
import { PiPlusBold } from 'react-icons/pi';
import { GrHistory } from 'react-icons/gr';
import { type Message, Actors, chatHistoryStore, agentModelStore, generalSettingsStore, skillStore, type Skill } from '@extension/storage';
import { t } from '@extension/i18n';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ChatHistoryList from './components/ChatHistoryList';
import { TaskPlanPanel } from './components/TaskPlanPanel';
import { TaskTimeline } from './components/TaskTimeline';
import { EvidenceList, type EvidenceItem } from './components/EvidenceList';
import { ApprovalCard } from './components/ApprovalCard';
import { UserRequestCard } from './components/UserRequestCard';
import { EventType, type AgentEvent, ExecutionState } from './types/event';
import './SidePanel.css';

// Declare chrome API types
declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

const SidePanel = () => {
  const progressMessage = 'Showing progress...';
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null); // null = loading, false = no models, true = has models
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [approvalAction, setApprovalAction] = useState<any | null>(null);
  const [userRequest, setUserRequest] = useState<any | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<any | null>(null);
  const [runEvidence, setRunEvidence] = useState<EvidenceItem[]>([]);
  const requestRunSnapshot = useCallback((runId: string) => {
    runIdRef.current = runId;
    lastRunSequenceRef.current = 0;
    portRef.current?.postMessage({ type: 'get_run_snapshot', runId, afterSequence: 0 });
    portRef.current?.postMessage({ type: 'subscribe_run', runId, afterSequence: 0 });
    portRef.current?.postMessage({ type: 'get_run_evidence', runId, limit: 200 });
  }, []);
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [manualSkills, setManualSkills] = useState<Skill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastRunSequenceRef = useRef(0);

  // 本地 PDF 必须对应当前浏览器已打开的 file:// URL，并且扩展已获得文件 URL 访问权限。
  const readAuthorizedLocalFile = useCallback(async (path: string, requestId: string, runId?: string) => {
    if (!path.startsWith('file://') || !/\.pdf(?:[?#]|$)/i.test(path)) throw new Error('只允许读取已打开的 file:// 文件');
    const tabs = await chrome.tabs.query({ url: path });
    if (!tabs.some(tab => tab.url === path)) {
      throw new Error('该本地 PDF 未在浏览器中打开，不能读取任意文件路径');
    }
    const allowed = await new Promise<boolean>(resolve => chrome.extension.isAllowedFileSchemeAccess(resolve));
    if (!allowed) {
      throw new Error('未开启“允许访问文件网址”，请在扩展详情中开启后重试');
    }
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', path);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 60_000;
      xhr.onload = () => {
        if (xhr.status !== 200 && xhr.status !== 0) {
          reject(new Error('读取失败 HTTP ' + xhr.status));
          return;
        }
        resolve(xhr.response);
      };
      xhr.onerror = () => reject(new Error('读取失败(可能未开启文件访问权限)'));
      xhr.ontimeout = () => reject(new Error('本地 PDF 读取超时'));
      xhr.send();
    });
    const bytes = new Uint8Array(data);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('本地 PDF 超过 10MB 限制');
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
    }
    const dataBase64 = btoa(binary);
    return { type: 'resolve_local_file_read', runId: runId || sessionIdRef.current, requestId, dataBase64 };
  }, []);

  // 接收后台的敏感动作/用户介入/本地文件请求。
  useEffect(() => {
    const listener = (msg: { type?: string; action?: any; request?: any }) => {
      if (msg?.type === 'approval_required') {
        setApprovalAction(msg.action);
        return;
      }
      if (msg?.type === 'user_intervention_required') {
        setUserRequest(msg.request);
        return;
      }
      if (msg?.type === 'local_file_read_requested' && msg.request) {
        void readAuthorizedLocalFile(msg.request.path, msg.request.requestId, msg.request.runId)
          .then(response => chrome.runtime.sendMessage(response))
          .catch(error =>
            chrome.runtime.sendMessage({
              type: 'resolve_local_file_read',
              runId: msg.request.runId,
              requestId: msg.request.requestId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [readAuthorizedLocalFile]);

  const setInputTextRef = useRef<((text: string) => void) | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  // Check for dark mode preference
  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener('change', handleChange);
    return () => darkModeMediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Check if models are configured
  const checkModelConfiguration = useCallback(async () => {
    try {
      const configuredAgents = await agentModelStore.getConfiguredAgents();

      // Check if at least one agent (preferably Navigator) is configured
      const hasAtLeastOneModel = configuredAgents.length > 0;
      setHasConfiguredModels(hasAtLeastOneModel);
    } catch (error) {
      console.error('Error checking model configuration:', error);
      setHasConfiguredModels(false);
    }
  }, []);

  // Load general settings to check if replay is enabled
  const loadGeneralSettings = useCallback(async () => {
    try {
      const settings = await generalSettingsStore.getSettings();
      setReplayEnabled(settings.replayHistoricalTasks);
    } catch (error) {
      console.error('Error loading general settings:', error);
      setReplayEnabled(false);
    }
  }, []);

  // Check model configuration on mount
  useEffect(() => {
    checkModelConfiguration();
    loadGeneralSettings();
  }, [checkModelConfiguration, loadGeneralSettings]);

  useEffect(() => {
    let cancelled = false;
    const loadManualSkills = async () => {
      try {
        const skills = (await skillStore.getSkills()).filter(skill => skill.enabled && skill.mode === 'manual');
        if (!cancelled) {
          setManualSkills(skills);
          setSelectedSkillIds(prev => prev.filter(id => skills.some(skill => skill.id === id)));
        }
      } catch (error) {
        console.error('Failed to load manual skills:', error);
      }
    };
    void loadManualSkills();
    return () => {
      cancelled = true;
    };
  }, []);



  // Re-check model configuration when the side panel becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Panel became visible, re-check configuration and settings
        checkModelConfiguration();
        loadGeneralSettings();
      }
    };

    const handleFocus = () => {
      // Panel gained focus, re-check configuration and settings
      checkModelConfiguration();
      loadGeneralSettings();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkModelConfiguration, loadGeneralSettings]);

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    isReplayingRef.current = isReplaying;
  }, [isReplaying]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    // Don't save progress messages
    const isProgressMessage = newMessage.content === progressMessage;

    setMessages(prev => {
      const filteredMessages = prev.filter((msg, idx) => !(msg.content === progressMessage && idx === prev.length - 1));
      return [...filteredMessages, newMessage];
    });

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    console.log('sessionId', effectiveSessionId);

    // Save message to storage if we have a session and it's not a progress message
    if (effectiveSessionId && !isProgressMessage) {
      chatHistoryStore
        .addMessage(effectiveSessionId, newMessage)
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  const handleTaskState = useCallback(
    (event: AgentEvent) => {
      const { actor, state, timestamp, data } = event;
      const content = data?.details;
      let skip = true;
      let displayProgress = false;

      switch (actor) {
        case Actors.SYSTEM:
          switch (state) {
            case ExecutionState.TASK_START:
              // Reset historical session flag when a new task starts
              setIsHistoricalSession(false);
              break;
            case ExecutionState.TASK_OK:
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              break;
            case ExecutionState.TASK_FAIL:
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              break;
            case ExecutionState.TASK_CANCEL:
              setIsFollowUpMode(false);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              break;
            case ExecutionState.TASK_PAUSE:
              break;
            case ExecutionState.TASK_RESUME:
              break;
            default:
              console.error('Invalid task state', state);
              return;
          }
          break;
        case Actors.USER:
          break;
        case Actors.PLANNER:
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            default:
              console.error('Invalid step state', state);
              return;
          }
          break;
        case Actors.NAVIGATOR:
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              displayProgress = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              displayProgress = false;
              break;
            case ExecutionState.STEP_CANCEL:
              displayProgress = false;
              break;
            case ExecutionState.ACT_START:
              if (content !== 'cache_content') {
                // skip to display caching content
                skip = false;
              }
              break;
            case ExecutionState.ACT_OK:
              skip = !isReplayingRef.current;
              break;
            case ExecutionState.ACT_FAIL:
              skip = false;
              break;
            default:
              console.error('Invalid action', state);
              return;
          }
          break;
        case Actors.VALIDATOR:
          // Handle legacy validator events from historical messages
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            default:
              console.error('Invalid validation', state);
              return;
          }
          break;
        default:
          console.error('Unknown actor', actor);
          return;
      }

      if (!skip) {
        let displayContent = content || '';
        // SW 端旧版本可能直发动作原名 "done",UI 层统一兜底为中文
        if (actor === Actors.NAVIGATOR && displayContent.trim().toLowerCase() === 'done') {
          displayContent = '任务已完成';
        }
        appendMessage({
          actor,
          content: displayContent,
          timestamp: timestamp,
        });
      }

      if (displayProgress) {
        appendMessage({
          actor,
          content: progressMessage,
          timestamp: timestamp,
        });
      }
    },
    [appendMessage],
  );

  // Stop heartbeat and close connection
  const stopConnection = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (portRef.current) {
      portRef.current.disconnect();
      portRef.current = null;
    }
  }, []);

  // Setup connection management
  const setupConnection = useCallback(() => {
    // Only setup if no existing connection
    if (portRef.current) {
      return;
    }

    try {
      portRef.current = chrome.runtime.connect({ name: 'side-panel-connection' });

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      portRef.current.onMessage.addListener((message: any) => {
        // Add type checking for message
        if (message && message.type === EventType.EXECUTION) {
          if (message.data?.taskId === runIdRef.current && message.runtimeEvent && typeof message.sequence === 'number') {
            if (message.sequence > lastRunSequenceRef.current) {
              lastRunSequenceRef.current = message.sequence;
              const runtimeEvent = { ...message };
              setRunSnapshot((prev: any) =>
                prev ? { ...prev, events: [...(prev.events || []).filter((e: any) => e.sequence !== message.sequence), runtimeEvent].sort((a: any,b: any) => a.sequence-b.sequence).slice(-500) } : prev,
              );
            }
          }
          handleTaskState(message);
        } else if (message && message.type === 'run_snapshot') {
          setRunSnapshot(message.snapshot);
          const snapshotEvents = message.snapshot?.events || [];
          lastRunSequenceRef.current = snapshotEvents.length ? Math.max(...snapshotEvents.map((e: any) => e.sequence)) : Number(message.afterSequence || 0);
          setTimelineHasMore(snapshotEvents.length > 0 && snapshotEvents[0].sequence > 1);
          if (message.snapshot?.checkpoint?.pendingAction) setApprovalAction(message.snapshot.checkpoint.pendingAction);
          if (message.snapshot?.checkpoint?.pendingUserRequest) setUserRequest(message.snapshot.checkpoint.pendingUserRequest);
          const pendingFile = message.snapshot?.checkpoint?.pendingFileRead;
          if (pendingFile) {
            void readAuthorizedLocalFile(pendingFile.path, pendingFile.requestId, pendingFile.runId)
              .then(response => chrome.runtime.sendMessage(response))
              .catch(error => chrome.runtime.sendMessage({
                type: 'resolve_local_file_read',
                runId: pendingFile.runId,
                requestId: pendingFile.requestId,
                error: error instanceof Error ? error.message : String(error),
              }));
          }
        } else if (message && message.type === 'run_event') {
          const event = message.event;
          if (event?.runId === runIdRef.current && event.sequence > lastRunSequenceRef.current) {
            lastRunSequenceRef.current = event.sequence;
            setRunSnapshot((prev: any) => prev ? { ...prev, events: [...(prev.events || []), event].slice(-500) } : prev);
          }
          // Durable replay events are shown in the runtime timeline; chat messages are restored from chat history.
        } else if (message && message.type === 'approval_required') {
          setApprovalAction(message.action);
        } else if (message && message.type === 'user_intervention_required') {
          setUserRequest(message.request);
        } else if (message && message.type === 'run_evidence') {
          setRunEvidence(message.evidence || []);
        } else if (message && message.type === 'run_events_before') {
          const events = message.events || [];
          setRunSnapshot((prev: any) => prev ? { ...prev, events: [...events, ...(prev.events || [])] } : prev);
          setTimelineHasMore(events.length > 0 && events[0]?.sequence > 1);
        } else if (message && message.type === 'error') {
          // Handle error messages from service worker
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('errors_unknown'),
            timestamp: Date.now(),
          });
          setInputEnabled(true);
          setShowStopButton(false);
        } else if (message && message.type === 'speech_to_text_result') {
          // Handle speech-to-text result
          if (message.text && setInputTextRef.current) {
            setInputTextRef.current(message.text);
          }
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'speech_to_text_error') {
          // Handle speech-to-text error
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('chat_stt_recognitionFailed'),
            timestamp: Date.now(),
          });
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'heartbeat_ack') {
          console.log('Heartbeat acknowledged');
        }
      });

      portRef.current.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Connection disconnected', error ? `Error: ${error.message}` : '');
        portRef.current = null;
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        setInputEnabled(true);
        setShowStopButton(false);
      });

      if (runIdRef.current) {
        requestRunSnapshot(runIdRef.current);
      } else if (sessionIdRef.current) {
        void chrome.runtime.sendMessage({ type: 'get_latest_run_for_session', sessionId: sessionIdRef.current }, response => {
          if (response?.ok && response.run?.id) requestRunSnapshot(response.run.id);
        });
      }

      // Setup heartbeat interval
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = window.setInterval(() => {
        if (portRef.current?.name === 'side-panel-connection') {
          try {
            portRef.current.postMessage({ type: 'heartbeat' });
          } catch (error) {
            console.error('Heartbeat failed:', error);
            stopConnection(); // Stop connection if heartbeat fails
          }
        } else {
          stopConnection(); // Stop if port is invalid
        }
      }, 25000);
    } catch (error) {
      console.error('Failed to establish connection:', error);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_conn_serviceWorker'),
        timestamp: Date.now(),
      });
      // Clear any references since connection failed
      portRef.current = null;
    }
  }, [handleTaskState, appendMessage, stopConnection, readAuthorizedLocalFile, requestRunSnapshot]);

  // Add safety check for message sending
  const sendMessage = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (message: any) => {
      if (portRef.current?.name !== 'side-panel-connection') {
        throw new Error('No valid connection available');
      }
      try {
        portRef.current.postMessage(message);
      } catch (error) {
        console.error('Failed to send message:', error);
        stopConnection(); // Stop connection when message sending fails
        throw error;
      }
    },
    [stopConnection],
  );

  useEffect(() => {
    setupConnection();
    return () => stopConnection();
  }, [setupConnection, stopConnection]);

  // Handle replay command
  const handleReplay = async (historySessionId: string): Promise<void> => {
    try {
      // Check if replay is enabled in settings
      if (!replayEnabled) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_disabled'),
          timestamp: Date.now(),
        });
        return;
      }

      // Check if history exists using loadAgentStepHistory
      const historyData = await chatHistoryStore.loadAgentStepHistory(historySessionId);
      if (!historyData) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_noHistory', historySessionId.substring(0, 20)),
          timestamp: Date.now(),
        });
        return;
      }

      // Get current tab ID
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      // Clear messages if we're in a historical session
      if (isHistoricalSession) {
        setMessages([]);
      }

      // Create a new chat session for this replay task
      const newSession = await chatHistoryStore.createSession(`Replay of ${historySessionId.substring(0, 20)}...`);
      console.log('newSession for replay', newSession);

      // Store the new session ID in both state and ref
      const newTaskId = newSession.id;
      setCurrentSessionId(newTaskId);
      sessionIdRef.current = newTaskId;

      // Send replay command to background
      setInputEnabled(false);
      setShowStopButton(true);

      // Reset follow-up mode and historical session flags
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);

      const userMessage = {
        actor: Actors.USER,
        content: `/replay ${historySessionId}`,
        timestamp: Date.now(),
      };

      // Add the user message to the new session
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send replay command to background with the task from history
      portRef.current?.postMessage({
        type: 'replay',
        taskId: newTaskId,
        tabId: tabId,
        historySessionId: historySessionId,
        task: historyData.task, // Add the task from history
      });

      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_starting', historyData.task),
        timestamp: Date.now(),
      });
      setIsReplaying(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_failed', errorMessage),
        timestamp: Date.now(),
      });
    }
  };

  // Handle chat commands that start with /
  const handleCommand = async (command: string): Promise<boolean> => {
    try {
      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Handle different commands
      if (command === '/state') {
        portRef.current?.postMessage({
          type: 'state',
        });
        return true;
      }

      if (command === '/nohighlight') {
        portRef.current?.postMessage({
          type: 'nohighlight',
        });
        return true;
      }

      if (command.startsWith('/replay ')) {
        // Parse replay command: /replay <historySessionId>
        // Handle multiple spaces by filtering out empty strings
        const parts = command.split(' ').filter(part => part.trim() !== '');
        if (parts.length !== 2) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: t('chat_replay_invalidArgs'),
            timestamp: Date.now(),
          });
          return true;
        }

        const historySessionId = parts[1];
        await handleReplay(historySessionId);
        return true;
      }

      // Unsupported command
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_cmd_unknown', command),
        timestamp: Date.now(),
      });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Command error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      return true;
    }
  };

  const handleSendMessage = async (text: string, displayText?: string) => {
    console.log('handleSendMessage', text);
    const trimmedText = text.trim();
    if (!trimmedText) return;

    if (trimmedText.startsWith('/')) {
      const wasHandled = await handleCommand(trimmedText);
      if (wasHandled) return;
    }

    if (isHistoricalSession) {
      console.log('Cannot send messages in historical sessions');
      return;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab found');

      setInputEnabled(false);
      setShowStopButton(true);

      let parentRunId: string | undefined;
      let useFollowUp = isFollowUpMode;

      if (!isFollowUpMode) {
        const titleText = displayText || text;
        const newSession = await chatHistoryStore.createSession(
          titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
        );
        const sessionId = newSession.id;
        const runId = crypto.randomUUID();
        setCurrentSessionId(sessionId);
        sessionIdRef.current = sessionId;
        runIdRef.current = runId;
      } else if (!runIdRef.current) {
        runIdRef.current = runSnapshot?.run?.id ?? crypto.randomUUID();
      }

      if (isFollowUpMode && ['completed', 'failed', 'cancelled'].includes(runSnapshot?.run?.status)) {
        parentRunId = runIdRef.current ?? undefined;
        runIdRef.current = crypto.randomUUID();
        useFollowUp = false;
      }

      const userMessage = {
        actor: Actors.USER,
        content: displayText || text,
        timestamp: Date.now(),
      };
      appendMessage(userMessage, sessionIdRef.current);

      if (!portRef.current) setupConnection();

      if (useFollowUp) {
        await sendMessage({
          type: 'follow_up_task',
          task: text,
          taskId: runIdRef.current,
          runId: runIdRef.current,
          sessionId: sessionIdRef.current,
          tabId,
          skillIds: selectedSkillIds,
        });
      } else {
        await sendMessage({
          type: 'new_task',
          task: text,
          taskId: runIdRef.current,
          runId: runIdRef.current,
          sessionId: sessionIdRef.current,
          parentRunId,
          tabId,
          skillIds: selectedSkillIds,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setInputEnabled(true);
      setShowStopButton(false);
      stopConnection();
    }
  };
  const handleStopTask = async () => {
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
        taskId: runIdRef.current,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    setInputEnabled(true);
    setShowStopButton(false);
  };

  const handleNewChat = () => {
    // Clear messages and start a new chat
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    runIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    setIsFollowUpMode(false);
    setIsHistoricalSession(false);

    // Disconnect any existing connection
    stopConnection();
  };

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setMessages([]);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        sessionIdRef.current = fullSession.id;
        runIdRef.current = null;
        setRunSnapshot(null);
        setRunEvidence([]);
        setApprovalAction(null);
        setUserRequest(null);
        setMessages(fullSession.messages);
        setIsFollowUpMode(false);
        setIsHistoricalSession(true); // Mark this as a historical session
        console.log('history session selected', sessionId);
      }
      setShowHistory(false);
      if (!portRef.current) {
        setupConnection();
      } else if (sessionIdRef.current) {
        void chrome.runtime.sendMessage({ type: 'get_latest_run_for_session', sessionId: sessionIdRef.current }, response => {
          if (response?.ok && response.run?.id) requestRunSnapshot(response.run.id);
        });
      }
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop recording if active
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear recording timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      stopConnection();
    };
  }, [stopConnection]);

  // Scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleMicClick = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear the timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      setIsRecording(false);
      return;
    }

    try {
      // First check if permission is already granted
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });

      if (permissionStatus.state === 'denied') {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_stt_microphone_permissionDenied'),
          timestamp: Date.now(),
        });
        return;
      }

      // If permission is not granted, open permission page
      if (permissionStatus.state !== 'granted') {
        const permissionUrl = chrome.runtime.getURL('permission/index.html');

        // Open permission page in a new window
        chrome.windows.create(
          {
            url: permissionUrl,
            type: 'popup',
            width: 500,
            height: 600,
          },
          createdWindow => {
            if (createdWindow?.id) {
              // Listen for window close to check permission status
              chrome.windows.onRemoved.addListener(function onWindowClose(windowId) {
                if (windowId === createdWindow.id) {
                  chrome.windows.onRemoved.removeListener(onWindowClose);
                  // Check permission status after window closes
                  setTimeout(async () => {
                    try {
                      const newPermissionStatus = await navigator.permissions.query({
                        name: 'microphone' as PermissionName,
                      });
                      // Only retry if permission was granted
                      if (newPermissionStatus.state === 'granted') {
                        handleMicClick();
                      }
                      // If denied or prompt, do nothing - let user manually try again
                    } catch (error) {
                      console.error('Failed to check permission status:', error);
                    }
                  }, 500);
                }
              });
            }
          },
        );
        return;
      }

      // Permission granted - proceed with recording
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Clear previous audio chunks
      audioChunksRef.current = [];

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      // Handle data available event
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle stop event
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());

        if (audioChunksRef.current.length > 0) {
          // Create audio blob
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

          // Convert blob to base64
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64Audio = reader.result as string;

            // Setup connection if not exists
            if (!portRef.current) {
              setupConnection();
            }

            // Send audio to backend for speech-to-text conversion
            try {
              setIsProcessingSpeech(true);
              portRef.current?.postMessage({
                type: 'speech_to_text',
                audio: base64Audio,
              });
            } catch (error) {
              console.error('Failed to send audio for speech-to-text:', error);
              appendMessage({
                actor: Actors.SYSTEM,
                content: t('chat_stt_processingFailed'),
                timestamp: Date.now(),
              });
              setIsRecording(false);
              setIsProcessingSpeech(false);
            }
          };
          reader.readAsDataURL(audioBlob);
        }
      };

      // Set up 2-minute duration limit
      const maxDuration = 2 * 60 * 1000;
      recordingTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
        setIsProcessingSpeech(true);
        recordingTimerRef.current = null;
      }, maxDuration);

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error accessing microphone:', error);

      let errorMessage = t('chat_stt_microphone_accessFailed');
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          errorMessage += t('chat_stt_microphone_grantPermission');
        } else if (error.name === 'NotFoundError') {
          errorMessage += t('chat_stt_microphone_notFound');
        } else {
          errorMessage += error.message;
        }
      }

      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setIsRecording(false);
    }
  };

  return (
    <div>
      <div className={`flex h-screen flex-col overflow-hidden ${isDarkMode ? 'bg-zinc-950' : 'bg-white'}`}>
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 px-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            {!showHistory && runSnapshot?.run && (
          <div className="border-b px-3 py-1 text-[11px] text-zinc-500">
            任务状态：{runSnapshot.run.status} · 已记录事件 {runSnapshot.events?.length ?? 0}
          </div>
        )}
        {showHistory ? (
              <button
                type="button"
                onClick={() => handleBackToChat(false)}
                className="flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label={t('nav_back_a11y')}
                tabIndex={0}>
                <FiArrowLeft className="size-4" />
              </button>
            ) : (
              <img src="/icon-128.png" alt="SFT AI 助手" className="size-6 rounded-md" />
            )}
            <span className={`text-sm font-medium ${isDarkMode ? 'text-zinc-100' : 'text-zinc-800'}`}>
              {showHistory ? t('chat_history_title') : 'SFT AI 助手'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {!showHistory && (
              <>
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label={t('nav_newChat_a11y')}
                  tabIndex={0}>
                  <PiPlusBold className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={handleLoadHistory}
                  className="flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label={t('nav_loadHistory_a11y')}
                  tabIndex={0}>
                  <GrHistory className="size-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => chrome.runtime.openOptionsPage()}
              className="flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label={t('nav_settings_a11y')}
              tabIndex={0}>
              <FiSettings className="size-4" />
            </button>
          </div>
        </header>
        {showHistory ? (
          <div className="flex-1 overflow-hidden">
            <ChatHistoryList
              sessions={chatSessions}
              onSessionSelect={handleSessionSelect}
              onSessionDelete={handleSessionDelete}
              visible={true}
              isDarkMode={isDarkMode}
            />
          </div>
        ) : (
          <>
            {/* Show loading state while checking model configuration */}
            {hasConfiguredModels === null && (
              <div
                className={`flex flex-1 items-center justify-center p-8 ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                <div className="text-center">
                  <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent"></div>
                  <p>{t('status_checkingConfig')}</p>
                </div>
              </div>
            )}

            {/* Show setup message when no models are configured */}
            {hasConfiguredModels === false && (
              <div
                className={`flex flex-1 items-center justify-center p-8 ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                <div className="max-w-md text-center">
                  <img src="/icon-128.png" alt="SFT AI 助手" className="mx-auto mb-4 size-12" />
                  <h3 className={`mb-2 text-lg font-semibold ${isDarkMode ? 'text-zinc-200' : 'text-zinc-700'}`}>
                    {t('welcome_title')}
                  </h3>
                  <p className="mb-4">{t('welcome_instruction')}</p>
                  <button
                    onClick={() => chrome.runtime.openOptionsPage()}
                    className={`my-4 rounded-lg px-4 py-2 font-medium transition-colors ${
                      isDarkMode
                        ? 'bg-zinc-900 text-white hover:bg-zinc-700'
                        : 'bg-zinc-900 text-white hover:bg-zinc-900'
                    }`}>
                    {t('welcome_openSettings')}
                  </button>
                </div>
              </div>
            )}

            {/* Show normal chat interface when models are configured */}
            {hasConfiguredModels === true && (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* 消息区:占满剩余空间,独立滚动 */}
                <div
                  className={`scrollbar-gutter-stable min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth p-3 ${isDarkMode ? 'dark:bg-zinc-950/80' : ''}`}>
                  {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center px-6">
                      <div
                        className={`text-center text-sm leading-6 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        <img src="/icon-128.png" alt="SFT AI 助手" className="mx-auto mb-3 size-10 opacity-80" />
                        输入任务开始,例如:
                        <br />
                        「打开一个网页并总结内容」「帮我把这个页面的表格提取出来」
                      </div>
                    </div>
                  ) : (
                    <>
                      {runSnapshot?.checkpoint?.plan?.length > 0 && (
                        <TaskPlanPanel steps={runSnapshot.checkpoint.plan} />
                      )}
                      {runSnapshot?.events?.length > 0 && (
                        <TaskTimeline
                          events={runSnapshot.events}
                          hasMore={timelineHasMore}
                          onLoadMore={() => {
                            const first = runSnapshot.events[0]?.sequence;
                            if (first && first > 1) {
                              portRef.current?.postMessage({
                                type: 'get_run_events_before',
                                runId: runSnapshot.run.id,
                                beforeSequence: first,
                                limit: 100,
                              });
                            }
                          }}
                        />
                      )}
                      {runEvidence.length > 0 && <EvidenceList items={runEvidence} />}
                      <MessageList messages={messages} isDarkMode={isDarkMode} running={showStopButton} />
                      <div ref={messagesEndRef} />
                    </>
                  )}
                </div>
                {userRequest && (
                  <UserRequestCard
                    request={userRequest}
                    onSubmit={answer => {
                      portRef.current?.postMessage({ type: 'user_intervention_response', runId: userRequest.runId, nonce: userRequest.nonce, answer });
                      setUserRequest(null);
                    }}
                  />
                )}
                {approvalAction && (
                  <ApprovalCard
                    action={approvalAction}
                    onApprove={() => {
                      portRef.current?.postMessage({type:'approve_action',runId:approvalAction.runId,nonce:approvalAction.nonce,parameterHash:approvalAction.parameterHash});
                      setApprovalAction(null);
                    }}
                    onReject={() => {
                      portRef.current?.postMessage({type:'reject_action',runId:approvalAction.runId,nonce:approvalAction.nonce,parameterHash:approvalAction.parameterHash});
                      setApprovalAction(null);
                    }}
                  />
                )}
                {manualSkills.length > 0 && (
                  <div className="shrink-0 border-t px-3 py-2 text-xs">
                    <div className="mb-1 text-zinc-500">本次任务 Skill</div>
                    <div className="flex flex-wrap gap-2">
                      {manualSkills.map(skill => (
                        <button
                          key={skill.id}
                          type="button"
                          className={`rounded-full border px-2 py-1 ${selectedSkillIds.includes(skill.id) ? 'bg-zinc-900 text-white' : ''}`}
                          onClick={() => setSelectedSkillIds(prev => prev.includes(skill.id) ? prev.filter(id => id !== skill.id) : [...prev, skill.id])}>
                          {skill.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 输入区:固定在底部 */}
                <div
                  className={`shrink-0 border-t p-2 ${isDarkMode ? 'border-zinc-800 dark:bg-zinc-950' : 'border-zinc-200 bg-white/80'} shadow-sm backdrop-blur-sm`}>
                  <ChatInput
                    onSendMessage={handleSendMessage}
                    onStopTask={handleStopTask}
                    onMicClick={handleMicClick}
                    isRecording={isRecording}
                    isProcessingSpeech={isProcessingSpeech}
                    disabled={!inputEnabled || isHistoricalSession}
                    showStopButton={showStopButton}
                    setContent={setter => {
                      setInputTextRef.current = setter;
                    }}
                    isDarkMode={isDarkMode}
                    historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
                    onReplay={handleReplay}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SidePanel;
