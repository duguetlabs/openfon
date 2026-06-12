-- Named voice-engine presets: a saved combination of engine mode, tier,
-- voices, language, and LLM backend that can be applied to the live agent
-- settings in one action.
CREATE TABLE engine_profiles (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'pipeline',
  realtime_model TEXT NOT NULL DEFAULT '',
  realtime_voice TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  voice TEXT NOT NULL DEFAULT '',
  llm_base_url TEXT NOT NULL DEFAULT '',
  llm_api_key TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_profiles_business ON engine_profiles(business_id);
