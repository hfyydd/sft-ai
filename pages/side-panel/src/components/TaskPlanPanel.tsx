import React from 'react';
import type { PlanStep } from '@extension/storage';
export function TaskPlanPanel({steps}:{steps:PlanStep[]}){return <section className="rounded border p-2 text-xs"><div className="mb-1 font-semibold">任务计划</div>{steps.map(s=><div key={s.id} className="flex gap-2 py-1"><span>{s.status==='completed'?'✓':s.status==='blocked'?'!':'○'}</span><span>{s.title}</span></div>)}</section>;}
