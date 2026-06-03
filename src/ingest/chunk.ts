import { countWords } from '../util/text.js';

export interface TextSpan {
  text: string;
  char_start: number;
  char_end: number;
}

interface Segment {
  start: number;
  end: number;
  words: number;
}

/** Split `text` into segments at sentence terminators and newlines, keeping
 * exact character offsets so chunk locators stay verbatim. */
function segment(text: string): Segment[] {
  const spans: Segment[] = [];
  let start = 0;
  const push = (s: number, e: number) => {
    if (e <= s) return;
    const raw = text.slice(s, e);
    if (raw.trim().length === 0) return;
    spans.push({ start: s, end: e, words: countWords(raw) });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1] ?? ' ';
    const sentenceEnd = (ch === '.' || ch === '!' || ch === '?') && /\s/.test(next);
    if (sentenceEnd || ch === '\n') {
      push(start, i + 1);
      start = i + 1;
    }
  }
  push(start, text.length);
  return spans;
}

/**
 * Sentence-aware, overlapping length chunker. Produces chunks of up to
 * `maxWords` words, each overlapping the previous by roughly `overlapWords`.
 * char_start/char_end are offsets into `text`, and `text` is exactly
 * text.slice(char_start, char_end) (verbatim — safe for locators/highlighting).
 */
export function chunkByWords(
  text: string,
  opts: { maxWords: number; overlapWords: number; minWords?: number },
): TextSpan[] {
  const { maxWords, overlapWords, minWords = 0 } = opts;
  const segs = segment(text);
  if (segs.length === 0) return [];

  const chunks: TextSpan[] = [];
  let i = 0;
  while (i < segs.length) {
    let words = 0;
    let j = i;
    while (j < segs.length) {
      const w = segs[j]!.words;
      if (words > 0 && words + w > maxWords) break;
      words += w;
      j++;
    }
    if (j === i) j = i + 1; // always consume at least one segment

    const rawStart = segs[i]!.start;
    const rawEnd = segs[j - 1]!.end;
    const raw = text.slice(rawStart, rawEnd);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const cs = rawStart + lead;
    const ce = rawEnd - trail;
    const slice = text.slice(cs, ce);
    if (countWords(slice) >= minWords) {
      chunks.push({ text: slice, char_start: cs, char_end: ce });
    }

    if (j >= segs.length) break;
    // Step back for overlap (in segments), guaranteeing forward progress.
    let back = j - 1;
    let ow = 0;
    while (back > i && ow < overlapWords) {
      ow += segs[back]!.words;
      back--;
    }
    i = Math.max(i + 1, back + 1);
  }
  return chunks;
}
