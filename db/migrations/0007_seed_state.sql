-- Small key/value table the demo seed uses to notice when the question bank
-- file changes (so it re-imports). Owner-only: no grant to the app role.
CREATE TABLE IF NOT EXISTS seed_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
