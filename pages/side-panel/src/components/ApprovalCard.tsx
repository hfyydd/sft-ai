import React from 'react';
import { t } from '@extension/i18n';

export interface ApprovalCardAction {
  runId: string;
  toolName: string;
  argsSummary: string;
  previewSummary?: string;
  url?: string;
  nonce: string;
  parameterHash: string;
}

export function ApprovalCard({
  action,
  onApprove,
  onReject,
}: {
  action: ApprovalCardAction;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <div className="mb-2 font-semibold">{t('task_approval_needed')}</div>
      <div className="mb-1 text-xs">动作：{action.toolName}</div>
      <div className="mb-1 break-all text-xs">来源：{action.url || '当前页面'}</div>
      {action.previewSummary && (
        <div className="mb-3">
          <div className="mb-1 text-xs font-semibold">操作内容预览（敏感字段已隐藏）</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-amber-200 bg-white/70 p-2 text-xs dark:border-amber-900 dark:bg-zinc-900">{action.previewSummary}</pre>
        </div>
      )}
      <pre className="mb-3 max-h-24 overflow-auto whitespace-pre-wrap text-xs">{action.argsSummary}</pre>
      <div className="flex gap-2">
        <button type="button" className="rounded bg-zinc-900 px-3 py-1.5 text-white" onClick={onApprove}>{t('task_approve_once')}</button>
        <button type="button" className="rounded border px-3 py-1.5" onClick={onReject}>{t('task_reject')}</button>
      </div>
    </div>
  );
}
