import { readFile } from 'node:fs/promises';
import { chunkByWords } from './chunk.js';
import { stripInlineMarkup } from '../util/text.js';
import { config } from '../config.js';
import type { PreparedChunk } from '../types.js';

/** Strip Obsidian-flavoured markdown down to plain prose for embedding. */
export function cleanObsidian(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n');
  // YAML frontmatter at the very top
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // ![[embeds]] and image embeds -> dropped
  s = s.replace(/!\[\[[^\]]*\]\]/g, '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // [[wikilink|alias]] -> alias ; [[wikilink]] -> wikilink
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // [text](url) -> text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Callouts / blockquotes: drop the "> " prefix and any [!type] marker.
  s = s
    .split('\n')
    .map((line) => line.replace(/^\s*>+\s?/, '').replace(/\[!\w+\][-+]?\s*/g, ''))
    .join('\n');
  // Inline #tags (but never "# Heading", which has a space after #).
  s = s.replace(/(^|\s)#[A-Za-z0-9_/-]+/g, '$1');
  // Inline emphasis markers (**bold**, ==highlight==, `code`) -> plain prose.
  s = stripInlineMarkup(s);
  // Collapse 3+ blank lines.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

interface Heading {
  offset: number;
  text: string;
}

function headings(text: string): Heading[] {
  const out: Heading[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ offset: m.index, text: m[2]!.trim() });
  }
  return out;
}

function headingAt(hs: Heading[], pos: number): string | undefined {
  let found: string | undefined;
  for (const h of hs) {
    if (h.offset <= pos) found = h.text;
    else break;
  }
  return found;
}

export async function parseMarkdown(path: string): Promise<PreparedChunk[]> {
  const raw = await readFile(path, 'utf8');
  const cleaned = cleanObsidian(raw);
  const hs = headings(cleaned);
  const maxWords = config.notesChunkWords;
  const spans = chunkByWords(cleaned, { maxWords, overlapWords: Math.round(maxWords * 0.15), minWords: 20 });
  return spans.map((sp, i) => ({
    chunkIndex: i,
    text: sp.text,
    locator: {
      kind: 'text',
      chunk_index: i,
      char_start: sp.char_start,
      char_end: sp.char_end,
      ...(headingAt(hs, sp.char_start) ? { heading: headingAt(hs, sp.char_start)! } : {}),
    },
  }));
}
