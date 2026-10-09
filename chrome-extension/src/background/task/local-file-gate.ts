import { taskRunStore, type PendingFileReadRequest } from '@extension/storage';
import { decodeBase64ToBytes, MAX_PDF_BYTES } from '../agent/pdf';

const pending = new Map<string, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
// Non-persistent, one-time handoff for a file response that arrived after the MV3
// worker restarted. The new Executor consumes these bytes without asking Side Panel
// to reread the same file immediately.
const availableBytes = new Map<string, { path: string; expiresAt: number; bytes: Uint8Array }>();
const cacheKey = (runId: string, path: string) => runId + ':' + path;

export async function requestLocalPdfBytes(input: {
  runId: string;
  tabId: number;
  path: string;
  timeoutMs?: number;
}): Promise<Uint8Array> {
  if (!input.path.startsWith('file://')) throw new Error('本地文件通道只允许 file:// PDF');
  const cachedKey = cacheKey(input.runId, input.path);
  const cached = availableBytes.get(cachedKey);
  if (cached && cached.expiresAt >= Date.now()) {
    availableBytes.delete(cachedKey);
    return new Uint8Array(cached.bytes);
  }
  if (cached) availableBytes.delete(cachedKey);
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
  dataBase64?: string;
  error?: string;
}): Promise<boolean> {
  const checkpoint = await taskRunStore.getCheckpoint(input.runId);
  const request = checkpoint?.pendingFileRead;
  if (!request || request.runId !== input.runId || request.requestId !== input.requestId || request.expiresAt < Date.now()) return false;

  const tab = await chrome.tabs.get(request.tabId).catch(() => null);
  if (!tab?.id || tab.url !== request.path) {
    const reason = '本地 PDF 标签页已关闭或地址已改变，拒绝接受过期文件读取结果';
    const waiter = pending.get(input.requestId);
    if (waiter) {
      pending.delete(input.requestId);
      waiter.reject(new Error(reason));
    }
    const invalidated = await taskRunStore.appendEvent(input.runId, 'file.read_invalidated', {
      requestId: input.requestId,
      tabId: request.tabId,
      reason,
    }).catch(() => undefined);
    if (invalidated) await taskRunStore.saveCheckpoint({ ...checkpoint!, sequence: invalidated.sequence, pendingFileRead: undefined }).catch(() => undefined);
    await taskRunStore.updateStatus(input.runId, 'failed').catch(() => undefined);
    return false;
  }

  if (input.error) {
    const waiter = pending.get(input.requestId);
    if (waiter) {
      pending.delete(input.requestId);
      waiter.reject(new Error(input.error));
    }
    await taskRunStore.appendEvent(input.runId, 'file.read_failed', { requestId: input.requestId, error: input.error });
    await taskRunStore.updateStatus(input.runId, 'failed').catch(() => undefined);
    return true;
  }
  if (!input.dataBase64) return false;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64ToBytes(input.dataBase64);
  } catch {
    return false;
  }
  if (bytes.byteLength > MAX_PDF_BYTES) return false;
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  if (header !== '%PDF-') {
    await taskRunStore.appendEvent(input.runId, 'file.read_failed', {
      requestId: input.requestId,
      error: '读取的文件不是有效 PDF',
    }).catch(() => undefined);
    const waiter = pending.get(input.requestId);
    if (waiter) {
      pending.delete(input.requestId);
      waiter.reject(new Error('读取到的文件不是有效 PDF'));
    }
    await taskRunStore.updateStatus(input.runId, 'failed').catch(() => undefined);
    return true;
  }

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
  } else {
    // A service-worker restart destroyed the Promise which initiated the read.
    // Keep the result in memory for the immediately restarted Executor only.
    availableBytes.set(cacheKey(input.runId, request.path), {
      path: request.path,
      expiresAt: Math.min(request.expiresAt, Date.now() + 60_000),
      bytes: new Uint8Array(bytes),
    });
  }
  return true;
}
