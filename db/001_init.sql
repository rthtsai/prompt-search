BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;

CREATE TABLE IF NOT EXISTS schema_migration(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), handle text UNIQUE NOT NULL,
  display_name text NOT NULL, shared_count integer NOT NULL DEFAULT 0 CHECK(shared_count >= 0),
  unlocked_quota integer NOT NULL DEFAULT 0 CHECK(unlocked_quota >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  parent_id uuid REFERENCES category(id), slug text UNIQUE NOT NULL,
  CHECK(id <> parent_id)
);
CREATE FUNCTION enforce_category_depth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM category WHERE id=NEW.parent_id AND parent_id IS NOT NULL)
       OR EXISTS(SELECT 1 FROM category WHERE parent_id=NEW.id) THEN
      RAISE EXCEPTION 'category depth cannot exceed two levels';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER category_depth BEFORE INSERT OR UPDATE ON category FOR EACH ROW EXECUTE FUNCTION enforce_category_depth();
INSERT INTO category(name,slug) VALUES
('寫作','writing'),('報告文書','reports'),('翻譯與潤稿','translation'),('程式','code'),
('資料分析','data'),('圖像生成','images'),('影音','media'),('行銷文案','marketing'),
('教學備課','education'),('生活雜務','life'),('角色與人設','roles'),('其他','other');

CREATE TABLE prompt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK(length(body) BETWEEN 20 AND 24000), summary text NOT NULL,
  use_case text NOT NULL, model_hint text[] NOT NULL DEFAULT '{}', variables jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(variables)='array'),
  tags text[] NOT NULL DEFAULT '{}', category_id uuid NOT NULL REFERENCES category(id),
  lang text NOT NULL CHECK(lang IN ('zh-Hant','zh-Hans','en')),
  visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared','public')),
  author_id uuid NOT NULL REFERENCES app_user(id), source text NOT NULL,
  source_body text NOT NULL CHECK(length(source_body) BETWEEN 20 AND 24000),
  quality_score real NOT NULL DEFAULT 0 CHECK(quality_score BETWEEN 0 AND 1),
  use_count integer NOT NULL DEFAULT 0 CHECK(use_count >= 0),
  fork_of uuid REFERENCES prompt(id) DEFERRABLE INITIALLY DEFERRED,
  embedding vector(1536) NOT NULL, embedding_model text NOT NULL,
  normalized_hash text NOT NULL CHECK(normalized_hash ~ '^[a-f0-9]{64}$'),
  simhash text NOT NULL CHECK(simhash ~ '^[a-f0-9]{16}$'),
  premium boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','duplicate')),
  search_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(author_id, normalized_hash), CHECK(id <> fork_of)
);
CREATE FUNCTION refresh_prompt_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(concat_ws(E'\n',NEW.title,NEW.summary,NEW.use_case,array_to_string(NEW.tags,' '),array_to_string(NEW.model_hint,' '),NEW.body));
  RETURN NEW;
END $$;
CREATE TRIGGER prompt_search_text BEFORE INSERT OR UPDATE ON prompt FOR EACH ROW EXECUTE FUNCTION refresh_prompt_search_text();
CREATE INDEX prompt_embedding_hnsw ON prompt USING hnsw(embedding vector_cosine_ops) WHERE state='active';
CREATE INDEX prompt_chinese_gin ON prompt USING gin(search_text gin_bigm_ops) WHERE state='active';
CREATE INDEX prompt_tags_gin ON prompt USING gin(tags) WHERE state='active';
CREATE INDEX prompt_models_gin ON prompt USING gin(model_hint) WHERE state='active';
CREATE INDEX prompt_category ON prompt(category_id) WHERE state='active';
CREATE INDEX prompt_author ON prompt(author_id,state);

CREATE TABLE usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_user(id),
  prompt_id uuid NOT NULL REFERENCES prompt(id), used_at timestamptz NOT NULL DEFAULT now(),
  filled_vars jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(filled_vars)='object')
);
CREATE INDEX usage_user_recent ON usage_log(user_id,used_at DESC);
CREATE INDEX usage_user_prompt ON usage_log(user_id,prompt_id,used_at DESC);
CREATE TABLE unlock (
  user_id uuid NOT NULL REFERENCES app_user(id), prompt_id uuid NOT NULL REFERENCES prompt(id),
  unlocked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,prompt_id)
);

-- This database is a server/CLI data store. Never expose its credentials to a browser.
-- RLS supplements application filtering. The production role must not have BYPASSRLS.
ALTER TABLE prompt ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE unlock ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompt_read ON prompt FOR SELECT USING(author_id=nullif(current_setting('app.user_id',true),'')::uuid OR visibility='public');
CREATE POLICY prompt_insert ON prompt FOR INSERT WITH CHECK(author_id=nullif(current_setting('app.user_id',true),'')::uuid AND visibility='private' AND premium=false);
CREATE POLICY prompt_update ON prompt FOR UPDATE USING(author_id=nullif(current_setting('app.user_id',true),'')::uuid) WITH CHECK(author_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY usage_own ON usage_log FOR SELECT USING(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY unlock_own ON unlock FOR SELECT USING(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY user_own ON app_user FOR SELECT USING(id=nullif(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON prompt,usage_log,unlock,app_user FROM PUBLIC;
INSERT INTO schema_migration(version) VALUES(1);
COMMIT;
