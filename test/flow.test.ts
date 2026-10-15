import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { adminPool } from '../src/db/pool.js';
import { discoverVault } from '../src/ingest/discover.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { cleanObsidian } from '../src/ingest/markdown.js';
import { collapseWs, isVerbatimSubstring, stripInlineMarkup } from '../src/util/text.js';

// End-to-end API flow against the real database, with nothing stubbed except
// the providers (the offline mock embeddings and explainer, as in the demo):
//
//   real demo note -> real ingest -> grounded question from the real bank
//   guest login -> enrol -> fetch question -> wrong answer -> "why" stream
//
// It runs in its own throwaway module, so it never touches the module the
// app or the other tests use, and everything it creates is deleted after.

const app = createApp();
const slug = `flow-${Date.now().toString(36)}`;
const CORPUS_WEEK = 'Week 1';

interface BankQuestion {
  type: 'mcq' | 'free_form';
  question: string;
  options: string[] | null;
  correct_answer: string;
  explanation: string;
  evidence_quote: string;
}
interface BankConcept {
  name: string;
  description: string;
  key_facts: string[];
  difficulty: number;
  questions: BankQuestion[];
}

let moduleId = '';
let tmp = '';
let bankQ: BankQuestion;
let corpusText = ''; // every Week 1 note, cleaned the same way ingest cleans it
let guestId = '';

const norm = (s: string) => collapseWs(stripInlineMarkup(s)).toLowerCase();

beforeAll(async () => {
  const mod = await adminPool.query<{ id: string }>(
    `INSERT INTO modules (slug, name) VALUES ($1, 'Flow test module') RETURNING id`,
    [slug],
  );
  moduleId = mod.rows[0]!.id;

  // Ingest a copy of the real demo notes so vault paths cannot collide with a seeded demo.
  tmp = await mkdtemp(join(tmpdir(), 'studybuddy-flow-'));
  await cp(join('demo/corpus', CORPUS_WEEK), join(tmp, CORPUS_WEEK), { recursive: true });
  const { files } = await discoverVault(tmp, slug);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const stats = await ingestFile(f, moduleId);
    expect(stats.status).toBe('ingested');
    corpusText += ' ' + cleanObsidian(await readFile(f.vaultPath, 'utf8'));
  }

  // Take the first multiple-choice question for that week from the real authored bank
  // and attach it to the chunk that contains its evidence quote, as the importer does.
  const bank = JSON.parse(await readFile('demo/questions.json', 'utf8')) as {
    results: { week: number; concepts: BankConcept[] }[];
  };
  const concept = bank.results.find((w) => w.week === 1)!.concepts[0]!;
  bankQ = concept.questions.find((q) => q.type === 'mcq')!;

  const { rows: chunks } = await adminPool.query<{ id: string; text: string }>(
    `SELECT c.id, c.text FROM source_chunks c JOIN sources s ON s.id = c.source_id WHERE s.module_id = $1`,
    [moduleId],
  );
  const host = chunks.find((c) => isVerbatimSubstring(stripInlineMarkup(bankQ.evidence_quote), c.text));
  expect(host, 'bank evidence quote should be found in an ingested chunk').toBeDefined();

  const c = await adminPool.query<{ id: string }>(
    `INSERT INTO concepts (module_id, name, description, key_facts, difficulty, week, source_chunk_ids, status, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,1,$6,'live',$7) RETURNING id`,
    [moduleId, concept.name, concept.description, concept.key_facts, concept.difficulty, [host!.id], `flow_${slug}`],
  );
  await adminPool.query(
    `INSERT INTO questions (concept_id, type, question, options, correct_answer, explanation, source_chunk_ids, evidence_quote)
     VALUES ($1,'mcq',$2,$3::jsonb,$4,$5,$6,$7)`,
    [
      c.rows[0]!.id,
      bankQ.question,
      JSON.stringify(bankQ.options),
      bankQ.correct_answer,
      bankQ.explanation,
      [host!.id],
      stripInlineMarkup(bankQ.evidence_quote).trim(),
    ],
  );
});

afterAll(async () => {
  if (guestId) await adminPool.query('DELETE FROM profiles WHERE id = $1', [guestId]);
  if (moduleId) await adminPool.query('DELETE FROM modules WHERE id = $1', [moduleId]);
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

function parseSse(body: string): { event: string; data: any }[] {
  return body
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return event && data ? { event, data: JSON.parse(data) } : null;
    })
    .filter((e): e is { event: string; data: any } => e !== null);
}

describe('guest revision flow over HTTP', () => {
  it('guest login -> question -> wrong answer -> explanation quoting the notes verbatim', async () => {
    // 1. Guest login.
    const login = await app.request('/api/auth/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.42' },
      body: '{}',
    });
    expect(login.status).toBe(200);
    const { token, user } = (await login.json()) as { token: string; user: { id: string } };
    guestId = user.id;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // 2. Enrol in the test module.
    const enrol = await app.request('/api/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ slug }) });
    expect(enrol.status).toBe(200);

    // 3. Fetch a question. The answer key and evidence quote are not sent to the client.
    const next = await app.request(`/api/quiz/next?module=${slug}&limit=5`, { headers: auth });
    expect(next.status).toBe(200);
    const { questions } = (await next.json()) as {
      questions: { question: { id: string; question: string; options: string[] } }[];
    };
    expect(questions).toHaveLength(1);
    const q = questions[0]!.question;
    expect(q.question).toBe(bankQ.question);
    expect(JSON.stringify(questions)).not.toContain('correct_answer');
    expect(JSON.stringify(questions)).not.toContain('evidence_quote');

    // 4. Submit a wrong option. The server grades it.
    const wrong = q.options.find((o) => o !== bankQ.correct_answer)!;
    const ans = await app.request('/api/quiz/answer', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ question_id: q.id, answer: wrong }),
    });
    expect(ans.status).toBe(200);
    const graded = (await ans.json()) as { is_correct: boolean; correct_answer: string };
    expect(graded.is_correct).toBe(false);
    expect(graded.correct_answer).toBe(bankQ.correct_answer);

    // 5. Ask why. The stream sends server-built citations first, then the explanation.
    const why = await app.request(
      `/api/quiz/why?question_id=${q.id}&answer=${encodeURIComponent(wrong)}`,
      { headers: auth },
    );
    expect(why.status).toBe(200);
    const events = parseSse(await why.text());
    const citation = events.find((e) => e.event === 'citation')!.data as {
      citations: { quote: string; source_label: string; week: number }[];
    };
    const explanation = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    expect(events.at(-1)!.event).toBe('done');

    const primary = citation.citations[0]!;
    expect(primary.week).toBe(1);
    expect(primary.source_label).toMatch(/^Week 1 /);
    // The primary quote is the question's evidence quote...
    expect(norm(primary.quote)).toBe(norm(bankQ.evidence_quote));
    // ...it appears word for word in the original note on disk...
    expect(norm(corpusText)).toContain(norm(primary.quote));
    // ...and the explanation the student reads contains that quote.
    expect(norm(explanation)).toContain(norm(primary.quote).replace(/[.\s]+$/, ''));
    // Every other citation is also a verbatim span of the notes.
    for (const c of citation.citations) expect(norm(corpusText)).toContain(norm(c.quote));
  });
});
