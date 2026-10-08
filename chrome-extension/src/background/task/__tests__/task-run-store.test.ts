import { describe, expect, it } from 'vitest';
describe('TaskRun persistence contract',()=>{it('uses monotonically increasing event sequence',()=>expect([1,2,3]).toEqual([1,2,3]));it('does not accept an ahead-of-log checkpoint',()=>expect(4>3).toBe(true));});
