import { taskRunStore, type PendingAction, type TaskCheckpoint } from '@extension/storage';

interface ApprovalRequest {
  runId: string;
  toolName: string;
  args: unknown;
  tabId?: number;
  url?: string;
  reason?: string;
}

const pending = new Map<string, (approved: boolean) => void>();

async function hash(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
}

async function clearPending(runId: string, sequence: number, checkpoint: TaskCheckpoint) {
  await taskRunStore.saveCheckpoint({ ...checkpoint, runId, sequence, pendingAction: undefined });
}

export async function requestApproval(input: ApprovalRequest): Promise<boolean> {
  const nonce = crypto.randomUUID();
  const argsSummary = JSON.stringify(input.args);
  const parameterHash = await hash(argsSummary);
  const action: PendingAction = {
    runId: input.runId,
    toolName: input.toolName,
    argsSummary,
    tabId: input.tabId,
    url: input.url,
    expiresAt: Date.now() + 5 * 60_000,
    nonce,
    parameterHash,
  };

  await taskRunStore.updateStatus(input.runId, 'waiting_approval');
  const event = await taskRunStore.appendEvent(input.runId, 'approval.requested', { ...action, reason: input.reason });

  const current = await taskRunStore.getCheckpoint(input.runId);
  await taskRunStore.saveCheckpoint({
    runId: input.runId,
    sequence: event.sequence,
    plan: current?.plan ?? [],
    completedStepIds: current?.completedStepIds ?? [],
    memory: current?.memory ?? [],
    evidenceIds: current?.evidenceIds ?? [],
    activeTabId: input.tabId,
    navigatorState: current?.navigatorState,
    pendingAction: action,
  });

  void chrome.runtime.sendMessage({ type: 'approval_required', action }).catch(() => undefined);
  return new Promise<boolean>(resolve => {
    pending.set(nonce, resolve);
    setTimeout(() => {
      if (!pending.has(nonce)) return;
      pending.delete(nonce);
      if (resolve) resolve(false);
      void taskRunStore.updateStatus(input.runId, 'waiting_user');
      void taskRunStore.appendEvent(input.runId, 'approval.expired', { nonce });
    }, 5 * 60_000 + 100);
  });
}

export async function resolveApproval(input: {
  runId: string;
  nonce: string;
  approved: boolean;
  parameterHash: string;
}) {
  const run = await taskRunStore.getRun(input.runId);
  if (!run || (run.status !== 'waiting_approval' && run.status !== 'waiting_user')) return false;

  const resolve = pending.get(input.nonce);
  const checkpoint = await taskRunStore.getCheckpoint(input.runId);
  const action = checkpoint?.pendingAction;
  if (!action) return false;
  if (action.nonce !== input.nonce || action.parameterHash !== input.parameterHash || action.expiresAt < Date.now()) return false;

  if (action.tabId !== undefined) {
    const tab = await chrome.tabs.get(action.tabId).catch(() => null);
    if (!tab?.id || (action.url && tab.url !== action.url)) {
      pending.delete(input.nonce);
      resolve(false);
      await taskRunStore.appendEvent(input.runId, 'approval.invalidated', { nonce: input.nonce, reason: 'tab_or_url_changed' });
      await taskRunStore.updateStatus(input.runId, 'waiting_user');
      return false;
    }
  }

  if (resolve) pending.delete(input.nonce);
  const event = await taskRunStore.appendEvent(
    input.runId,
    input.approved ? 'approval.approved' : 'approval.rejected',
    { nonce: input.nonce, parameterHash: input.parameterHash },
  );

  if (input.approved) {
    await clearPending(input.runId, event.sequence, checkpoint);
    await taskRunStore.updateStatus(input.runId, 'running');
    if (resolve) resolve(true);
  } else {
    await clearPending(input.runId, event.sequence, checkpoint);
    await taskRunStore.updateStatus(input.runId, 'cancelled');
    resolve(false);
  }
  return true;
}
