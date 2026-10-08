import { describe, expect, it } from 'vitest';
import { decodeBase64ToBytes, extractPdfTextFromBytes, MAX_PDF_BYTES } from '../pdf';

describe('PDF input boundary', () => {
  it('decodes bytes returned by the side-panel file bridge', () => {
    expect(Array.from(decodeBase64ToBytes(btoa('pdf-bytes')))).toEqual(Array.from(new TextEncoder().encode('pdf-bytes')));
  });
  it('keeps the local file bridge bounded at the caller', () => {
    expect(decodeBase64ToBytes('')).toHaveLength(0);
  });
});

  it('rejects oversized PDF bytes before parsing', async () => {
    const oversized = new Uint8Array(MAX_PDF_BYTES + 1);
    await expect(extractPdfTextFromBytes(oversized)).rejects.toThrow('超过');
  });
