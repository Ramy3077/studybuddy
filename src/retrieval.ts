import type pg from 'pg';
import type { RetrievedChunk } from './types.js';

type Queryable = Pick<pg.Pool, 'query'>;

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** Fetch chunks by id (preserving the input order) with their source metadata. */
export async function getChunksByIds(db: Queryable, ids: string[]): Promise<RetrievedChunk[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.chunk_index, c.text, c.locator,
            0::float8 AS distance,
            s.title AS source_title, s.source_type, s.code AS source_code, s.week
       FROM source_chunks c JOIN sources s ON s.id = c.source_id
      WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map<string, RetrievedChunk>(rows.map((r: any) => [r.id, r as RetrievedChunk]));
  return ids.map((id) => byId.get(id)).filter((x): x is RetrievedChunk => !!x);
}

/** k-NN vector search over source_chunks (cosine), optionally scoped to a module. */
export async function vectorSearch(
  db: Queryable,
  queryEmbedding: number[],
  opts: { moduleId?: string | null; limit?: number } = {},
): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 6;
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.chunk_index, c.text, c.locator,
            (c.embedding <=> $1::vector) AS distance,
            s.title AS source_title, s.source_type, s.code AS source_code, s.week
       FROM source_chunks c JOIN sources s ON s.id = c.source_id
      WHERE c.embedding IS NOT NULL
        AND ($2::uuid IS NULL OR s.module_id = $2)
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(queryEmbedding), opts.moduleId ?? null, limit],
  );
  return rows as RetrievedChunk[];
}

/** Human-readable citation label, e.g. "Week 2 · 2a MLE and Gradient Descent (slides)". */
export function sourceLabel(c: Pick<RetrievedChunk, 'week' | 'source_code' | 'source_title' | 'source_type'>): string {
  const parts: string[] = [];
  if (c.week !== null && c.week !== undefined) parts.push(`Week ${c.week}`);
  const codeTitle = [c.source_code, c.source_title].filter(Boolean).join(' ');
  if (codeTitle) parts.push(codeTitle);
  const label = parts.join(' · ');
  return `${label} (${c.source_type})`;
}
