import { taskRunStore, type PendingFileReadRequest } from '@extension/storage';
import { decodeBase64ToBytes, MAX_PDF_BYTES } from '../agent/pdf';

const pending = new Map<string, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();

export async function requestLocalPdfBytes(input: {
  runId: string;
  tabId: number;
  path: string;
  timeoutMs?: number;
}): Promise<Uint8Array> {
  if (!input.path.startsWith('file://')) throw new Error('本地文件通道只允许 file:// PDF');
  const request: PendingFileReadRequest = {
    runId: input.runId,
    requestId: crypto.randomUUID(),
    path: input.path,
    tabId: input.tabId,
    expiresAt: Date.now() + Math.max(30_000, input.timeoutMs ?? 10 * 60_000),
  };

  const current = await taskRunStore.getCheckpoint(input.runId);
  await taskRunStore.updateStatus(input.runId, 'waiting_user');
  const event = await taskRunStore.appendEvent(input.runId, 'file.read_requested', request);
  await taskRunStore.saveCheckpoint({
    runId: input.runId,
    sequence: event.sequence,
    plan: current?.plan ?? [],
    completedStepIds: current?.completedStepIds ?? [],
    memory: current?.memory ?? [],
    evidenceIds: current?.evidenceIds ?? [],
    activeTabId: input.tabId,
    navigatorState: current?.navigatorState,
    pendingAction: current?.pendingAction,
    approvedAction: current?.approvedAction,
    pendingWrite: current?.pendingWrite,
    pendingUserRequest: current?.pendingUserRequest,
    pendingFileRead: request,
  });

  void chrome.runtime.sendMessage({ type: 'local_file_read_requested', request }).catch(() => undefined);

  const timeoutMs = Math.max(30_000, input.timeoutMs ?? 10 * 60_000);
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(request.requestId, { resolve, reject });
    setTimeout(async () => {
      const waiter = pending.get(request.requestId);
      if (!waiter) return;
      pending.delete(request.requestId);
      waiter.reject(new Error('本地 PDF 读取等待超时，请保持侧边栏打开并确认“允许访问文件网址”已开启。'));
      const checkpoint = await taskRunStore.getCheckpoint(input.runId).catch(() => undefined);
      const expired = await taskRunStore.appendEvent(input.runId, 'file.read_expired', { requestId: request.requestId }).catch(() => undefined);
      if (checkpoint && expired) {
        await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: expired.sequence, pendingFileRead: undefined }).catch(() => undefined);
      }
      await taskRunStore.updateStatus(input.runId, 'failed').catch(() => undefined);
    }, timeoutMs + 100);
  });
}

export async function resolveLocalPdfBytes(input: {
  runId: string;
  requestId: string;
  dataBase64: string;
}): Promise<boolean> {
  const checkpoint = await taskRunStore.getCheckpoint(input.runId);
  const request = checkpoint?.pendingFileRead;
  if (!request || request.runId !== input.runId || request.requestId !== input.requestId || request.expiresAt < Date.now()) return false;

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64ToBytes(input.dataBase64);
  } catch {
    return false;
  }
  if (bytes.byteLength > MAX_PDF_BYTES) return false;

  const event = await taskRunStore.appendEvent(input.runId, 'file.read_completed', {
    requestId: input.requestId,
    bytes: bytes.byteLength,
  });
  await taskRunStore.saveCheckpoint({ ...checkpoint, sequence: event.sequence, pendingFileRead: undefined });
  await taskRunStore.updateStatus(input.runId, 'running').catch(() => undefined);

  const waiter = pending.get(input.requestId);
  if (waiter) {
    pending.delete(input.requestId);
    waiter.resolve(bytes);
  }
  return true;
}
