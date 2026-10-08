import React from 'react';
import { t } from '@extension/i18n';
import type { PlanStep } from '@extension/storage';

export function TaskPlanPanel({ steps }: { steps: PlanStep[] }) {
  return (
    <section className="rounded border p-2 text-xs">
      <div className="mb-1 font-semibold">{t('task_plan')}</div>
      {steps.map(step => (
        <div key={step.id} className="flex gap-2 py-1">
          <span>{step.status === 'completed' ? '✓' : step.status === 'blocked' ? '!' : '○'}</span>
          <span>{step.title}</span>
        </div>
      ))}
    </section>
  );
}
