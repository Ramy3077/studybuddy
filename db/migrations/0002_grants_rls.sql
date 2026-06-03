-- Privileges + Row-Level Security for the un-privileged studybuddy_app role.
--
-- Design:
--   * studybuddy_owner owns every table and (being superuser in dev) bypasses
--     RLS. All ingestion, concept/question generation, grading and knowledge
--     writes go through this role -> server-authoritative.
--   * studybuddy_app is the ONLY role the HTTP API uses for user requests.
--     It has no BYPASSRLS. Each request runs in a transaction that sets
--     app.current_user_id; policies below pin every row to that id.

-- The app role gets no default table rights; we grant explicitly per table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM studybuddy_app;

-- Helper: current authenticated user id (NULL when unset -> policies deny).
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- ===========================================================================
-- Shared, read-only course content
-- ===========================================================================
-- App role may read, never write. (No write grant = writes are impossible.)
GRANT SELECT ON sources, source_chunks, concepts TO studybuddy_app;

-- questions: the answer key (correct_answer, explanation, evidence_quote) is
-- NOT even readable by the quiz-serving role. Grading reads it via the owner
-- connection. This is column-level defence-in-depth against accidental leaks.
GRANT SELECT (id, concept_id, type, question, options, source_chunk_ids, created_at)
  ON questions TO studybuddy_app;

-- Enable RLS on content tables with a read-to-all policy (belt & suspenders;
-- there is no write grant regardless).
ALTER TABLE sources       ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions     ENABLE ROW LEVEL SECURITY;

CREATE POLICY content_read_all ON sources       FOR SELECT USING (true);
CREATE POLICY content_read_all ON source_chunks FOR SELECT USING (true);
-- Only *live* concepts are visible to the app role; drafts stay owner-only.
CREATE POLICY content_read_live ON concepts     FOR SELECT USING (status = 'live');
CREATE POLICY content_read_all ON questions     FOR SELECT USING (true);

-- ===========================================================================
-- profiles  (own row; privileged columns locked down)
-- ===========================================================================
-- Read everything except the password hash; update only the display name.
GRANT SELECT (id, email, display_name, role, created_at) ON profiles TO studybuddy_app;
GRANT UPDATE (display_name) ON profiles TO studybuddy_app;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own ON profiles
  FOR SELECT USING (id = app_current_user_id());
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());

-- Even though the column-level GRANT already prevents the app role from
-- writing role/email/password_hash, add a trigger so the rule is enforced for
-- ANY non-owner principal (defence in depth; satisfies "trigger OR column
-- policy" with both). The owner (server) may change privileged columns.
CREATE OR REPLACE FUNCTION protect_privileged_profile_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'studybuddy_owner' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'privileged profile columns (id/email/role/password_hash) are not client-writable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_protect_privileged_profile_columns
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION protect_privileged_profile_columns();

-- ===========================================================================
-- module_enrollments  (own rows; client may create/delete)
-- ===========================================================================
GRANT SELECT, INSERT, DELETE ON module_enrollments TO studybuddy_app;

ALTER TABLE module_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_enrollments FORCE ROW LEVEL SECURITY;

CREATE POLICY enroll_select_own ON module_enrollments
  FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY enroll_insert_own ON module_enrollments
  FOR INSERT WITH CHECK (user_id = app_current_user_id());
CREATE POLICY enroll_delete_own ON module_enrollments
  FOR DELETE USING (user_id = app_current_user_id());

-- ===========================================================================
-- attempts  (own rows readable; NO client writes at all)
-- ===========================================================================
-- SELECT only. Inserts happen via the owner role after server-side grading,
-- so a crafted client request can never add to its own counts.
GRANT SELECT ON attempts TO studybuddy_app;

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY attempts_select_own ON attempts
  FOR SELECT USING (user_id = app_current_user_id());

-- ===========================================================================
-- knowledge  (own rows readable; NO client writes; server derives it)
-- ===========================================================================
GRANT SELECT ON knowledge TO studybuddy_app;

ALTER TABLE knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_select_own ON knowledge
  FOR SELECT USING (user_id = app_current_user_id());

-- modules are public read.
GRANT SELECT ON modules TO studybuddy_app;
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY modules_read_all ON modules FOR SELECT USING (true);
