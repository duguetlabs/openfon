-- Calm Studio domain foundation.
--
-- The old schema represented the receptionist as one agent_settings row tied
-- to a business. Keep that row for one compatibility release, but make the new
-- assistant record the source of truth for all multi-assistant routes.

-- The product boundary has always been one workspace per account, but 0001 did
-- not encode it and the old SELECT-then-INSERT route could race. A trigger is
-- intentionally used instead of a unique index: it enforces every future write
-- without making upgrades fail for an installation that already contains a
-- historical duplicate. Reads choose one canonical row deterministically.
CREATE INDEX idx_businesses_user_created ON businesses(user_id, created_at, id);
CREATE TRIGGER businesses_one_workspace_per_user
BEFORE INSERT ON businesses
WHEN EXISTS (SELECT 1 FROM businesses WHERE user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'one workspace per account');
END;
CREATE TRIGGER businesses_one_workspace_per_user_update
BEFORE UPDATE OF user_id ON businesses
WHEN NEW.user_id <> OLD.user_id
  AND EXISTS (SELECT 1 FROM businesses WHERE user_id = NEW.user_id AND id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'one workspace per account');
END;

CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  public_slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'paused')),
  name TEXT NOT NULL DEFAULT 'Alex',
  greeting TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT 'friendly and professional',
  language TEXT NOT NULL DEFAULT 'en',
  voice TEXT NOT NULL DEFAULT '',
  take_messages INTEGER NOT NULL DEFAULT 1,
  custom_instructions TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT 'pipeline',
  realtime_model TEXT NOT NULL DEFAULT '',
  realtime_voice TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);
CREATE INDEX idx_assistants_business ON assistants(business_id, created_at);
CREATE INDEX idx_assistants_state ON assistants(business_id, state);

-- Preserve every existing public URL and voice/behavior choice. Deterministic
-- ids keep the migration idempotent in copied development databases.
INSERT INTO assistants (
  id, business_id, public_slug, state, name, greeting, persona, language,
  voice, take_messages, custom_instructions, engine, realtime_model,
  realtime_voice, llm_model, created_at, updated_at, activated_at
)
SELECT
  'asst_' || b.id,
  b.id,
  b.slug,
  'active',
  COALESCE(a.agent_name, 'Alex'),
  COALESCE(a.greeting, ''),
  COALESCE(a.persona, 'friendly and professional'),
  COALESCE(a.language, 'en'),
  COALESCE(a.voice, ''),
  COALESCE(a.take_messages, 1),
  COALESCE(a.custom_instructions, ''),
  COALESCE(a.engine, 'pipeline'),
  COALESCE(a.realtime_model, ''),
  COALESCE(a.realtime_voice, ''),
  COALESCE(a.llm_model, ''),
  b.created_at,
  b.created_at,
  b.created_at
FROM businesses b
LEFT JOIN agent_settings a ON a.business_id = b.id;

