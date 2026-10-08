import { taskRunStore, type PendingAction, type PendingWrite, type TaskCheckpoint } from '@extension/storage';

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

async function actionMatches(action: PendingAction, input: ApprovalRequest) {
  if (action.runId !== input.runId || action.toolName !== input.toolName) return false;
  const parameterHash = await hash(JSON.stringify(input.args));
  if (action.parameterHash !== parameterHash || (action.expiresAt && action.expiresAt < Date.now())) return false;
  if (action.tabId !== input.tabId) return false;
  if ((action.url || '') !== (input.url || '')) return false;
  return true;
}

async function clearPending(
  runId: string,
  sequence: number,
  checkpoint: TaskCheckpoint,
  patch: { pendingAction?: PendingAction; approvedAction?: PendingAction; pendingWrite?: PendingWrite },
) {
  await taskRunStore.saveCheckpoint({
    ...checkpoint,
    runId,
    sequence,
    pendingAction: patch.pendingAction,
    approvedAction: patch.approvedAction,
    pendingWrite: patch.pendingWrite,
  });
}

export async function requestApproval(input: ApprovalRequest): Promise<boolean> {
  const parameterHash = await hash(JSON.stringify(input.args));
  const existing = await taskRunStore.getCheckpoint(input.runId).catch(() => undefined);
  if (existing?.approvedAction && await actionMatches(existing.approvedAction, input)) {
    const consumed = await taskRunStore.appendEvent(input.runId, 'approval.consumed', {
      nonce: existing.approvedAction.nonce,
      parameterHash,
    });
    await clearPending(input.runId, consumed.sequence, existing, { pendingAction: undefined, approvedAction: undefined });
    await taskRunStore.updateStatus(input.runId, 'running').catch(() => undefined);
    return true;
  }

  const nonce = crypto.randomUUID();
  const action: PendingAction = {
    runId: input.runId,
    toolName: input.toolName,
    argsSummary: JSON.stringify(input.args),
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
    pendingWrite: undefined,
    approvedAction: current?.approvedAction,
  });

  void chrome.runtime.sendMessage({ type: 'approval_required', action });

  const approved = await new Promise<boolean>(resolve => {
    pending.set(nonce, resolve);
    setTimeout(async () => {
      if (!pending.has(nonce)) return;
      pending.delete(nonce);
      resolve(false);
      const checkpoint = await taskRunStore.getCheckpoint(input.runId).catch(() => undefined);
      const expired = await taskRunStore.appendEvent(input.runId, 'approval.expired', { nonce }).catch(() => undefined);
      if (checkpoint && expired) {
        await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: expired.sequence, pendingAction: undefined }).catch(() => undefined);
      }
      await taskRunStore.updateStatus(input.runId, 'cancelled').catch(() => undefined);
    }, 5 * 60_000 + 100);
  });

  if (!approved) return false;

  // Persist the exact approved action until the caller actually consumes it.
  const checkpoint = await taskRunStore.getCheckpoint(input.runId);
  if (checkpoint) {
    const event = await taskRunStore.appendEvent(input.runId, 'approval.ready', { nonce, parameterHash });
    await clearPending(input.runId, event.sequence, checkpoint, {
      pendingAction: undefined,
      approvedAction: action,
      pendingWrite: undefined,
    });
  }
  return true;
}

export async function resolveApproval(input: {
  runId: string;
  nonce: string;
  approved: boolean;
  parameterHash: string;
}) {
  const run = await taskRunStore.getRun(input.runId);
  if (!run || (run.status !== 'waiting_approval' && run.status !== 'waiting_user')) return false;

  const checkpoint = await taskRunStore.getCheckpoint(input.runId);
  const action = checkpoint?.pendingAction;
  if (!action) return false;
  if (action.nonce !== input.nonce || action.parameterHash !== input.parameterHash || action.expiresAt < Date.now()) return false;

  if (action.tabId !== undefined) {
    const tab = await chrome.tabs.get(action.tabId).catch(() => null);
    if (!tab?.id || (action.url && tab.url !== action.url)) {
      const event = await taskRunStore.appendEvent(input.runId, 'approval.invalidated', { nonce: input.nonce, reason: 'tab_or_url_changed' });
      await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: event.sequence, pendingAction: undefined }).catch(() => undefined);
      const resolve = pending.get(input.nonce);
      pending.delete(input.nonce);
      resolve?.(false);
      await taskRunStore.updateStatus(input.runId, 'waiting_user');
      return false;
    }
  }

  const resolve = pending.get(input.nonce);
  if (resolve) pending.delete(input.nonce);
  const event = await taskRunStore.appendEvent(
    input.runId,
    input.approved ? 'approval.approved' : 'approval.rejected',
    { nonce: input.nonce, parameterHash: input.parameterHash },
  );

  if (input.approved) {
    await clearPending(input.runId, event.sequence, checkpoint, {
      pendingAction: undefined,
      approvedAction: action,
    });
    await taskRunStore.updateStatus(input.runId, resolve ? 'running' : 'interrupted');
    resolve?.(true);
  } else {
    await clearPending(input.runId, event.sequence, checkpoint, { pendingAction: undefined, approvedAction: undefined });
    await taskRunStore.updateStatus(input.runId, 'cancelled');
    resolve?.(false);
  }
  return true;
}
