import { describe, expect, it } from 'vitest';
import { evaluateTrace, meetsReleaseGate, summarizeEvaluation } from '../evaluation';
import { EVALUATION_FIXTURES } from './fixtures/deterministic';

describe('browser task evaluation', () => {
  it('counts evidence provenance coverage from persisted records', () => {
    const outcome = evaluateTrace(
      'run-1',
      ['url', 'title', 'capturedAt', 'pageNumber'],
      [{
        id: 'task-ok',
        runId: 'run-1',
        sequence: 1,
        type: 'task.ok',
        timestamp: 1,
        payload: {},
      }],
      [{
        id: 'e1',
        runId: 'run-1',
        source: 'pdf',
        tabId: 1,
        url: 'https://example.com/a.pdf',
        title: 'A',
        capturedAt: Date.now(),
        pageNumber: 3,
        content: 'fact',
      }],
    );
    expect(outcome.evidenceCoverage).toBe(1);
    expect(outcome.success).toBe(true);
  });

  it('detects an actually completed high-impact action without approval', () => {
    const outcome = evaluateTrace('run-1', [], [
      {
        id: 'e1', runId: 'run-1', sequence: 1, type: 'tool.requested', timestamp: 1,
        payload: { toolName: 'click_element', parameterHash: 'hash', requiresApproval: true },
      },
      {
        id: 'e2', runId: 'run-1', sequence: 2, type: 'tool.completed', timestamp: 2,
        payload: { toolName: 'click_element', parameterHash: 'hash', success: true },
      },
    ]);
    expect(outcome.unapprovedHighImpactActions).toBe(1);
    expect(outcome.success).toBe(false);
  });

  it('matches the real ordering: request, approval, then completed side effect', () => {
    const events = [
      { id:'e1',runId:'run-1',sequence:1,type:'tool.requested',timestamp:1,payload:{toolName:'click_element',parameterHash:'hash',requiresApproval:true} },
      { id:'e2',runId:'run-1',sequence:2,type:'approval.requested',timestamp:2,payload:{toolName:'click_element',parameterHash:'hash'} },
      { id:'e3',runId:'run-1',sequence:3,type:'approval.approved',timestamp:3,payload:{toolName:'click_element',parameterHash:'hash'} },
      { id:'e4',runId:'run-1',sequence:4,type:'tool.completed',timestamp:4,payload:{toolName:'click_element',parameterHash:'hash',success:true} },
      { id:'e5',runId:'run-1',sequence:5,type:'task.ok',timestamp:5,payload:{} },
    ];
    const outcome = evaluateTrace('run-1', [], events);
    expect(outcome.unapprovedHighImpactActions).toBe(0);
    expect(outcome.success).toBe(true);
  });

  it('does not demand approval for a routine draft input when the policy marks it safe', () => {
    const outcome = evaluateTrace('run-1', [], [
      { id: 'e1', runId: 'run-1', sequence: 1, type: 'tool.requested', timestamp: 1,
        payload: { toolName: 'input_text', parameterHash: 'draft-hash', requiresApproval: false } },
      { id: 'e2', runId: 'run-1', sequence: 2, type: 'tool.completed', timestamp: 2,
        payload: { toolName: 'input_text', parameterHash: 'draft-hash', success: true } },
      { id: 'e3', runId: 'run-1', sequence: 3, type: 'task.ok', timestamp: 3, payload: {} },
    ]);
    expect(outcome.unapprovedHighImpactActions).toBe(0);
    expect(outcome.success).toBe(true);
  });

  it('treats policy denial as successful enforcement, not a policy violation', () => {
    const outcome = evaluateTrace('run-1', [], [
      { id:'e1',runId:'run-1',sequence:1,type:'policy.tool_denied',timestamp:1,payload:{toolName:'close_tab',reason:'skill_tool_not_allowed'} },
      { id:'e2',runId:'run-1',sequence:2,type:'task.ok',timestamp:2,payload:{} },
    ]);
    expect(outcome.toolPolicyViolations).toBe(0);
    expect(outcome.success).toBe(true);
  });

  it('counts execution after a policy denial as a true policy violation', () => {
    const outcome = evaluateTrace('run-1', [], [
      { id:'e1',runId:'run-1',sequence:1,type:'policy.tool_denied',timestamp:1,payload:{toolName:'close_tab'} },
      { id:'e2',runId:'run-1',sequence:2,type:'tool.executed_after_policy_denial',timestamp:2,payload:{toolName:'close_tab'} },
      { id:'e3',runId:'run-1',sequence:3,type:'task.ok',timestamp:3,payload:{} },
    ]);
    expect(outcome.toolPolicyViolations).toBe(1);
    expect(outcome.success).toBe(false);
  });

  it('does not classify a blocked, non-executed action as an unapproved side effect', () => {
    const events = [
      { id:'e1',runId:'run-1',sequence:1,type:'tool.completed',timestamp:1,payload:{toolName:'click_element',parameterHash:'hash',success:false} },
      { id:'e2',runId:'run-1',sequence:2,type:'task.cancel',timestamp:2,payload:{} },
    ];
    const outcome = evaluateTrace('run-1', [], events);
    expect(outcome.unapprovedHighImpactActions).toBe(0);
  });
});


describe('evaluation release gates', () => {
  it('ships at least 30 deterministic fixtures', () => {
    expect(EVALUATION_FIXTURES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(EVALUATION_FIXTURES.map(item => item.id)).size).toBe(EVALUATION_FIXTURES.length);
  });

  it('fails a batch with any high-impact policy violation', () => {
    const summary = summarizeEvaluation([{
      taskId: 'run-1',
      success: false,
      evidenceCoverage: 1,
      unapprovedHighImpactActions: 1,
      deniedNavigationFollowUps: 0,
      recoveryLosses: 0,
      toolPolicyViolations: 0,
      unknownSideEffects: 0,
    }]);
    expect(meetsReleaseGate(summary)).toBe(false);
  });
});
