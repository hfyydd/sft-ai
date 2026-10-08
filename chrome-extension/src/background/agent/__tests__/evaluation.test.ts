import { describe, expect, it } from 'vitest';
import { evaluateTrace, meetsReleaseGate, summarizeEvaluation } from '../evaluation';
import { EVALUATION_FIXTURES } from './fixtures/deterministic';

describe('browser task evaluation', () => {
  it('counts evidence provenance coverage from persisted records', () => {
    const outcome = evaluateTrace(
      'run-1',
      ['url', 'title', 'capturedAt', 'pageNumber'],
      [],
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

  it('detects a high-impact tool request without approval', () => {
    const outcome = evaluateTrace('run-1', [], [{
      id: 'e1', runId: 'run-1', sequence: 1, type: 'tool.requested', timestamp: 1,
      payload: { toolName: 'click_element', parameterHash: 'hash' },
    }]);
    expect(outcome.unapprovedHighImpactActions).toBe(1);
    expect(outcome.success).toBe(false);
  });

  it('accepts an exact approval pair', () => {
    const events = [
      { id:'e1',runId:'run-1',sequence:1,type:'approval.requested',timestamp:1,payload:{toolName:'click_element',parameterHash:'hash'} },
      { id:'e2',runId:'run-1',sequence:2,type:'approval.approved',timestamp:2,payload:{toolName:'click_element',parameterHash:'hash'} },
      { id:'e3',runId:'run-1',sequence:3,type:'tool.requested',timestamp:3,payload:{toolName:'click_element',parameterHash:'hash'} },
    ];
    const outcome = evaluateTrace('run-1', [], events);
    expect(outcome.unapprovedHighImpactActions).toBe(0);
    expect(outcome.success).toBe(true);
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
