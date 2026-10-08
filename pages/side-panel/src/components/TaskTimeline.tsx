import React from 'react';

export function TaskTimeline({
  events,
  onLoadMore,
  hasMore,
}: {
  events: Array<{ sequence: number; type: string; timestamp: number }>;
  onLoadMore?: () => void;
  hasMore?: boolean;
}) {
  return (
    <section className="rounded border p-2 text-xs">
      <div className="mb-1 font-semibold">任务时间线</div>
      {hasMore && onLoadMore && (
        <button type="button" className="mb-2 rounded border px-2 py-1" onClick={onLoadMore}>
          加载更早事件
        </button>
      )}
      {events.map(event => (
        <div key={event.sequence} className="flex gap-2 py-0.5">
          <span className="text-zinc-400">#{event.sequence}</span>
          <span>{event.type}</span>
          <span className="ml-auto text-zinc-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
        </div>
      ))}
    </section>
  );
}
