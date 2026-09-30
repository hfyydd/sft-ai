// 路线二(主路线):读取 PDF 文件字节,用 pdf.js 提取文本层(含 OCR 文本层)。
// 注意:pdf.js 在 MV3 Service Worker 顶层 import 可能引发崩溃,
// 因此这里全部使用惰性动态加载 —— 只在真正读取 PDF 时才 import。

export interface PdfExtractResult {
  text: string;
  numPages: number;
  extractedPages: number;
  truncated: boolean;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js 的 fake worker 模式:主线程解析(MV3 SW 无法创建 Worker)
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // @ts-expect-error pdf.worker 无类型定义
      const pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      (globalThis as Record<string, unknown>).pdfjsWorker = pdfjsWorker;
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

/**
 * 从 URL 下载 PDF 并提取文本层。
 * - fetch 走扩展 host_permissions,可跨域读取政务系统里的附件
 * - 纯图片扫描件没有文本层,返回空文本(调用方可回退到截图+视觉模型)
 */
export async function extractPdfTextFromUrl(
  url: string,
  options?: { maxPages?: number; maxChars?: number; cMapUrl?: string },
): Promise<PdfExtractResult> {
  const maxPages = options?.maxPages ?? 20;
  const maxChars = options?.maxChars ?? 30000;
  const pdfjsLib = await loadPdfjs();

  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`下载 PDF 失败:HTTP ${res.status}`);
  }
  const data = new Uint8Array(await res.arrayBuffer());

  const pdf = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false, // MV3 CSP 禁 eval,关闭 PostScript 优化器
    useWorkerFetch: false,
    disableFontFace: true, // 只提取文本,不需要字体渲染
    // 中文 PDF 的 CID 字体需要 CMap 映射表才能解出 Unicode 文本
    ...(options?.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
  }).promise;

  const numPages = pdf.numPages;
  const pageCount = Math.min(numPages, maxPages);
  let text = '';
  let truncated = false;

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if ('str' in item) {
        pageText += item.str;
        if ('hasEOL' in item && item.hasEOL) pageText += '\n';
      }
    }
    pageText = pageText.trim();
    if (pageText) {
      text += `\n--- 第 ${p} 页 ---\n${pageText}\n`;
    }
    if (text.length >= maxChars) {
      truncated = true;
      break;
    }
  }

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n…[文本过长已截断]';
    truncated = true;
  }

  return { text: text.trim(), numPages, extractedPages: pageCount, truncated };
}
