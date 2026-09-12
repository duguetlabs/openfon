-- Additive workspace configuration. Existing instance defaults remain unchanged.
ALTER TABLE provider_settings ADD COLUMN llm_model TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN realtime_provider TEXT NOT NULL DEFAULT 'instance' CHECK (realtime_provider IN ('instance', 'kataleptic', 'openai', 'custom'));
ALTER TABLE provider_settings ADD COLUMN realtime_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN realtime_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN stt_provider TEXT NOT NULL DEFAULT 'instance' CHECK (stt_provider IN ('instance', 'openai', 'custom'));
ALTER TABLE provider_settings ADD COLUMN stt_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN stt_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN stt_model TEXT NOT NULL DEFAULT '';
