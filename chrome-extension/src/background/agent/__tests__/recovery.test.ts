import { describe, expect, it } from 'vitest';
import { classifyFailure, recoveryAdvice } from '../recovery';
describe('recovery classification',()=>{it.each([['timeout','transient'],['URL not allowed','permission'],['element no longer available','page_structure'],['approval required','user_intervention']] as const)('%s', (message,expected)=>expect(classifyFailure(new Error(message))).toBe(expected));it('has bounded advice',()=>expect(recoveryAdvice('unrecoverable')).toContain('停止'));});
