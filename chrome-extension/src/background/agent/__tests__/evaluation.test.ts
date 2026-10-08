import { describe, expect, it } from 'vitest';
import { evaluateTrace } from '../evaluation';
describe('evaluation harness',()=>{it('passes a fully evidenced safe trace',()=>{const out=evaluateTrace('x',['url','title'],[{type:'source',payload:{url:'u',title:'t'}}]);expect(out.success).toBe(true);});it('fails on policy violations',()=>{const out=evaluateTrace('x',['url'],[{type:'approval.missing'}]);expect(out.success).toBe(false);});});
