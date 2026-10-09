import { describe, expect, it } from 'vitest';
import { approvalMatchesContext, classifyActionRisk, requiresApproval } from '../approval-policy';

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

describe('one-time approval authority', () => {
  const base = {
    runId: 'run-1',
    toolName: 'click_element',
    parameterHash: 'sha256-args',
    tabId: 12,
    url: 'https://example.test/form',
    targetUrl: 'https://example.test/confirm',
    expiresAt: 2_000,
  };

  it('matches only the exact run, tool, parameters, and browsing context', () => {
    expect(approvalMatchesContext(base, base, 1_000)).toBe(true);
    expect(approvalMatchesContext(base, { ...base, parameterHash: 'different' }, 1_000)).toBe(false);
    expect(approvalMatchesContext(base, { ...base, toolName: 'close_tab' }, 1_000)).toBe(false);
    expect(approvalMatchesContext(base, { ...base, tabId: 13 }, 1_000)).toBe(false);
    expect(approvalMatchesContext(base, { ...base, url: 'https://example.test/other' }, 1_000)).toBe(false);
    expect(approvalMatchesContext(base, { ...base, targetUrl: 'https://attacker.test/' }, 1_000)).toBe(false);
    expect(approvalMatchesContext(base, { ...base, runId: 'other-run' }, 1_000)).toBe(false);
  });

  it('refuses expired one-time approvals', () => {
    expect(approvalMatchesContext(base, base, 2_001)).toBe(false);
    expect(approvalMatchesContext(base, base, 2_000)).toBe(true);
  });
});