-- Lifecycle validity must hold at execution time, not only after an API read:
-- concurrent edits and activation requests can otherwise race stale checks.
-- Existing rows are preserved above; every future activation or active edit is
-- constrained to complete essentials.
CREATE TRIGGER assistants_active_essentials_insert
BEFORE INSERT ON assistants
WHEN NEW.state = 'active'
  AND (
    trim(NEW.name, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
    OR trim(NEW.persona, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
    OR trim(NEW.language, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
  )
BEGIN
  SELECT RAISE(ABORT, 'active assistant requires complete essentials');
END;
CREATE TRIGGER assistants_active_essentials_update
BEFORE UPDATE OF state, name, persona, language ON assistants
WHEN NEW.state = 'active'
  AND (
    trim(NEW.name, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
    OR trim(NEW.persona, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
    OR trim(NEW.language, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''
  )
BEGIN
  SELECT RAISE(ABORT, 'active assistant requires complete essentials');
END;

-- Provider endpoints and credentials are workspace-wide. The API never returns
-- llm_api_key; it reports only whether one is configured.
CREATE TABLE provider_settings (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  llm_base_url TEXT NOT NULL DEFAULT '',
  llm_api_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key, created_at, updated_at)
SELECT
  b.id,
  COALESCE(a.llm_base_url, ''),
  COALESCE(a.llm_api_key, ''),
  b.created_at,
  b.created_at
FROM businesses b
LEFT JOIN agent_settings a ON a.business_id = b.id;

-- A compact source snapshot lets the public call path notice mixed-version
-- writes without running the full reconciliation on every call. Old workers
-- continue to update businesses/agent_settings; the new worker compares those
-- rows with this snapshot and repairs only when they diverge.
CREATE TABLE compatibility_sync_state (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  services_json TEXT NOT NULL DEFAULT '[]',
  faqs_json TEXT NOT NULL DEFAULT '[]',
  collection_id TEXT NOT NULL DEFAULT '',
  agent_snapshot TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO compatibility_sync_state (business_id, services_json, faqs_json, collection_id, agent_snapshot, synced_at)
SELECT b.id, b.services_json, b.faqs_json, 'kc_default_' || b.id,
  json_object(
    'agent_name', a.agent_name, 'greeting', a.greeting, 'persona', a.persona,
    'language', a.language, 'voice', a.voice, 'take_messages', a.take_messages,
    'custom_instructions', a.custom_instructions, 'engine', a.engine,
    'realtime_model', a.realtime_model, 'realtime_voice', a.realtime_voice,
    'llm_model', a.llm_model
  ),
  b.created_at
FROM businesses b JOIN agent_settings a ON a.business_id=b.id;

-- New presets deliberately contain no endpoint or credential fields. Legacy
-- engine_profiles remains available to the compatibility routes for one
-- release; its rows are copied here with the same ids.
CREATE TABLE engine_presets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'pipeline',
  realtime_model TEXT NOT NULL DEFAULT '',
  realtime_voice TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  voice TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_engine_presets_business ON engine_presets(business_id, created_at);
INSERT INTO engine_presets (
  id, business_id, name, engine, realtime_model, realtime_voice, language,
  voice, llm_model, created_at, updated_at
)
SELECT
  id, business_id, name, engine, realtime_model, realtime_voice, language,
  voice, llm_model, created_at, created_at
FROM engine_profiles;

-- Calls keep connected_at and every stale-call invariant introduced in 0007.
ALTER TABLE calls ADD COLUMN assistant_id TEXT REFERENCES assistants(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN environment TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('test', 'live'));
ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE calls ADD COLUMN outcome TEXT;
ALTER TABLE calls ADD COLUMN unanswered_json TEXT;
ALTER TABLE calls ADD COLUMN failure_code TEXT;
ALTER TABLE calls ADD COLUMN failure_message TEXT;

UPDATE calls
SET assistant_id = 'asst_' || business_id,
    environment = 'live',
    direction = 'inbound';

CREATE INDEX idx_calls_assistant_started ON calls(assistant_id, started_at DESC, id DESC);
CREATE INDEX idx_calls_workspace_scope ON calls(business_id, environment, started_at DESC, id DESC);

-- Workspace facts remain on businesses. Reusable knowledge lives in named
-- collections that may be attached to any number of assistants.
CREATE TABLE knowledge_collections (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, name)
);
CREATE INDEX idx_knowledge_collections_business ON knowledge_collections(business_id, created_at);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('faq', 'service', 'note')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  title TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  source_turn_id INTEGER REFERENCES call_turns(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);
CREATE INDEX idx_knowledge_items_collection ON knowledge_items(collection_id, status, created_at);
CREATE INDEX idx_knowledge_items_source_call ON knowledge_items(source_call_id);

CREATE TABLE assistant_knowledge_collections (
  assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assistant_id, collection_id)
);
CREATE INDEX idx_assistant_collections_collection ON assistant_knowledge_collections(collection_id, assistant_id);

INSERT INTO knowledge_collections (id, business_id, name, description, is_default, created_at, updated_at)
SELECT
  'kc_default_' || id,
  id,
  'Workspace knowledge',
  'Services and answers shared by default with new assistants.',
  1,
  created_at,
  created_at
FROM businesses;

INSERT INTO assistant_knowledge_collections (assistant_id, collection_id, attached_at)
SELECT 'asst_' || id, 'kc_default_' || id, created_at FROM businesses;

-- Existing JSON data remains on businesses for the compatibility API and is
-- copied into active knowledge items for the new prompt path.
INSERT INTO knowledge_items (
  id, business_id, collection_id, kind, status, title, content,
  created_at, updated_at, activated_at
)
SELECT
  'ki_service_' || b.id || '_' || j.key,
  b.id,
  'kc_default_' || b.id,
  'service',
  'active',
  COALESCE(json_extract(j.value, '$.name'), ''),
  trim(
    COALESCE(json_extract(j.value, '$.price'), '') ||
    CASE WHEN COALESCE(json_extract(j.value, '$.duration'), '') <> ''
      THEN CASE WHEN COALESCE(json_extract(j.value, '$.price'), '') <> '' THEN ' · ' ELSE '' END || json_extract(j.value, '$.duration')
      ELSE '' END ||
    CASE WHEN COALESCE(json_extract(j.value, '$.notes'), '') <> ''
      THEN CASE WHEN COALESCE(json_extract(j.value, '$.price'), '') <> '' OR COALESCE(json_extract(j.value, '$.duration'), '') <> '' THEN ' — ' ELSE '' END || json_extract(j.value, '$.notes')
      ELSE '' END
  ),
  b.created_at,
  b.created_at,
  b.created_at
FROM businesses b, json_each(
  CASE
    WHEN json_valid(b.services_json) THEN
      CASE WHEN json_type(b.services_json) = 'array' THEN b.services_json ELSE '[]' END
    ELSE '[]'
  END
) j
WHERE j.type = 'object'
  AND trim(COALESCE(json_extract(j.value, '$.name'), '')) <> '';

INSERT INTO knowledge_items (
  id, business_id, collection_id, kind, status, question, answer,
  created_at, updated_at, activated_at
)
SELECT
  'ki_faq_' || b.id || '_' || j.key,
  b.id,
  'kc_default_' || b.id,
  'faq',
  'active',
  COALESCE(json_extract(j.value, '$.q'), ''),
  COALESCE(json_extract(j.value, '$.a'), ''),
  b.created_at,
  b.created_at,
  b.created_at
FROM businesses b, json_each(
  CASE
    WHEN json_valid(b.faqs_json) THEN
      CASE WHEN json_type(b.faqs_json) = 'array' THEN b.faqs_json ELSE '[]' END
    ELSE '[]'
  END
) j
WHERE j.type = 'object'
  AND trim(COALESCE(json_extract(j.value, '$.q'), '')) <> ''
  AND trim(COALESCE(json_extract(j.value, '$.a'), '')) <> '';
