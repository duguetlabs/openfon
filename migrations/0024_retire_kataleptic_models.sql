-- Kataleptic retired its self-hosted models: the realtime cascade
-- (`kataleptic-realtime`, or a chat model id on /v1/realtime) with its Piper
-- voices, whisper-large-v3-turbo and the open chat models. Each now answers
-- `model_retired`, so stored selections of them would fail every call.
--
-- SQL cannot see where an *inherited* instance endpoint points, and another
-- operator's instance may serve a model of the same name. So this rewrites only
-- selections that explicitly name Kataleptic: an explicit Kataleptic provider or
-- URL, or the literal `kataleptic-realtime` id. Everything else is caught at
-- runtime, where the endpoint is known (resolveRealtime, liveRealtimeVoice,
-- resolveLlm). Realtime and LLM selections are cleared to '' (the default)
-- rather than pinned, and a voice chosen for a retired tier goes with it.
--
-- Every table gets the same transform, including the legacy compatibility
-- snapshot: a legacy row that no longer matched its snapshot would look like an
-- old-worker edit and be copied over the Studio assistant.

UPDATE assistants SET
  realtime_model = CASE WHEN ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')) THEN '' ELSE realtime_voice END
WHERE (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*'));

UPDATE assistants SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND (SELECT llm_base_url FROM provider_settings WHERE business_id=assistants.business_id) IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=assistants.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE agent_settings SET
  realtime_model = CASE WHEN ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')) THEN '' ELSE realtime_voice END
WHERE (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*'));

UPDATE agent_settings SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND (SELECT llm_base_url FROM provider_settings WHERE business_id=agent_settings.business_id) IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND agent_settings.llm_base_url IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE engine_presets SET
  realtime_model = CASE WHEN ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')) THEN '' ELSE realtime_voice END
WHERE (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*'));

UPDATE engine_presets SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND (SELECT llm_base_url FROM provider_settings WHERE business_id=engine_presets.business_id) IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=engine_presets.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE engine_profiles SET
  realtime_model = CASE WHEN ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')) THEN '' ELSE realtime_voice END
WHERE (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'kataleptic' AND realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'instance' AND realtime_model = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'kataleptic' AND realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*'));

UPDATE engine_profiles SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND (SELECT llm_base_url FROM provider_settings WHERE business_id=engine_profiles.business_id) IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=engine_profiles.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE compatibility_sync_state SET agent_snapshot = json_replace(agent_snapshot,
  '$.realtime_model', CASE WHEN ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'kataleptic' AND json_extract(agent_snapshot, '$.realtime_model') <> '' AND json_extract(agent_snapshot, '$.realtime_model') <> 'kataleptic-realtime-hd' AND json_extract(agent_snapshot, '$.realtime_model') NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'instance' AND json_extract(agent_snapshot, '$.realtime_model') = 'kataleptic-realtime')) THEN '' ELSE json_extract(agent_snapshot, '$.realtime_model') END,
  '$.realtime_voice', CASE WHEN (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'kataleptic' AND json_extract(agent_snapshot, '$.realtime_model') <> '' AND json_extract(agent_snapshot, '$.realtime_model') <> 'kataleptic-realtime-hd' AND json_extract(agent_snapshot, '$.realtime_model') NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'instance' AND json_extract(agent_snapshot, '$.realtime_model') = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'kataleptic' AND json_extract(agent_snapshot, '$.realtime_voice') GLOB '[a-z][a-z]_[A-Z][A-Z]-*')) THEN '' ELSE json_extract(agent_snapshot, '$.realtime_voice') END)
WHERE json_valid(agent_snapshot) AND (((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'kataleptic' AND json_extract(agent_snapshot, '$.realtime_model') <> '' AND json_extract(agent_snapshot, '$.realtime_model') <> 'kataleptic-realtime-hd' AND json_extract(agent_snapshot, '$.realtime_model') NOT GLOB 'gpt-realtime*') OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'instance' AND json_extract(agent_snapshot, '$.realtime_model') = 'kataleptic-realtime')) OR (COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'kataleptic' AND json_extract(agent_snapshot, '$.realtime_voice') GLOB '[a-z][a-z]_[A-Z][A-Z]-*'));

UPDATE compatibility_sync_state SET agent_snapshot = json_replace(agent_snapshot, '$.llm_model', '')
WHERE json_valid(agent_snapshot) AND json_extract(agent_snapshot, '$.llm_model') IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND (SELECT llm_base_url FROM provider_settings WHERE business_id=compatibility_sync_state.business_id) IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=compatibility_sync_state.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

-- An explicit Kataleptic endpoint must keep a concrete model.
UPDATE provider_settings SET llm_model = 'llama-3.3-70b'
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b') AND llm_base_url IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE provider_settings SET stt_model = 'gpt-transcribe'
WHERE stt_base_url IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND stt_model IN ('whisper-large-v3-turbo', 'whisper-large-v3-turbo-stream', 'parakeet-tdt-0-6b-stream',
    'openai/whisper-large-v3-turbo', 'openai/whisper-large-v3-turbo-stream', 'nvidia/parakeet-tdt-0-6b-stream');

-- A new revision makes an editor holding the old model reload before saving.
UPDATE summary_settings SET
  model = CASE WHEN mode = 'custom' THEN 'llama-3.3-70b' ELSE '' END,
  revision = lower(hex(randomblob(16)))
WHERE model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND ((mode = 'custom' AND base_url IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/'))
    OR (mode = 'workspace' AND (SELECT llm_base_url FROM provider_settings WHERE business_id=summary_settings.business_id) IN ('https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')));
