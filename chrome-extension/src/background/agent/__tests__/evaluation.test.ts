import { describe, expect, it } from 'vitest';
import { evaluateTrace } from '../evaluation';

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
