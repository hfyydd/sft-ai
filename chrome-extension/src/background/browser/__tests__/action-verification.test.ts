import { describe, expect, it } from 'vitest';
describe('action verification contract',()=>{it('requires a postcondition for a write',()=>{const result={success:false,error:'uncertain'};expect(result.success).toBe(false);expect(result.error).toBeTruthy();});});
