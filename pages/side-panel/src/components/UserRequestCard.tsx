import React, { useState } from 'react';
import { t } from '@extension/i18n';

export interface UserRequestCardData {
  runId: string;
  question: string;
  reason?: string;
  nonce: string;
}

export function UserRequestCard({
  request,
  onSubmit,
}: {
  request: UserRequestCardData;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="shrink-0 border-t border-sky-300 bg-sky-50 p-3 text-sm dark:border-sky-800 dark:bg-sky-950">
      <div className="mb-1 font-semibold">{t('task_user_input_needed')}</div>
      {request.reason && <div className="mb-1 text-xs text-zinc-500">{request.reason}</div>}
      <div className="mb-2">{request.question}</div>
      <textarea className="mb-2 w-full rounded border p-2 text-xs" value={answer} onChange={event => setAnswer(event.target.value)} />
      <button type="button" disabled={!answer.trim()} className="rounded bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50" onClick={() => onSubmit(answer.trim())}>{t('task_submit_answer')}</button>
    </div>
  );
}
