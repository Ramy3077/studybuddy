-- Harden the leaderboard against replay inflation.
--
-- attempts is a full history (the same question is re-tested over time for
-- spaced repetition), so a user can legitimately have many rows per question.
-- Counting RAW rows let an authenticated user inflate their totals by replaying
-- a known-correct answer to /quiz/answer. We instead count DISTINCT questions:
--   answered = distinct questions the user has attempted
--   correct  = distinct questions the user has ever answered correctly
-- Re-answering the same question (right or wrong) can no longer move the totals,
-- so there is no way to add to your own counts beyond the fixed question pool.

CREATE OR REPLACE FUNCTION leaderboard(limit_n int DEFAULT 50)
RETURNS TABLE (
  user_id      uuid,
  display_name text,
  answered     bigint,
  correct      bigint,
  accuracy     numeric
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    p.id,
    p.display_name,
    count(DISTINCT a.question_id)                                          AS answered,
    count(DISTINCT a.question_id) FILTER (WHERE a.is_correct)              AS correct,
    round(100.0 * count(DISTINCT a.question_id) FILTER (WHERE a.is_correct)
          / NULLIF(count(DISTINCT a.question_id), 0), 1)                   AS accuracy
  FROM profiles p
  JOIN attempts a ON a.user_id = p.id
  GROUP BY p.id, p.display_name
  ORDER BY correct DESC, answered DESC, p.display_name ASC
  LIMIT greatest(1, least(coalesce(limit_n, 50), 200));
$$;

REVOKE ALL ON FUNCTION leaderboard(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leaderboard(int) TO studybuddy_app;
