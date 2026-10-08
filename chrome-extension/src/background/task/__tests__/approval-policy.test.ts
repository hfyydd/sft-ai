import { describe, expect, it } from 'vitest';
import { classifyActionRisk, requiresApproval } from '../approval-policy';

describe('approval policy matrix', () => {
  it.each([
    ['read_page', {}, 'read'],
    ['switch_tab', {}, 'navigate'],
    ['input_text', { text: 'hello' }, 'interaction'],
    ['click_element', { intent: '提交表单' }, 'write'],
    ['click_element', { intent: '删除记录' }, 'destructive'],
    ['click_element', { intent: '支付订单' }, 'financial'],
    ['close_tab', {}, 'destructive'],
  ] as const)('classifies %s as %s', (tool, args, expected) => {
    expect(classifyActionRisk(tool, args)).toBe(expected);
  });

  it('requires approval for write/destructive/financial actions', () => {
    expect(requiresApproval('click_element', { intent: '提交表单' })).toBe(true);
    expect(requiresApproval('click_element', { intent: '删除记录' })).toBe(true);
    expect(requiresApproval('click_element', { intent: '支付订单' })).toBe(true);
    expect(requiresApproval('read_page', { intent: '读取页面' })).toBe(false);
  });
});
