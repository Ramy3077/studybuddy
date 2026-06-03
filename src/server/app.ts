import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { config } from '../config.js';
import { adminPool, withUser } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signJwt } from '../auth/jwt.js';
import { requireAuth, type AuthVars } from '../auth/middleware.js';
import { rateLimit } from './ratelimit.js';
import { selectQuestions } from '../quiz/select.js';
import { gradeAndRecord } from '../quiz/grade.js';
import { buildWhyContext, streamWhy } from '../quiz/why.js';

type Env = { Variables: AuthVars };

/** Best-effort client IP from a trusted proxy header (X-Forwarded-For first hop,
 * then X-Real-IP / CF-Connecting-IP). Falls back to 'unknown' (a single shared
 * bucket) when there is no proxy header — still bounds brute force. */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? c.req.header('cf-connecting-ip') ?? 'unknown';
}

const moduleIdCache = new Map<string, string>();
async function moduleIdForSlug(slug: string): Promise<string | null> {
  if (moduleIdCache.has(slug)) return moduleIdCache.get(slug)!;
  const { rows } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug = $1', [slug]);
  if (!rows[0]) return null;
  moduleIdCache.set(slug, rows[0].id);
  return rows[0].id;
}

/**
 * Per-question access facts, evaluated through the RLS-scoped app connection so
 * a user can only ever see their own enrolment/attempt rows:
 *  - enrolled:      user is enrolled in the question's module
 *  - lastIncorrect: the user's most recent attempt on this question was wrong
 * Used to gate the write path (must be enrolled) and the "why"/answer-key
 * endpoints (must have already answered this question and gotten it wrong) so
 * the answer key is never an oracle for un-attempted questions.
 */
async function questionAccess(userId: string, questionId: string) {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<{ enrolled: boolean; attempted: boolean; last_incorrect: boolean }>(
      `SELECT
         EXISTS(SELECT 1 FROM questions q JOIN concepts c ON c.id = q.concept_id
                  JOIN module_enrollments e ON e.module_id = c.module_id
                 WHERE q.id = $1 AND e.user_id = app_current_user_id()) AS enrolled,
         EXISTS(SELECT 1 FROM attempts a WHERE a.question_id = $1 AND a.user_id = app_current_user_id()) AS attempted,
         COALESCE((SELECT NOT a.is_correct FROM attempts a
                    WHERE a.question_id = $1 AND a.user_id = app_current_user_id()
                    ORDER BY a.created_at DESC LIMIT 1), false) AS last_incorrect`,
      [questionId],
    );
    return rows[0] ?? { enrolled: false, attempted: false, last_incorrect: false };
  });
}

