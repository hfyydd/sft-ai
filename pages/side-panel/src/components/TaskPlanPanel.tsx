import React from 'react';
import { t } from '@extension/i18n';
import type { PlanStep } from '@extension/storage';

const statusLabel: Record<PlanStep['status'], string> = {
  queued: '待执行',
  running: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  skipped: '已跳过',
};

export function TaskPlanPanel({ steps }: { steps: PlanStep[] }) {
  return (
    <section className="mb-2 rounded border p-2 text-xs">
      <div className="mb-1 font-semibold">{t('task_plan')}</div>
      <div className="space-y-1">
        {steps.map(step => (
          <div key={step.id} className="rounded bg-zinc-50 p-1.5 dark:bg-zinc-900">
            <div className="flex items-start gap-2">
              <span aria-hidden="true">
                {step.status === 'completed' ? '✓' : step.status === 'blocked' ? '!' : step.status === 'running' ? '▶' : '○'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{step.title}</span>
                  <span className="shrink-0 text-zinc-500">{statusLabel[step.status]}</span>
                </div>
                <div className="mt-0.5 text-zinc-500">成功条件：{step.successCriteria}</div>
                {step.evidenceIds.length > 0 && (
                  <div className="mt-0.5 text-zinc-400">证据：{step.evidenceIds.join(', ')}</div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
