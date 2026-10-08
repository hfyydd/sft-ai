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

export function advancePlan(steps: PlanStep[], succeeded: boolean): PlanStep[] {
  const next = steps.map(step => ({ ...step, evidenceIds: [...step.evidenceIds] }));
  const currentIndex = next.findIndex(step => step.status === 'running');
  const index = currentIndex >= 0 ? currentIndex : next.findIndex(step => step.status === 'queued');
  if (index < 0) return next;
  next[index].status = succeeded ? 'completed' : 'blocked';
  if (succeeded) {
    const following = next.find(step => step.status === 'queued');
    if (following) following.status = 'running';
  }
  return next;
}

export function mergePlan(previous: PlanStep[], incoming: PlanStep[]): PlanStep[] {
  const previousById = new Map(previous.map(step => [step.id, step]));
  return incoming.map(step => {
    const old = previousById.get(step.id);
    const status = old?.status === 'completed' ? 'completed' : step.status;
    return { ...step, status, evidenceIds: [...new Set([...(old?.evidenceIds ?? []), ...step.evidenceIds])] };
  });
}