export function createApp() {
  const app = new Hono<Env>();
  app.use('/api/*', cors());

  // ---- health -------------------------------------------------------------
  app.get('/api/health', (c) =>
    c.json({ ok: true, providers: { embedding: config.embeddingProvider, llm: config.llmProvider } }),
  );

  // ---- auth ---------------------------------------------------------------
  const SignupBody = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    display_name: z.string().min(1).max(80),
  });
  app.post('/api/auth/signup', async (c) => {
    const rl = rateLimit(`signup:ip:${clientIp(c)}`, config.authRateLimitPerMin);
    if (!rl.ok) return c.json({ error: 'too many signup attempts', retry_after: rl.retryAfter }, 429);
    const parsed = SignupBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid signup', details: parsed.error.flatten() }, 400);
    const { email, password, display_name } = parsed.data;
    const password_hash = await hashPassword(password);
    try {
      const { rows } = await adminPool.query<{ id: string }>(
        `INSERT INTO profiles (email, password_hash, display_name) VALUES (lower($1),$2,$3) RETURNING id`,
        [email, password_hash, display_name],
      );
      const id = rows[0]!.id;
      const token = signJwt({ sub: id, email: email.toLowerCase() });
      return c.json({ token, user: { id, email: email.toLowerCase(), display_name } });
    } catch (e: any) {
      if (e?.code === '23505') return c.json({ error: 'email already registered' }, 409);
      throw e;
    }
  });

  // Accept an email OR a bare username (e.g. the dev 'admin' account).
  const LoginBody = z.object({ email: z.string().min(1).max(200), password: z.string().min(1).max(200) });
  app.post('/api/auth/login', async (c) => {
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid login' }, 400);
    const { email, password } = parsed.data;
    // Throttle online brute-force (CWE-307) before the expensive verify: per IP,
    // then per email. Both buckets are checked so neither dimension can be farmed.
    const rlIp = rateLimit(`login:ip:${clientIp(c)}`, config.authRateLimitPerMin);
    if (!rlIp.ok) return c.json({ error: 'too many login attempts', retry_after: rlIp.retryAfter }, 429);
    const rlEmail = rateLimit(`login:email:${email.toLowerCase()}`, config.authRateLimitPerMin);
    if (!rlEmail.ok) return c.json({ error: 'too many login attempts', retry_after: rlEmail.retryAfter }, 429);
    const { rows } = await adminPool.query<{ id: string; password_hash: string; display_name: string }>(
      'SELECT id, password_hash, display_name FROM profiles WHERE email = lower($1)',
      [email],
    );
    const user = rows[0];
    // Always run a verify to keep timing uniform whether or not the user exists.
    const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, 'scrypt$00$00');
    if (!user || !ok) return c.json({ error: 'invalid credentials' }, 401);
    const token = signJwt({ sub: user.id, email: email.toLowerCase() });
    return c.json({ token, user: { id: user.id, email: email.toLowerCase(), display_name: user.display_name } });
  });

  // ---- authenticated routes ----------------------------------------------
  const api = app.basePath('/api');
  api.use('/me', requireAuth);
  api.use('/enroll', requireAuth);
  api.use('/enrollments', requireAuth);
  api.use('/quiz/*', requireAuth);
  api.use('/leaderboard', requireAuth);
  api.use('/stats', requireAuth);

  api.get('/me', async (c) => {
    const userId = c.get('userId');
    const me = await withUser(userId, async (db) => {
      const { rows } = await db.query(
        'SELECT id, email, display_name, role, created_at FROM profiles WHERE id = app_current_user_id()',
      );
      return rows[0] ?? null;
    });
    return c.json({ user: me });
  });

  api.get('/modules', async (c) => {
    const { rows } = await adminPool.query('SELECT slug, name FROM modules ORDER BY name');
    return c.json({ modules: rows });
  });

  const EnrollBody = z.object({ slug: z.string().default(config.moduleSlug) });
  api.post('/enroll', async (c) => {
    const userId = c.get('userId');
    const body = EnrollBody.safeParse(await c.req.json().catch(() => ({})));
    const slug = body.success ? body.data.slug : config.moduleSlug;
    const moduleId = await moduleIdForSlug(slug);
    if (!moduleId) return c.json({ error: 'unknown module' }, 404);
    const enrollment = await withUser(userId, async (db) => {
      // DO NOTHING (idempotent); the app role intentionally has no UPDATE grant.
      await db.query(
        `INSERT INTO module_enrollments (user_id, module_id) VALUES ($1,$2)
         ON CONFLICT (user_id, module_id) DO NOTHING`,
        [userId, moduleId],
      );
      const { rows } = await db.query(
        `SELECT id, module_id, created_at FROM module_enrollments
          WHERE user_id = app_current_user_id() AND module_id = $1`,
        [moduleId],
      );
      return rows[0];
    });
    return c.json({ enrollment, module: slug });
  });

  api.get('/enrollments', async (c) => {
    const userId = c.get('userId');
    const rows = await withUser(userId, async (db) => {
      const r = await db.query(
        `SELECT m.slug, m.name, e.created_at
           FROM module_enrollments e JOIN modules m ON m.id = e.module_id
          WHERE e.user_id = app_current_user_id() ORDER BY m.name`,
      );
      return r.rows;
    });
    return c.json({ enrollments: rows });
  });

  api.get('/quiz/next', async (c) => {
    const userId = c.get('userId');
    const limit = Math.min(20, Math.max(1, parseInt(c.req.query('limit') ?? '5', 10) || 5));
    const moduleId = await moduleIdForSlug(c.req.query('module') ?? config.moduleSlug);
    if (!moduleId) return c.json({ error: 'unknown module' }, 404);
    const result = await withUser(userId, async (db) => {
      const enrolled = await db.query(
        'SELECT 1 FROM module_enrollments WHERE user_id = app_current_user_id() AND module_id = $1',
        [moduleId],
      );
      if (enrolled.rowCount === 0) return { enrolled: false, questions: [] as unknown[] };
      const questions = await selectQuestions(db, moduleId, limit);
      return { enrolled: true, questions };
    });
    if (!result.enrolled) return c.json({ error: 'not enrolled in module' }, 403);
    return c.json({ questions: result.questions });
  });

  const AnswerBody = z.object({
    question_id: z.string().uuid(),
    answer: z.string().max(config.maxAnswerChars),
  });
  api.post('/quiz/answer', async (c) => {
    const userId = c.get('userId');
    const rl = rateLimit(`${userId}:answer`, config.aiRateLimitPerMin);
    if (!rl.ok) return c.json({ error: 'rate limited', retry_after: rl.retryAfter }, 429);

    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > config.aiMaxBodyBytes) return c.json({ error: 'payload too large' }, 413);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const parsed = AnswerBody.safeParse(json);
    if (!parsed.success) return c.json({ error: 'invalid answer body', details: parsed.error.flatten() }, 400);

    // Must be enrolled in the question's module to record a counting attempt.
    const access = await questionAccess(userId, parsed.data.question_id);
    if (!access.enrolled) return c.json({ error: 'not enrolled in this question\'s module' }, 403);

    // The grade is computed SERVER-SIDE; the client never sends is_correct.
    const result = await gradeAndRecord(userId, parsed.data.question_id, parsed.data.answer);
    return c.json(result);
  });

  // BYOK helper: returns the GROUNDED citation context so the browser can
  // generate the explanation with the user's own key (never sent to us).
  api.get('/quiz/why/context', async (c) => {
    const userId = c.get('userId');
    const rl = rateLimit(`${userId}:why`, config.aiRateLimitPerMin);
    if (!rl.ok) return c.json({ error: 'rate limited', retry_after: rl.retryAfter }, 429);
    const questionId = c.req.query('question_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(questionId)) return c.json({ error: 'invalid question_id' }, 400);
    // The answer key is only revealed for a question the user has answered and
    // gotten wrong — never an oracle for un-attempted questions.
    const access = await questionAccess(userId, questionId);
    if (!access.enrolled) return c.json({ error: 'not enrolled' }, 403);
    if (!access.last_incorrect) return c.json({ error: 'answer the question (incorrectly) first' }, 403);
    try {
      const ctx = await buildWhyContext(questionId);
      return c.json(ctx);
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'error' }, e?.status ?? 500);
    }
  });

  // Server-side path: streams a grounded explanation (citation event first).
  api.get('/quiz/why', async (c) => {
    const userId = c.get('userId');
    const rl = rateLimit(`${userId}:why`, config.aiRateLimitPerMin);
    if (!rl.ok) return c.json({ error: 'rate limited', retry_after: rl.retryAfter }, 429);
    const questionId = c.req.query('question_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(questionId)) return c.json({ error: 'invalid question_id' }, 400);
    const userAnswer = (c.req.query('answer') ?? '').slice(0, config.maxAnswerChars);

    const access = await questionAccess(userId, questionId);
    if (!access.enrolled) return c.json({ error: 'not enrolled' }, 403);
    if (!access.last_incorrect) return c.json({ error: 'answer the question (incorrectly) first' }, 403);

    let ctx;
    try {
      ctx = await buildWhyContext(questionId);
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'error' }, e?.status ?? 500);
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'citation',
        data: JSON.stringify({
          question: ctx.question,
          correct_answer: ctx.correct_answer,
          concept_name: ctx.concept_name,
          citations: ctx.citations,
        }),
      });
      try {
        for await (const tok of streamWhy(ctx, userAnswer)) {
          await stream.writeSSE({ event: 'token', data: JSON.stringify({ text: tok }) });
        }
      } catch (e: any) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: e?.message ?? 'stream error' }) });
      }
      await stream.writeSSE({ event: 'done', data: '{}' });
    });
  });

  api.get('/leaderboard', async (c) => {
    const userId = c.get('userId');
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10) || 50));
    const rows = await withUser(userId, async (db) => {
      // Server-authoritative: aggregates derived from attempts via a
      // SECURITY DEFINER function. No client-supplied totals are accepted.
      const r = await db.query('SELECT * FROM leaderboard($1)', [limit]);
      return r.rows;
    });
    return c.json({ leaderboard: rows, me: userId });
  });

  api.get('/stats', async (c) => {
    const userId = c.get('userId');
    const data = await withUser(userId, async (db) => {
      const totals = await db.query(
        `SELECT count(*)::int AS answered,
                count(*) FILTER (WHERE is_correct)::int AS correct
           FROM attempts WHERE user_id = app_current_user_id()`,
      );
      const concepts = await db.query(
        `SELECT c.id, c.name, c.week, k.score, k.last_tested
           FROM knowledge k JOIN concepts c ON c.id = k.concept_id
          WHERE k.user_id = app_current_user_id()
          ORDER BY k.score ASC NULLS FIRST`,
      );
      return { totals: totals.rows[0], concepts: concepts.rows };
    });
    return c.json(data);
  });

  // ---- static frontend ----------------------------------------------------
  app.use('/*', serveStatic({ root: './web' }));
  app.get('/', serveStatic({ path: './web/index.html' }));

  return app;
}
