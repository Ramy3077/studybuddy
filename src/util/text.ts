/** Collapse all runs of whitespace to a single space and trim. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Strip inline markdown emphasis markers (**bold**, __bold__, ==highlight==,
 * `code`) while leaving the words and any LaTeX/subscripts intact, so passages
 * read as clean prose. Only matched pairs on a single line are unwrapped.
 */
export function stripInlineMarkup(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

export function countWords(s: string): number {
  const t = collapseWs(s);
  return t === '' ? 0 : t.split(' ').length;
}

/**
 * True if `quote` appears verbatim inside `text`, tolerating differences in
 * whitespace runs (newlines vs spaces) and letter case. Case-folding keeps this
 * consistent with the authored-import matcher (which case-folds), so the "Why?"
 * panel preserves the authored evidence quote instead of falling back to a
 * different passage on a pure case difference.
 */
export function isVerbatimSubstring(quote: string, text: string): boolean {
  const q = collapseWs(quote).toLowerCase();
  if (q.length === 0) return false;
  return collapseWs(text).toLowerCase().includes(q);
}

/**
 * Return a substring of `text` (guaranteed verbatim) whose word count lies in
 * [minWords, maxWords]. Starts at the first "wordy" token. Used by the mock
 * generator to emit grounded evidence quotes offline.
 */
export function verbatimSpan(text: string, minWords = 8, maxWords = 22): string {
  const words: { start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    words.push({ start: m.index, end: m.index + m[0].length });
  }
  if (words.length === 0) return text.trim();
  // Prefer to begin a little way in to skip slide headers / page numbers.
  let startWord = 0;
  if (words.length > minWords + 2) startWord = 1;
  const want = Math.min(maxWords, Math.max(minWords, Math.min(words.length - startWord, maxWords)));
  const endWord = Math.min(words.length - 1, startWord + want - 1);
  return text.slice(words[startWord]!.start, words[endWord]!.end);
}

/**
 * True if `s` reads as a clean prose passage rather than structural markup
 * (page markers, markdown table/heading/link/embed, LaTeX command, code fence).
 * Used to keep evidence quotes as genuine readable passages.
 */
export function isCleanProse(s: string): boolean {
  // Reject structural markup (page markers, links/embeds, display-math blocks,
  // code fences, table pipes). Inline LaTeX like $\mathbf{w}^T\mathbf{x}$ is
  // allowed — it is legitimate ML content — but the letter-ratio guard below
  // still rejects quotes that are essentially just an equation.
  if (/\[p\.\d|\]\]|\]\(|!\[|\$\$|```|\|{1,}/.test(s)) return false;
  if (/^\s*[#>|]/.test(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  return letters / Math.max(1, s.length) >= 0.5;
}

/**
 * Like verbatimSpan, but returns the first sentence-aligned window that reads
 * as clean prose (within [minWords, maxWords]). Falls back to verbatimSpan.
 * The result is always a verbatim substring of `text`.
 */
export function cleanVerbatimSpan(text: string, minWords = 8, maxWords = 24): string {
  const spans: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1] ?? ' ';
    if (((ch === '.' || ch === '!' || ch === '?') && /\s/.test(next)) || ch === '\n') {
      if (i + 1 > start) spans.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < text.length) spans.push([start, text.length]);

  for (const [s, e] of spans) {
    const raw = text.slice(s, e);
    const cs = s + (raw.length - raw.trimStart().length);
    const ce = e - (raw.length - raw.trimEnd().length);
    const slice = text.slice(cs, ce);
    if (slice.length === 0 || !isCleanProse(slice)) continue;
    const wc = countWords(slice);
    if (wc < minWords) continue;
    if (wc <= maxWords) return slice;
    const words = [...slice.matchAll(/\S+/g)];
    const last = words[Math.min(words.length - 1, maxWords - 1)]!;
    return slice.slice(0, last.index! + last[0].length);
  }
  return verbatimSpan(text, minWords, maxWords);
}

/** Naive sentence splitter; good enough for deterministic mock generation. */
export function splitSentences(text: string): string[] {
  return collapseWs(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Bag-of-words token overlap ratio of `a` against `b` (0..1). */
export function tokenOverlap(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / A.size;
}
