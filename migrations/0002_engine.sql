-- Voice engine selection per business: 'pipeline' (STT->LLM->TTS, default,
-- works with any OpenAI-compatible provider) or 'realtime' (low-latency
-- bridge to an OpenAI Realtime-compatible endpoint, with barge-in).
ALTER TABLE agent_settings ADD COLUMN engine TEXT NOT NULL DEFAULT 'pipeline';
