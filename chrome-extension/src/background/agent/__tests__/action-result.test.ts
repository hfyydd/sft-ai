import { describe, expect, it } from 'vitest';
import { ActionResult } from '../types';

describe('ActionResult outcome semantics', () => {
  it('marks extracted successful action results as successful by default', () => {
    expect(new ActionResult({ extractedContent: 'Input verified' }).success).toBe(true);
    expect(new ActionResult({ isDone: true }).success).toBe(true);
  });

  it('marks an action with an error as unsuccessful', () => {
    expect(new ActionResult({ extractedContent: 'Not applied', error: 'verification failed' }).success).toBe(false);
    expect(new ActionResult({ error: 'not approved' }).success).toBe(false);
  });

  it('does not mark empty placeholders successful', () => {
    expect(new ActionResult().success).toBe(false);
  });

  it('respects an explicit success override', () => {
    expect(new ActionResult({ success: false, extractedContent: 'Uncertain' }).success).toBe(false);
    expect(new ActionResult({ success: true }).success).toBe(true);
  });
});
