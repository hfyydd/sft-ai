import React from 'react';
import { t } from '@extension/i18n';

export interface TimelineEvent {
  sequence: number;
  type: string;
  timestamp: number;
  actor?: string;
  payload?: unknown;
}

function detailsOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const data = (payload as { data?: { details?: unknown } }).data;
  return data && typeof data.details === 'string' ? data.details : '';
}

export function TaskTimeline({
  events,
  onLoadMore,
  hasMore,
}: {
  events: TimelineEvent[];
  onLoadMore?: () => void;
  hasMore?: boolean;
}) {
  return (
    <section className="mb-2 rounded border p-2 text-xs">
      <div className="mb-1 font-semibold">{t('task_timeline')}</div>
      {hasMore && onLoadMore && (
        <button type="button" className="mb-2 rounded border px-2 py-1" onClick={onLoadMore}>
          {t('task_load_earlier')}
        </button>
      )}
      <div className="space-y-1">
        {events.map(event => {
          const details = detailsOf(event.payload);
          return (
            <div key={event.sequence} className="rounded bg-zinc-50 px-1.5 py-1 dark:bg-zinc-900">
              <div className="flex items-center gap-2">
                <span className="text-zinc-400">#{event.sequence}</span>
                <span className="font-medium">{event.type}</span>
                {event.actor && <span className="text-zinc-400">{event.actor}</span>}
                <span className="ml-auto text-zinc-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
              </div>
              {details && <div className="mt-0.5 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{details}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
