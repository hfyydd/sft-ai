import { describe, expect, it } from 'vitest';
import { validatePdfBytes } from '../../agent/pdf';

describe('local PDF safety boundary', () => {
  it('accepts a PDF header', () => {
    expect(() => validatePdfBytes(new TextEncoder().encode('%PDF-1.7\n'))).not.toThrow();
  });
  it('rejects non-PDF bytes', () => {
    expect(() => validatePdfBytes(new TextEncoder().encode('not-a-pdf'))).toThrow('有效 PDF');
  });
  it('rejects oversized input', () => {
    const data = new Uint8Array(10 * 1024 * 1024 + 1);
    data.set(new TextEncoder().encode('%PDF-'));
    expect(() => validatePdfBytes(data)).toThrow('超过');
  });
});
