import type { PlanStep } from '@extension/storage';

const MAX_PLAN_STEPS = 50;

export function normalizePlanSteps(steps: PlanStep[] | undefined, nextSteps: string): PlanStep[] {
  const source = steps && steps.length ? steps : nextSteps
    .split(/\n|;|(?<=\d\.)\s+/)
    .map(s => s.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((title, i) => ({
      id: 'step-' + (i + 1),
      title,
      successCriteria: '完成：' + title,
      status: i === 0 ? 'running' as const : 'queued' as const,
      evidenceIds: [] as string[],
    }));

  if (source.length > MAX_PLAN_STEPS) throw new Error('Plan exceeds maximum step count');
  let hasRunning = false;
  const normalized = source.map(step => {
    const allowed = ['queued', 'running', 'completed', 'blocked', 'skipped'] as const;
    const status = allowed.includes(step.status) ? step.status : 'queued';
    if (status === 'running') {
      if (hasRunning) return { ...step, status: 'queued' as const, evidenceIds: [...new Set(step.evidenceIds ?? [])] };
      hasRunning = true;
    }
    return { ...step, status, evidenceIds: [...new Set(step.evidenceIds ?? [])] };
  });
  if (!hasRunning) {
    const firstQueued = normalized.find(step => step.status === 'queued');
    if (firstQueued) firstQueued.status = 'running';
  }
  return normalized;
}

export function validatePlanSteps(steps: PlanStep[]): void {
  if (steps.length > MAX_PLAN_STEPS) throw new Error('Plan exceeds maximum step count');
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
  validatePlanSteps(incoming);
  const incomingById = new Map(incoming.map(step => [step.id, step]));
  const merged: PlanStep[] = [];
  const incomingHasRunning = incoming.some(step => step.status === 'running');
  for (const old of previous) {
    if (!incomingById.has(old.id)) {
      merged.push({
        ...old,
        status: old.status === 'running' && incomingHasRunning ? 'blocked' : old.status,
        evidenceIds: [...old.evidenceIds],
      });
    }
  }
  for (const step of incoming) {
    const old = previous.find(item => item.id === step.id);
    const status = old?.status === 'completed' ? 'completed' : step.status;
    merged.push({
      ...step,
      status,
      evidenceIds: [...new Set([...(old?.evidenceIds ?? []), ...step.evidenceIds])],
    });
  }
  const limited = merged.slice(0, MAX_PLAN_STEPS);
  let runningAssigned = false;
  for (const step of limited) {
    if (step.status !== 'running') continue;
    if (runningAssigned) step.status = 'queued';
    else runningAssigned = true;
  }
  if (limited.length && !runningAssigned) {
    const candidate = limited.find(step => step.status === 'queued');
    if (candidate) candidate.status = 'running';
  }
  return limited;
}
