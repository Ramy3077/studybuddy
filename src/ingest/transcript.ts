import { readFile } from 'node:fs/promises';
import { chunkByWords } from './chunk.js';
import type { PreparedChunk } from '../types.js';

/**
 * Clean an auto-generated caption export: drop the generator banner, WEBVTT
 * headers, numeric cue indices and HH:MM:SS(.mmm) --> timecodes if present.
 * These transcripts have no usable timestamps, so anything that looks like a
 * caption marker is stripped.
 */
export function cleanTranscript(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n');
  s = s.replace(/^﻿/, ''); // BOM
  const lines = s.split('\n').filter((line) => {
    const t = line.trim();
    if (t === '') return true;
    if (/^WEBVTT/i.test(t)) return false;
    if (/^\[?auto-generated transcript/i.test(t)) return false;
    if (/^\d+$/.test(t)) return false; // bare cue index
    if (/^\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}/.test(t)) return false;
    if (/^(NOTE|STYLE|REGION)\b/.test(t)) return false;
    return true;
  });
  s = lines.join('\n');
  // Strip inline timecodes like <00:00:01.000>
  s = s.replace(/<\d{1,2}:\d{2}:\d{2}[.,]?\d{0,3}>/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export async function parseTranscript(path: string): Promise<PreparedChunk[]> {
  const raw = await readFile(path, 'utf8');
  const cleaned = cleanTranscript(raw);
  const spans = chunkByWords(cleaned, { maxWords: 880, overlapWords: 135, minWords: 40 });
  return spans.map((sp, i) => ({
    chunkIndex: i,
    text: sp.text,
    locator: {
      kind: 'text',
      chunk_index: i,
      char_start: sp.char_start,
      char_end: sp.char_end,
    },
  }));
}
