import React from 'react';
import { t } from '@extension/i18n';

export interface EvidenceItem {
  id: string;
  source: string;
  url: string;
  title: string;
  capturedAt: number;
  pageNumber?: number;
}

export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  return (
    <section className="mb-2 rounded border p-2 text-xs">
      <div className="mb-1 font-semibold">{t('task_evidence')}</div>
      <div className="space-y-1">
        {items.map(item => (
          <div key={item.id} className="border-b py-1 last:border-0">
            <div className="font-medium">{item.title || item.url}</div>
            <div className="mt-0.5 break-all text-zinc-500">{item.url}</div>
            <div className="mt-0.5 text-zinc-400">
              {item.source} · {item.pageNumber !== undefined ? '第' + item.pageNumber + '页 · ' : ''}
              {new Date(item.capturedAt).toLocaleString()} · {item.id}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
