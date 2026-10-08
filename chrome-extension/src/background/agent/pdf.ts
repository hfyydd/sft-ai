// 路线二(主路线):读取 PDF 字节,用 pdf.js 提取文本层(含 OCR 文本层)。
// 注意:pdf.js 在 MV3 Service Worker 顶层 import 可能引发崩溃,
// 因此这里使用惰性动态加载 —— 只在真正读取 PDF 时才 import。

import { createLogger } from '../log';
import { EMBEDDED_CMAPS } from './cmaps.generated';

// pdf.js 的 CMap 加载走 isValidFetchUrl + fetch(失败则回退 XHR,而 SW 无 XHR 且只认 http(s))。
// 这里:1) 垫一个 document.baseURI 供其校验;2) 拦截 cmaps 的 fetch 从内嵌数据返回。
const CMAP_BASE = 'http://pdf-cmaps.internal/cmaps/';
(globalThis as Record<string, unknown>).document = (globalThis as Record<string, unknown>).document || {
  baseURI: CMAP_BASE,
};
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as Request)?.url ?? '');
  if (typeof url === 'string' && url.includes('/cmaps/') && url.endsWith('.bcmap')) {
    const name = url
      .split('/')
      .pop()!
      .replace(/\.bcmap$/, '');
    const b64 = EMBEDDED_CMAPS[name];
    if (b64 !== undefined) {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return Promise.resolve(new Response(buf, { status: 200 }));
    }
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof globalThis.fetch;

const logger = createLogger('PdfExtract');

export interface PdfExtractResult {
  text: string;
  numPages: number;
  extractedPages: number;
  truncated: boolean;
}

export interface PdfExtractOptions {
  maxPages?: number;
  maxChars?: number;
  /** 中文 PDF 的 CID 字体需要 CMap 映射表;扩展内传 chrome.runtime.getURL('cmaps/') */
  cMapUrl?: string;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js 的 fake worker 模式:主线程解析(MV3 SW 无法创建 Worker)。
      // pdf.js 查找的是 globalThis.pdfjsWorker.WorkerMessageHandler,
      // 必须显式提取该导出(模块命名空间对象在打包后不保证暴露它)
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // @ts-expect-error pdf.worker 无类型定义
      const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      const handler =
        (workerMod as Record<string, unknown>).WorkerMessageHandler ??
        (workerMod as { default?: Record<string, unknown> }).default?.WorkerMessageHandler;
      (globalThis as Record<string, unknown>).pdfjsWorker = { WorkerMessageHandler: handler };
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

/**
 * 从 PDF 字节提取文本层。
 * - 纯图片扫描件没有文本层,返回空文本(调用方可回退到截图+视觉模型)
 */
export async function extractPdfData(data: Uint8Array, options?: PdfExtractOptions): Promise<PdfExtractResult> {
  const maxPages = options?.maxPages ?? 20;
  const maxChars = options?.maxChars ?? 30000;
  const cMapUrl = options?.cMapUrl;
  const pdfjsLib = await loadPdfjs();

  const pdf = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false, // MV3 CSP 禁 eval,关闭 PostScript 优化器
    useWorkerFetch: false,
    disableFontFace: true, // 只提取文本,不需要字体渲染
    // 中文 PDF 的 CID 字体需要 CMap 映射表才能解出 Unicode 文本
    // CMap 请求由顶部 fetch 垫片从内嵌数据返回(不发真实网络请求)
    cMapUrl: CMAP_BASE,
    cMapPacked: true,
  }).promise;

  const numPages = pdf.numPages;
  logger.info(`PDF opened: ${numPages} pages (cap ${maxPages})`);
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
    logger.info(`page ${p}: ${pageText.length} chars`);
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

  logger.info(`PDF extract done: ${text.trim().length} chars total`);
  return { text: text.trim(), numPages, extractedPages: pageCount, truncated };
}

/**
 * 从 http(s)/file URL 读取 PDF 并提取文本层。
 * - http(s):fetch 走扩展 host_permissions,可跨域读取政务系统附件
 * - file:Service Worker 无法读 file://,由调用方先把字节读出来后传 extractPdfData
 */
export async function extractPdfTextFromUrl(url: string, options?: PdfExtractOptions): Promise<PdfExtractResult> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`下载 PDF 失败:HTTP ${res.status}`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  return extractPdfData(data, options);
}

export function decodeBase64ToBytes(base64:string):Uint8Array {
  const binary=atob(base64);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes;
}

export async function extractPdfTextFromBytes(data:Uint8Array,options?:PdfExtractOptions){
  const maxBytes=10*1024*1024;
  if(data.byteLength>maxBytes) throw new Error(`PDF 文件超过 ${maxBytes} 字节限制`);
  return extractPdfData(data,options);
}
