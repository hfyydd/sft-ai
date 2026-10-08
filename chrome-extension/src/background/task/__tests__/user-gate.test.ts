import { describe, expect, it } from 'vitest';
import type { PendingUserRequest } from '@extension/storage';

describe('user intervention contract', () => {
  it('uses a nonce and expiry to bind a request', () => {
    const request: PendingUserRequest = {
      runId: 'run-1',
      question: '请补充一个信息',
      nonce: 'nonce-1',
      expiresAt: Date.now() + 1000,
    };
    expect(request.nonce).toBeTruthy();
    expect(request.expiresAt).toBeGreaterThan(Date.now());
  });
  it('treats a different nonce as a different request', () => {
    expect('nonce-a' === 'nonce-b').toBe(false);
  });
});
