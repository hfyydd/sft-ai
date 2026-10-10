import { taskRunStore, type PendingAction, type PendingWrite, type TaskCheckpoint } from '@extension/storage';
import { approvalMatchesContext } from './approval-policy';

interface ApprovalRequest {
  runId: string;
  toolName: string;
  args: unknown;
  tabId?: number;
  url?: string;
  targetUrl?: string;
  reason?: string;
  previewSummary?: string;
}

const pending = new Map<string, (approved: boolean) => void>();

function redactForAudit(value: unknown): unknown {
  const sensitive = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|cvv|card[_-]?number|security[_-]?code)/i;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactForAudit(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [
        key,
        sensitive.test(key) ? '[REDACTED]' : redactForAudit(item),
      ]),
    );
  }
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  return value;
}

function makeAuditSummary(value: unknown): string {
  const redacted = redactForAudit(value);
  const serialized = JSON.stringify(redacted);
  return serialized.length > 2000 ? serialized.slice(0, 2000) + '…' : serialized;
}

async function hash(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
}

async function actionMatches(action: PendingAction, input: ApprovalRequest) {
  const parameterHash = await hash(JSON.stringify(input.args));
  return approvalMatchesContext(
    action,
    {
      runId: input.runId,
      toolName: input.toolName,
      parameterHash,
      tabId: input.tabId,
      url: input.url,
      targetUrl: input.targetUrl,
      expiresAt: action.expiresAt,
    },
  );
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
  let existing = await taskRunStore.getCheckpoint(input.runId).catch(() => undefined);
  if (existing?.approvedAction) {
    if (await actionMatches(existing.approvedAction, input)) {
      const consumed = await taskRunStore.appendEvent(input.runId, 'approval.consumed', {
        nonce: existing.approvedAction.nonce,
        toolName: existing.approvedAction.toolName,
        parameterHash,
      });
      const pendingWrite =
        existing.pendingWrite?.toolName === input.toolName &&
        existing.pendingWrite.parameterHash === parameterHash
          ? { ...existing.pendingWrite, phase: 'executing' as const }
          : existing.pendingWrite;
      await clearPending(input.runId, consumed.sequence, existing, {
        pendingAction: undefined,
        approvedAction: undefined,
        pendingWrite,
      });
      await taskRunStore.updateStatus(input.runId, 'running').catch(() => undefined);
      return true;
    }

    // A recovered approval must never survive a different next action. Otherwise
    // a later model retry could accidentally consume an old authorization.
    const invalidated = await taskRunStore.appendEvent(input.runId, 'approval.invalidated', {
      nonce: existing.approvedAction.nonce,
      toolName: existing.approvedAction.toolName,
      parameterHash: existing.approvedAction.parameterHash,
      reason: existing.approvedAction.expiresAt < Date.now() ? 'expired' : 'action_or_context_mismatch',
    });
    await clearPending(input.runId, invalidated.sequence, existing, {
      pendingAction: existing.pendingAction,
      approvedAction: undefined,
      pendingWrite: existing.pendingWrite,
    });
    existing = await taskRunStore.getCheckpoint(input.runId).catch(() => undefined);
  }

  const nonce = crypto.randomUUID();
  const action: PendingAction = {
    runId: input.runId,
    toolName: input.toolName,
    argsSummary: makeAuditSummary(input.args),
    previewSummary: input.previewSummary ? input.previewSummary.slice(0, 5000) : undefined,
    tabId: input.tabId,
    url: input.url,
    targetUrl: input.targetUrl,
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
    // This exact browser write has not executed yet: the operator is blocked on
    // approval. Do not make recovery demand a postcondition for an unexecuted action.
    pendingWrite:
      current?.pendingWrite?.toolName === input.toolName &&
      current.pendingWrite.parameterHash === parameterHash
        ? { ...current.pendingWrite, phase: 'awaiting_approval' }
        : current?.pendingWrite,
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
        await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: expired.sequence, pendingAction: undefined, approvedAction: undefined, pendingWrite: undefined }).catch(() => undefined);
      }
      await taskRunStore.updateStatus(input.runId, 'cancelled').catch(() => undefined);
    }, 5 * 60_000 + 100);
  });

  if (!approved) return false;

  // Commit the approval consumption and set the write phase back to executing
  // before returning to the tool handler, so a Worker crash cannot erase the
  // distinction between "approved but not run" and "side effect may have run".
  const checkpoint = await taskRunStore.getCheckpoint(input.runId);
  const approvedAction = checkpoint?.approvedAction;
  if (!checkpoint || !approvedAction || !(await actionMatches(approvedAction, input))) return false;
  const consumed = await taskRunStore.appendEvent(input.runId, 'approval.consumed', {
    nonce: approvedAction.nonce,
    toolName: approvedAction.toolName,
    parameterHash,
  });
  const pendingWrite =
    checkpoint.pendingWrite?.toolName === input.toolName &&
    checkpoint.pendingWrite.parameterHash === parameterHash
      ? { ...checkpoint.pendingWrite, phase: 'executing' as const }
      : checkpoint.pendingWrite;
  await clearPending(input.runId, consumed.sequence, checkpoint, {
    pendingAction: undefined,
    approvedAction: undefined,
    pendingWrite,
  });
  await taskRunStore.updateStatus(input.runId, 'running').catch(() => undefined);
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
      await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: event.sequence, pendingAction: undefined, approvedAction: undefined, pendingWrite: undefined }).catch(() => undefined);
      const resolve = pending.get(input.nonce);
      pending.delete(input.nonce);
      resolve?.(false);
      // The original confirmation is no longer valid. Mark the run recoverable so
      // the UI can restart the operator and request a fresh approval for the new context.
      await taskRunStore.updateStatus(input.runId, 'interrupted');
      await taskRunStore.appendEvent(input.runId, 'runtime.recovery_required', {
        reason: 'approval_context_changed',
        next: 'resume_and_reapprove',
      }).catch(() => undefined);
      return false;
    }
  }

  const resolve = pending.get(input.nonce);
  if (resolve) pending.delete(input.nonce);
  const event = await taskRunStore.appendEvent(
    input.runId,
    input.approved ? 'approval.approved' : 'approval.rejected',
    { nonce: input.nonce, toolName: action.toolName, parameterHash: input.parameterHash },
  );

  if (input.approved) {
    await clearPending(input.runId, event.sequence, checkpoint, {
      pendingAction: undefined,
      // Keep the one-time approval in IndexedDB until the waiting tool consumes it.
      approvedAction: action,
      pendingWrite: checkpoint.pendingWrite,
    });
    await taskRunStore.updateStatus(input.runId, 'running');
    resolve?.(true);
  } else {
    await clearPending(input.runId, event.sequence, checkpoint, {
      pendingAction: undefined,
      approvedAction: undefined,
      pendingWrite: undefined,
    });
    await taskRunStore.updateStatus(input.runId, 'cancelled');
    resolve?.(false);
  }
  return true;
}
