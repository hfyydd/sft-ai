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
    <section className="rounded border p-2 text-xs">
      <div className="mb-1 font-semibold">{t('task_evidence')}</div>
      {items.map(item => (
        <div key={item.id} className="border-b py-1 last:border-0">
          <div>{item.title || item.url}</div>
          <div className="text-zinc-500">
            {item.source} · {item.pageNumber ? '第' + item.pageNumber + '页 · ' : ''}
            {new Date(item.capturedAt).toLocaleString()}
          </div>
        </div>
      ))}
    </section>
  );
}
