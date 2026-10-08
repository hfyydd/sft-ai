import type { PlanStep } from '@extension/storage';

export function normalizePlanSteps(steps: PlanStep[] | undefined, nextSteps: string): PlanStep[] {
  if (steps && steps.length) return steps;
  return nextSteps.split(/\n|;|(?<=\d\.)\s+/).map(s => s.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((title, i) => ({
    id: 'step-' + (i + 1),
    title,
    successCriteria: '完成：' + title,
    status: i === 0 ? 'running' : 'queued',
    evidenceIds: [],
  }));
}

export function validatePlanSteps(steps: PlanStep[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || ids.has(step.id)) throw new Error('Plan step ids must be unique');
    if (!step.title || !step.successCriteria) throw new Error('Plan steps require title and successCriteria');
    ids.add(step.id);
  }
}
