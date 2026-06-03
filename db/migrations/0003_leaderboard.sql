-- Server-authoritative leaderboard.
--
-- The ONLY way scores reach a client. It is a SECURITY DEFINER function owned
-- by studybuddy_owner, so it can aggregate across all users' attempts (which
-- RLS otherwise hides from the app role) while returning ONLY aggregates --
-- never a raw attempt row, never a client-supplied number. Totals are derived
-- purely from the attempts table, which the app role cannot write.

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
    count(a.*)                                   AS answered,
    count(a.*) FILTER (WHERE a.is_correct)       AS correct,
    round(100.0 * count(a.*) FILTER (WHERE a.is_correct)
          / NULLIF(count(a.*), 0), 1)            AS accuracy
  FROM profiles p
  JOIN attempts a ON a.user_id = p.id
  GROUP BY p.id, p.display_name
  ORDER BY correct DESC, answered DESC, p.display_name ASC
  LIMIT greatest(1, least(coalesce(limit_n, 50), 200));
$$;

-- Lock the function down: only the app role may call it, nobody else.
REVOKE ALL ON FUNCTION leaderboard(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leaderboard(int) TO studybuddy_app;
