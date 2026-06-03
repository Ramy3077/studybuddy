import type pg from 'pg';

// Confidence decay model.
// score in [0,1]. After each attempt the score moves (EWMA) toward 1 (correct)
// or 0 (incorrect). Between sessions an UN-revisited concept's score decays
// exponentially toward 0 with a ~14-day half-life, so stale knowledge fades.
const HALF_LIFE_DAYS = 14;
export const DECAY_LAMBDA = Math.log(2) / HALF_LIFE_DAYS; // per day
const ALPHA = 0.4; // learning rate for the EWMA update
const NEUTRAL = 0.5; // starting confidence for an untested concept

const DAY_MS = 86_400_000;

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Apply time decay to a stored score given when it was last tested. */
export function decayedScore(score: number, lastTested: Date | null, now: number): number {
  if (lastTested === null) return score;
  const days = Math.max(0, (now - lastTested.getTime()) / DAY_MS);
  return clamp01(score * Math.exp(-DECAY_LAMBDA * days));
}

/** New score after an attempt: decay the old score, then EWMA toward outcome. */
export function nextScore(prevScore: number | null, lastTested: Date | null, isCorrect: boolean, now: number): number {
  const base = prevScore === null ? NEUTRAL : decayedScore(prevScore, lastTested, now);
  const target = isCorrect ? 1 : 0;
  return clamp01(base * (1 - ALPHA) + target * ALPHA);
}

/**
 * Record the knowledge update for an attempt. Runs on the OWNER connection
 * (server-authoritative) — never the client. now is injectable for tests.
 */
export async function updateKnowledge(
  db: Pick<pg.Pool, 'query'>,
  userId: string,
  conceptId: string,
  isCorrect: boolean,
  now: number = Date.now(),
): Promise<number> {
  const { rows } = await db.query<{ score: number; last_tested: Date | null; history: unknown[] }>(
    'SELECT score, last_tested, history FROM knowledge WHERE user_id = $1 AND concept_id = $2',
    [userId, conceptId],
  );
  const prev = rows[0] ?? null;
  const score = nextScore(prev ? prev.score : null, prev ? prev.last_tested : null, isCorrect, now);
  const event = { at: new Date(now).toISOString(), is_correct: isCorrect, score: Number(score.toFixed(4)) };
  const history = [...((prev?.history as unknown[]) ?? []), event].slice(-50);

  await db.query(
    `INSERT INTO knowledge (user_id, concept_id, score, last_tested, history, updated_at)
     VALUES ($1,$2,$3, to_timestamp($4/1000.0), $5::jsonb, now())
     ON CONFLICT (user_id, concept_id) DO UPDATE SET
       score = EXCLUDED.score, last_tested = EXCLUDED.last_tested,
       history = EXCLUDED.history, updated_at = now()`,
    [userId, conceptId, score, now, JSON.stringify(history)],
  );
  return score;
}
