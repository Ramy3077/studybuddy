-- Core schema. Runs as studybuddy_owner (owner of every object created here).
-- pgvector is created in db/bootstrap/00-bootstrap.sql (needs superuser).

-- ---------------------------------------------------------------------------
-- Modules & users
-- ---------------------------------------------------------------------------
CREATE TABLE modules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- profiles doubles as the auth identity. password_hash + role are privileged
-- columns (see 0002_grants_rls.sql): the app role can neither read the hash
-- nor write role/email/password_hash.
CREATE TABLE profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE module_enrollments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  module_id  uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module_id)
);

-- ---------------------------------------------------------------------------
-- Ingested course content (shared, read-only to authenticated users)
-- ---------------------------------------------------------------------------
CREATE TABLE sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text NOT NULL CHECK (source_type IN ('slides', 'notes', 'transcript')),
  module       text NOT NULL,
  module_id    uuid REFERENCES modules(id) ON DELETE CASCADE,
  title        text NOT NULL,
  code         text,
  week         int,
  vault_path   text NOT NULL UNIQUE,
  content_hash text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_chunks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_index    int NOT NULL,
  text           text NOT NULL,
  embedding      vector(1536),
  locator        jsonb NOT NULL DEFAULT '{}',
  token_estimate int,
  UNIQUE (source_id, chunk_index)
);

-- Approximate-nearest-neighbour index (cosine). HNSW for good recall/latency.
CREATE INDEX source_chunks_embedding_hnsw
  ON source_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX source_chunks_source_idx ON source_chunks (source_id);

-- ---------------------------------------------------------------------------
-- Concepts & questions (derived content, read-only to authenticated users)
-- ---------------------------------------------------------------------------
CREATE TABLE concepts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id        uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  key_facts        text[] NOT NULL DEFAULT '{}',
  difficulty       int NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  week             int,
  source_chunk_ids uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
  dedupe_key       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_id, dedupe_key)
);
CREATE INDEX concepts_module_status_idx ON concepts (module_id, status);

CREATE TABLE questions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id       uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('mcq', 'free_form')),
  question         text NOT NULL,
  options          jsonb,
  correct_answer   text NOT NULL,
  explanation      text NOT NULL DEFAULT '',
  source_chunk_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_quote   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_concept_idx ON questions (concept_id);

-- ---------------------------------------------------------------------------
-- Per-user learning state (private; server-authoritative writes)
-- ---------------------------------------------------------------------------

-- attempts is the AUTHORITATIVE record of what each user answered. Rows are
-- written ONLY by the server (owner role) after it grades an answer. The app
-- role is granted SELECT (own rows only) but NO write privilege at all, so a
-- client can never insert a row that inflates its own counts.
CREATE TABLE attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  concept_id  uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  is_correct  boolean NOT NULL,
  user_answer text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attempts_user_idx ON attempts (user_id);
CREATE INDEX attempts_user_concept_idx ON attempts (user_id, concept_id);

-- knowledge holds the decaying per-concept confidence score. Derived from
-- attempts; written only by the server (owner role).
CREATE TABLE knowledge (
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  concept_id  uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  score       real NOT NULL DEFAULT 0,
  last_tested timestamptz,
  history     jsonb NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, concept_id)
);

CREATE INDEX knowledge_user_idx ON knowledge (user_id);
