-- Independent synthesis credentials; existing workspaces retain instance behavior.
ALTER TABLE provider_settings ADD COLUMN tts_provider TEXT NOT NULL DEFAULT 'instance' CHECK (tts_provider IN ('instance','browser','azure','openai','custom'));
ALTER TABLE provider_settings ADD COLUMN tts_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN tts_api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_settings ADD COLUMN tts_model TEXT NOT NULL DEFAULT '';
