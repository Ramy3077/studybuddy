import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { adminPool } from '../db/pool.js';
import { getEmbeddingProvider } from '../providers/embeddings.js';
import { countWords } from '../util/text.js';
import type { DiscoveredFile, PreparedChunk } from '../types.js';
import { discoverVault } from './discover.js';
import { parsePdf } from './pdf.js';
import { parseMarkdown } from './markdown.js';
import { parseTranscript } from './transcript.js';

export interface IngestStats {
  file: string;
  status: 'ingested' | 'skipped-unchanged' | 'error';
  chunks: number;
  skippedPages?: number[];
  error?: string;
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

async function ensureModule(): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO modules (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [config.moduleSlug, config.moduleName],
  );
  return rows[0]!.id;
}

async function prepareChunks(file: DiscoveredFile): Promise<{ chunks: PreparedChunk[]; meta: Record<string, unknown> }> {
  if (file.sourceType === 'slides') {
    const res = await parsePdf(file.vaultPath);
    return { chunks: res.chunks, meta: { totalPages: res.totalPages, skippedPages: res.skippedPages } };
  }
  if (file.sourceType === 'notes') {
    return { chunks: await parseMarkdown(file.vaultPath), meta: {} };
  }
  return { chunks: await parseTranscript(file.vaultPath), meta: {} };
}

async function embedAll(texts: string[]): Promise<number[][]> {
  const embedder = getEmbeddingProvider();
  const out: number[][] = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const vecs = await embedder.embedBatch(slice);
    out.push(...vecs);
  }
  return out;
}

/** Ingest one file idempotently. Re-ingesting unchanged content is a no-op. */
export async function ingestFile(
  file: DiscoveredFile,
  moduleId: string,
  opts: { force?: boolean } = {},
): Promise<IngestStats> {
  const bytes = await readFile(file.vaultPath);
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  const existing = await adminPool.query<{ id: string; content_hash: string | null; n: number }>(
    `SELECT s.id, s.content_hash, count(c.id)::int AS n
       FROM sources s LEFT JOIN source_chunks c ON c.source_id = s.id
      WHERE s.vault_path = $1 GROUP BY s.id`,
    [file.vaultPath],
  );
  const prior = existing.rows[0];
  if (!opts.force && prior && prior.content_hash === contentHash && prior.n > 0) {
    return { file: file.relPath, status: 'skipped-unchanged', chunks: prior.n };
  }

  const { chunks, meta } = await prepareChunks(file);
  const metadata = {
    lecture: file.lecture,
    kind: file.kind,
    isPrimary: file.isPrimary,
    coveredCodes: file.coveredCodes,
    relPath: file.relPath,
    ...meta,
  };

  const embeddings = await embedAll(chunks.map((c) => c.text));

  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const up = await client.query<{ id: string }>(
      `INSERT INTO sources (source_type, module, module_id, title, code, week, vault_path, content_hash, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (vault_path) DO UPDATE SET
         source_type = EXCLUDED.source_type, module = EXCLUDED.module, module_id = EXCLUDED.module_id,
         title = EXCLUDED.title, code = EXCLUDED.code, week = EXCLUDED.week,
         content_hash = EXCLUDED.content_hash, metadata = EXCLUDED.metadata, updated_at = now()
       RETURNING id`,
      [file.sourceType, file.module, moduleId, file.title, file.code, file.week, file.vaultPath, contentHash, metadata],
    );
    const sourceId = up.rows[0]!.id;
    // Replace chunks for idempotency.
    await client.query('DELETE FROM source_chunks WHERE source_id = $1', [sourceId]);

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      await client.query(
        `INSERT INTO source_chunks (source_id, chunk_index, text, embedding, locator, token_estimate)
         VALUES ($1,$2,$3,$4::vector,$5::jsonb,$6)`,
        [sourceId, c.chunkIndex, c.text, toVectorLiteral(embeddings[i]!), JSON.stringify(c.locator), Math.round(countWords(c.text) * 1.33)],
      );
    }
    await client.query('COMMIT');
    return {
      file: file.relPath,
      status: 'ingested',
      chunks: chunks.length,
      skippedPages: (meta.skippedPages as number[]) ?? undefined,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { file: file.relPath, status: 'error', chunks: 0, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export async function ingestVault(
  opts: { force?: boolean; onlyWeeks?: number[]; log?: (m: string) => void } = {},
): Promise<IngestStats[]> {
  const log = opts.log ?? console.log;
  const moduleId = await ensureModule();
  const { files } = await discoverVault(config.vaultPath, config.moduleSlug);
  const selected = opts.onlyWeeks
    ? files.filter((f) => f.week !== null && opts.onlyWeeks!.includes(f.week))
    : files;

  const stats: IngestStats[] = [];
  for (const f of selected) {
    const s = await ingestFile(f, moduleId, { force: opts.force });
    const extra = s.skippedPages && s.skippedPages.length ? ` (skipped pages: ${s.skippedPages.join(',')})` : '';
    log(`[${s.status}] ${s.file} — ${s.chunks} chunk(s)${extra}${s.error ? ` ERROR: ${s.error}` : ''}`);
    stats.push(s);
  }
  return stats;
}
