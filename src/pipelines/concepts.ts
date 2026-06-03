import { z } from 'zod';
import { adminPool } from '../db/pool.js';
import { config } from '../config.js';
import { getLlmProvider } from '../providers/llm.js';
import { parseJsonLoose } from '../util/json.js';
import type { ConceptDraft } from '../types.js';

const ConceptSchema = z.object({
  name: z.string().min(2),
  description: z.string().default(''),
  key_facts: z.array(z.string()).default([]),
  difficulty: z.coerce.number().int().min(1).max(5).catch(3),
  source_chunk_ids: z.array(z.string()).default([]),
});
const ConceptsOut = z.object({ concepts: z.array(ConceptSchema) });

interface WeekChunk {
  id: string;
  code: string | null;
  source_type: string;
  is_primary: boolean;
  text: string;
}

const MAX_CHUNKS_PER_CALL = 45;
const CHUNK_CHAR_CAP = 1500;

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function weekChunks(moduleId: string, week: number): Promise<WeekChunk[]> {
  const { rows } = await adminPool.query(
    `SELECT c.id, c.text, s.code, s.source_type,
            COALESCE((s.metadata->>'isPrimary')::boolean, false) AS is_primary
       FROM source_chunks c JOIN sources s ON s.id = c.source_id
      WHERE s.module_id = $1 AND s.week = $2
      ORDER BY is_primary DESC, s.source_type, s.code, c.chunk_index`,
    [moduleId, week],
  );
  return rows as WeekChunk[];
}

const SYSTEM = `You are a meticulous teaching assistant extracting canonical revision concepts from university Machine Learning lecture material. You ONLY use the provided source chunks. You never invent facts and never invent chunk ids.`;

function buildPrompt(week: number, batch: WeekChunk[]) {
  const lines = batch.map(
    (c) =>
      `--- chunk id=${c.id} | code=${c.code ?? '-'} | type=${c.source_type} | primary=${c.is_primary} ---\n${c.text.slice(0, CHUNK_CHAR_CAP)}`,
  );
  const user = `Week ${week} source chunks:\n\n${lines.join('\n\n')}\n\nExtract 5-10 canonical concepts taught this week. Prefer content from primary lecture (a/b) and notes; treat tutorial/revision/assessment chunks as secondary. Merge a concept that appears across slides + transcript into ONE concept.

Return STRICT JSON only:
{"concepts":[{"name":"...","description":"1-3 sentences","key_facts":["..."],"difficulty":1-5,"source_chunk_ids":["<only ids that appear above>"]}]}

Every source_chunk_ids entry MUST be one of the chunk ids listed above. Do not include any id that is not present above.`;
  return user;
}

async function extractBatch(week: number, batch: WeekChunk[]): Promise<ConceptDraft[]> {
  const llm = getLlmProvider();
  const validIds = new Set(batch.map((c) => c.id));
  const raw = await llm.complete({
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(week, batch) }],
    maxTokens: 2500,
    temperature: 0,
    mock: {
      task: 'extract_concepts',
      payload: { week, chunks: batch.map((c) => ({ id: c.id, code: c.code, source_type: c.source_type, is_primary: c.is_primary, text: c.text })) },
    },
  });

  let parsed: z.infer<typeof ConceptsOut>;
  try {
    parsed = ConceptsOut.parse(parseJsonLoose(raw));
  } catch {
    return [];
  }

  // Repair: keep only real chunk ids; drop concepts that reference none.
  const drafts: ConceptDraft[] = [];
  for (const c of parsed.concepts) {
    const ids = c.source_chunk_ids.filter((id) => validIds.has(id));
    if (ids.length === 0) continue; // reject hallucinated provenance
    drafts.push({
      name: c.name.trim(),
      description: c.description.trim(),
      key_facts: c.key_facts.map((k) => k.trim()).filter(Boolean).slice(0, 8),
      difficulty: c.difficulty,
      week,
      source_chunk_ids: ids,
    });
  }
  return drafts;
}

/** Extract concepts for one week, sub-batching if the week is large. */
export async function extractConceptsForWeek(moduleId: string, week: number): Promise<ConceptDraft[]> {
  const chunks = await weekChunks(moduleId, week);
  if (chunks.length === 0) return [];

  const drafts: ConceptDraft[] = [];
  for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_CALL) {
    drafts.push(...(await extractBatch(week, chunks.slice(i, i + MAX_CHUNKS_PER_CALL))));
  }
  return drafts;
}

/** Persist drafts, deduping near-duplicate concepts (by normalized name) across
 * weeks: a conflict merges provenance and keeps the earliest week. */
export async function persistDrafts(moduleId: string, drafts: ConceptDraft[]): Promise<number> {
  let n = 0;
  for (const d of drafts) {
    const key = normalizeKey(d.name);
    if (!key) continue;
    await adminPool.query(
      `INSERT INTO concepts (module_id, name, description, key_facts, difficulty, week, source_chunk_ids, status, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
       ON CONFLICT (module_id, dedupe_key) DO UPDATE SET
         source_chunk_ids = (
           SELECT array_agg(DISTINCT x) FROM unnest(concepts.source_chunk_ids || EXCLUDED.source_chunk_ids) AS x
         ),
         key_facts = (
           SELECT array_agg(DISTINCT x) FROM unnest(concepts.key_facts || EXCLUDED.key_facts) AS x
         ),
         week = LEAST(concepts.week, EXCLUDED.week)`,
      [moduleId, d.name, d.description, d.key_facts, d.difficulty, d.week, d.source_chunk_ids, key],
    );
    n++;
  }
  return n;
}

export async function extractAllConcepts(
  opts: { onlyWeeks?: number[]; log?: (m: string) => void } = {},
): Promise<{ moduleId: string; total: number }> {
  const log = opts.log ?? console.log;
  const { rows } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug = $1', [config.moduleSlug]);
  const moduleId = rows[0]!.id;

  const weekRows = await adminPool.query<{ week: number }>(
    'SELECT DISTINCT week FROM sources WHERE module_id = $1 AND week IS NOT NULL ORDER BY week',
    [moduleId],
  );
  const weeks = (opts.onlyWeeks ?? weekRows.rows.map((r) => r.week)).filter((w) => w !== null);

  let total = 0;
  for (const week of weeks) {
    const drafts = await extractConceptsForWeek(moduleId, week);
    const saved = await persistDrafts(moduleId, drafts);
    total += saved;
    log(`Week ${week}: extracted ${drafts.length} concept(s), persisted ${saved} draft(s)`);
  }
  return { moduleId, total };
}

/** Promote draft concepts to live (the "go live" step after review). */
export async function publishConcepts(moduleId: string): Promise<number> {
  const res = await adminPool.query(
    `UPDATE concepts SET status = 'live' WHERE module_id = $1 AND status = 'draft'`,
    [moduleId],
  );
  return res.rowCount ?? 0;
}
