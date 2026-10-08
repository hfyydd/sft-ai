import { describe, expect, it } from 'vitest';
import { classifyActionRisk, requiresApproval } from '../approval-policy';
describe('approval policy',()=>{it('classifies financial actions',()=>expect(classifyActionRisk('click_element',{intent:'支付订单'},'支付')).toBe('financial'));it('requires approval for submit-like actions',()=>expect(requiresApproval('click_element',{intent:'提交表单'},'提交')).toBe(true));it('does not require approval for reads',()=>expect(requiresApproval('read_page',{intent:'读取'},'')).toBe(false));});
