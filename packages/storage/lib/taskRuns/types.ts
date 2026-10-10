export type TaskRunStatus =
  | 'queued' | 'running' | 'waiting_approval' | 'waiting_user'
  | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface MemoryFact {
  id: string;
  content: string;
  evidenceIds: string[];
  createdAt: number;
  confidence?: 'low' | 'medium' | 'high';
  stepId?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  successCriteria: string;
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'skipped';
  evidenceIds: string[];
}

export interface PendingWrite {
  toolName: string;
  /** awaiting_approval means the action has not run; executing requires postcondition verification after restart. */
  phase?: 'awaiting_approval' | 'executing';
  parameterHash: string;
  tabId?: number;
  url?: string;
  expectedUrl?: string;
  startedAt: number;
  index?: number;
  expectedValueHash?: string;
  expectedFieldHashes?: Array<{ index: number; valueHash: string }>;
  beforeObservationSignature?: string;
}

export interface PendingAction {
  runId: string;
  toolName: string;
  argsSummary: string;
  tabId?: number;
  url?: string;
  targetUrl?: string;
  expiresAt: number;
  nonce: string;
  parameterHash: string;
}

export interface TaskRun {
  id: string;
  sessionId: string;
  goal: string;
  status: TaskRunStatus;
  createdAt: number;
  updatedAt: number;
  activeTabId?: number;
  checkpointVersion: number;
  lastEventSequence: number;
  skillIds: string[];
  parentRunId?: string;
}

export interface TaskRunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  timestamp: number;
  payload: unknown;
}

export interface PendingFileReadRequest {
  runId: string;
  requestId: string;
  path: string;
  tabId: number;
  expiresAt: number;
}

export interface PendingUserRequest {
  runId: string;
  question: string;
  reason?: string;
  nonce: string;
  expiresAt: number;
}

export interface TaskCheckpoint {
  runId: string;
  sequence: number;
  plan: PlanStep[];
  completedStepIds: string[];
  pendingAction?: PendingAction;
  approvedAction?: PendingAction;
  pendingWrite?: PendingWrite;
  pendingUserRequest?: PendingUserRequest;
  pendingFileRead?: PendingFileReadRequest;
  memory: MemoryFact[];
  evidenceIds: string[];
  activeTabId?: number;
  navigatorState?: unknown;
  nSteps?: number;
  replanCount?: number;
  startedAt?: number;
  finalAnswer?: string | null;
}

export interface TaskRunSnapshot {
  run: TaskRun;
  checkpoint?: TaskCheckpoint;
  events: TaskRunEvent[];
}

export interface EvidenceRecord {
  id: string;
  runId: string;
  source: 'dom' | 'pdf' | 'vision' | 'cache';
  tabId: number;
  url: string;
  title: string;
  capturedAt: number;
  pageNumber?: number;
  content: string;
}
