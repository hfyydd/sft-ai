import { describe, expect, it } from 'vitest';
import { decodeBase64ToBytes } from '../pdf';

describe('PDF input boundary', () => {
  it('decodes bytes returned by the side-panel file bridge', () => {
    expect(Array.from(decodeBase64ToBytes(btoa('pdf-bytes')))).toEqual(Array.from(new TextEncoder().encode('pdf-bytes')));
  });
  it('keeps the local file bridge bounded at the caller', () => {
    expect(decodeBase64ToBytes('')).toHaveLength(0);
  });
});
