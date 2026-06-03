-- Runs once on first container init (as the superuser studybuddy_owner).
-- Creates the pgvector extension and the un-privileged application role.
--
-- Role model:
--   studybuddy_owner  - superuser, owns all tables. Used by migrations,
--                       ingestion and the AI pipelines. BYPASSES RLS, so it
--                       is the only principal that can write shared course
--                       content and grade-derived rows.
--   studybuddy_app    - plain LOGIN role with no BYPASSRLS. The HTTP API
--                       connects as this role for every user-scoped request.
--                       RLS is FORCED on user tables, so it can only ever
--                       touch the rows belonging to the authenticated user.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studybuddy_app') THEN
    CREATE ROLE studybuddy_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- App role may connect and use the public schema, but owns nothing.
GRANT CONNECT ON DATABASE studybuddy TO studybuddy_app;
GRANT USAGE ON SCHEMA public TO studybuddy_app;
