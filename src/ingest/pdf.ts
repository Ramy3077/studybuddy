import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { collapseWs } from '../util/text.js';
import type { PreparedChunk } from '../types.js';

export interface PdfResult {
  chunks: PreparedChunk[];
  totalPages: number;
  skippedPages: number[]; // image-only / near-empty pages (under ~20 chars)
}

interface Page {
  page: number;
  text: string;
}

const MIN_PAGE_CHARS = 20;
const WINDOW = 3; // pages per window
const STEP = 2; // advance 2 -> 1 page overlap

/** Extract text from a slide PDF and build ~3-page overlapping windows. */
export async function parsePdf(path: string): Promise<PdfResult> {
  const data = new Uint8Array(await readFile(path));
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    // pdf.js is chatty about font/parse quirks; silence non-fatal warnings.
    verbosity: 0,
  }).promise;

  const pages: Page[] = [];
  const skippedPages: number[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = collapseWs(content.items.map((it: any) => ('str' in it ? it.str : '')).join(' '));
    if (text.length < MIN_PAGE_CHARS) {
      skippedPages.push(p);
    } else {
      pages.push({ page: p, text });
    }
  }
  await doc.destroy();

  const chunks: PreparedChunk[] = [];
  let chunkIndex = 0;
  for (let i = 0; i < pages.length; i += STEP) {
    const window = pages.slice(i, i + WINDOW);
    if (window.length === 0) break;
    const startPage = window[0]!.page;
    const endPage = window[window.length - 1]!.page;
    // Clean page text only (no inline [p.N] markers) so evidence quotes copied
    // from a chunk read as real passages. Page range lives in the locator.
    const text = window.map((w) => w.text).join('\n\n');
    chunks.push({
      chunkIndex: chunkIndex++,
      text,
      locator: { kind: 'slides', start_page: startPage, end_page: endPage },
    });
    if (i + WINDOW >= pages.length) break; // avoid trailing duplicate tail window
  }

  return { chunks, totalPages: doc.numPages, skippedPages };
}
