import { describe, expect, it } from 'vitest';
import { normalizePlanSteps, validatePlanSteps } from '../plan';
describe('plan state',()=>{it('normalizes legacy next_steps',()=>{const p=normalizePlanSteps(undefined,'1. 采集\n2. 对比\n3. 汇总');expect(p).toHaveLength(3);expect(p[0].status).toBe('running');});it('rejects duplicate ids',()=>expect(()=>validatePlanSteps([{id:'x',title:'a',successCriteria:'b',status:'queued',evidenceIds:[]},{id:'x',title:'c',successCriteria:'d',status:'queued',evidenceIds:[]}])).toThrow());});
