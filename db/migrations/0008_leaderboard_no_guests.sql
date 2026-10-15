-- Keep throwaway guest accounts off the leaderboard.
--
-- Guest accounts (email @guest.studybuddy.invalid, created by POST /api/auth/guest)
-- are deleted after a few days and used to fill the board with "Guest xxxx 0.0%"
-- rows. The board now lists real accounts only, and only those with at least one
-- graded attempt (the JOIN already guarantees the latter).

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
  WHERE p.email NOT LIKE '%@guest.studybuddy.invalid'
  GROUP BY p.id, p.display_name
  ORDER BY correct DESC, answered DESC, p.display_name ASC
  LIMIT greatest(1, least(coalesce(limit_n, 50), 200));
$$;

REVOKE ALL ON FUNCTION leaderboard(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leaderboard(int) TO studybuddy_app;
