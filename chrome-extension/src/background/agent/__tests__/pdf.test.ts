import { describe, expect, it } from 'vitest';
import {
  buildPdfPageUrl,
  decodeBase64ToBytes,
  extractPdfTextFromBytes,
  MAX_PDF_BYTES,
  validatePdfBytes,
} from '../pdf';

describe('PDF input boundary', () => {
  it('decodes bytes returned by the side-panel file bridge', () => {
    expect(Array.from(decodeBase64ToBytes(btoa('pdf-bytes')))).toEqual(
      Array.from(new TextEncoder().encode('pdf-bytes')),
    );
  });

  it('accepts an empty base64 payload only as a decoding result, not as a PDF', () => {
    expect(decodeBase64ToBytes('')).toHaveLength(0);
    expect(() => validatePdfBytes(decodeBase64ToBytes(''))).toThrow('有效 PDF');
  });

  it('rejects oversized PDF bytes before parsing', async () => {
    const oversized = new Uint8Array(MAX_PDF_BYTES + 1);
    await expect(extractPdfTextFromBytes(oversized)).rejects.toThrow('超过');
  });

  it('validates PDF magic bytes before parsing', () => {
    expect(() => validatePdfBytes(new TextEncoder().encode('not a pdf'))).toThrow('有效 PDF');
    expect(() => validatePdfBytes(new TextEncoder().encode('%PDF-1.7'))).not.toThrow();
  });
});

describe('PDF page URL validation', () => {
  it('selects a requested page while preserving the path and query', () => {
    expect(buildPdfPageUrl('https://example.test/report.pdf?download=1', 7))
      .toBe('https://example.test/report.pdf?download=1#page=7');
    expect(buildPdfPageUrl('file:///tmp/report.pdf#page=2', 3))
      .toBe('file:///tmp/report.pdf#page=3');
  });

  it.each(['javascript:alert(1)', 'chrome://settings', 'data:application/pdf;base64,AA=='])(
    'rejects unsupported PDF page URL schemes: %s',
    url => expect(() => buildPdfPageUrl(url, 1)).toThrow(),
  );

  it('rejects zero, negative and fractional page numbers', () => {
    for (const page of [0, -1, 1.5]) {
      expect(() => buildPdfPageUrl('https://example.test/a.pdf', page)).toThrow();
    }
  });
});
