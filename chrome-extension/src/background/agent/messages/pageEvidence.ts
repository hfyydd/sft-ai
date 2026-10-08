import { wrapUntrustedContent } from './utils';

export type PageEvidenceSource = 'dom' | 'pdf' | 'vision' | 'cache';

export interface PageEvidenceMetadata {
  tabId: number;
  url: string;
  title: string;
  capturedAt: string;
  pageNumber?: number;
  evidenceId?: string;
}

export interface PageEvidence {
  source: PageEvidenceSource;
  metadata: PageEvidenceMetadata;
  content: string;
}

export function formatPageEvidence(
  source: PageEvidenceSource,
  metadata: PageEvidenceMetadata,
  content: string,
): string {
  const sourceLine = [
    `source=${source}`,
    `tabId=${metadata.tabId}`,
    `url=${metadata.url}`,
    `title=${metadata.title}`,
    `capturedAt=${metadata.capturedAt}`,
    metadata.pageNumber === undefined ? null : `pageNumber=${metadata.pageNumber}`,
       metadata.evidenceId === undefined ? null : `evidenceId=${metadata.evidenceId}`,
  ]
    .filter(Boolean)
    .join(' | ');

  return wrapUntrustedContent(`[Page evidence: ${sourceLine}]\n${content}`);
}
