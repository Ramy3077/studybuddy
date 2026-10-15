import type pg from 'pg';
import type { RetrievedChunk } from './types.js';
import { STOPWORDS } from './providers/mockEmbeddings.js';

type Queryable = Pick<pg.Pool, 'query'>;

/** Lowercase content-word tokens with a very light suffix stemmer. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export interface Scored {
  index: number;
  score: number;
  matched: number; // distinct query terms found in the document
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  /** Drop hits that match fewer distinct query terms than this. */
  minMatched?: number;
  /** Drop hits scoring below this fraction of the best hit. */
  minRelative?: number;
  /** Drop hits scoring below this absolute BM25 score. */
  minScore?: number;
}

/**
 * Okapi BM25 over a small in-memory set of documents. Returns hits best first,
 * with weak matches removed: a hit must share at least `minMatched` distinct
 * terms with the query and clear both an absolute and a relative score floor.
 * An empty array means "nothing relevant", which callers should show as nothing.
 */
export function bm25Rank(query: string, docs: string[], opts: Bm25Options = {}): Scored[] {
  const { k1 = 1.4, b = 0.75, minMatched = 2, minRelative = 0.35, minScore = 1.5 } = opts;
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || docs.length === 0) return [];

  const tokenised = docs.map(tokenize);
  const avgLen = tokenised.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of tokenised) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  const N = docs.length;
  const scored: Scored[] = tokenised.map((d, index) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      matched++;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen)));
    }
    return { index, score, matched };
  });

  const best = Math.max(...scored.map((s) => s.score));
  return scored
    .filter((s) => s.matched >= minMatched && s.score >= minScore && s.score >= best * minRelative)
    .sort((x, y) => y.score - x.score);
}

/** Offline lexical retrieval: BM25 over a module's chunks, with a relevance floor. */
export async function lexicalSearch(
  db: Queryable,
  queryText: string,
  opts: { moduleId?: string | null; limit?: number } = {},
): Promise<RetrievedChunk[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.chunk_index, c.text, c.locator,
            0::float8 AS distance,
            s.title AS source_title, s.source_type, s.code AS source_code, s.week
       FROM source_chunks c JOIN sources s ON s.id = c.source_id
      WHERE ($1::uuid IS NULL OR s.module_id = $1)`,
    [opts.moduleId ?? null],
  );
  const chunks = rows as RetrievedChunk[];
  const hits = bm25Rank(queryText, chunks.map((c) => c.text));
  return hits.slice(0, opts.limit ?? 6).map((h) => chunks[h.index]!);
}
