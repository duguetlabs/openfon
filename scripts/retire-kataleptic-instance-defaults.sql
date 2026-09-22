-- Deployment-specific follow-up to migration 0024, NOT a migration.
--
-- 0024 only rewrites selections made on an explicit api.kataleptic.com provider
-- or URL, because SQL cannot see where an inherited instance endpoint points.
-- On an instance whose REALTIME_* and DEFAULT_LLM_* are the shipped Kataleptic
-- defaults (api.kataleptic.com), inherited rows are Kataleptic too; this clears
-- their retired selections the same way. Runtime already serves them on live
-- models, so this is hygiene, not a fix for failing calls. Do not run it on an
-- instance whose defaults point anywhere else.
--
--   wrangler d1 execute openfon --remote --file scripts/retire-kataleptic-instance-defaults.sql
--
-- Take a backup first. Idempotent; test/kataleptic-retirement-migration.test.ts
-- runs it after 0024.

UPDATE assistants SET
  realtime_model = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*' THEN '' ELSE realtime_voice END
WHERE ((realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')
  AND ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'kataleptic' AND (SELECT realtime_base_url FROM provider_settings WHERE business_id=assistants.business_id) IN ('', 'wss://api.kataleptic.com/v1/realtime', 'wss://api.kataleptic.com/v1/realtime/')) OR COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id), 'instance') = 'instance');

UPDATE assistants SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND COALESCE((SELECT llm_base_url FROM provider_settings WHERE business_id=assistants.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=assistants.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE agent_settings SET
  realtime_model = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*' THEN '' ELSE realtime_voice END
WHERE ((realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')
  AND ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'kataleptic' AND (SELECT realtime_base_url FROM provider_settings WHERE business_id=agent_settings.business_id) IN ('', 'wss://api.kataleptic.com/v1/realtime', 'wss://api.kataleptic.com/v1/realtime/')) OR COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=agent_settings.business_id), 'instance') = 'instance');

UPDATE agent_settings SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND COALESCE((SELECT llm_base_url FROM provider_settings WHERE business_id=agent_settings.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND agent_settings.llm_base_url IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE engine_presets SET
  realtime_model = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*' THEN '' ELSE realtime_voice END
WHERE ((realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')
  AND ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'kataleptic' AND (SELECT realtime_base_url FROM provider_settings WHERE business_id=engine_presets.business_id) IN ('', 'wss://api.kataleptic.com/v1/realtime', 'wss://api.kataleptic.com/v1/realtime/')) OR COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_presets.business_id), 'instance') = 'instance');

UPDATE engine_presets SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND COALESCE((SELECT llm_base_url FROM provider_settings WHERE business_id=engine_presets.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=engine_presets.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE engine_profiles SET
  realtime_model = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') THEN '' ELSE realtime_model END,
  realtime_voice = CASE WHEN (realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*' THEN '' ELSE realtime_voice END
WHERE ((realtime_model <> '' AND realtime_model <> 'kataleptic-realtime-hd' AND realtime_model NOT GLOB 'gpt-realtime*') OR realtime_voice GLOB '[a-z][a-z]_[A-Z][A-Z]-*')
  AND ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'kataleptic' AND (SELECT realtime_base_url FROM provider_settings WHERE business_id=engine_profiles.business_id) IN ('', 'wss://api.kataleptic.com/v1/realtime', 'wss://api.kataleptic.com/v1/realtime/')) OR COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=engine_profiles.business_id), 'instance') = 'instance');

UPDATE engine_profiles SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND COALESCE((SELECT llm_base_url FROM provider_settings WHERE business_id=engine_profiles.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=engine_profiles.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE compatibility_sync_state SET agent_snapshot = json_replace(agent_snapshot,
  '$.realtime_model', CASE WHEN (json_extract(agent_snapshot, '$.realtime_model') <> '' AND json_extract(agent_snapshot, '$.realtime_model') <> 'kataleptic-realtime-hd' AND json_extract(agent_snapshot, '$.realtime_model') NOT GLOB 'gpt-realtime*') THEN '' ELSE json_extract(agent_snapshot, '$.realtime_model') END,
  '$.realtime_voice', CASE WHEN (json_extract(agent_snapshot, '$.realtime_model') <> '' AND json_extract(agent_snapshot, '$.realtime_model') <> 'kataleptic-realtime-hd' AND json_extract(agent_snapshot, '$.realtime_model') NOT GLOB 'gpt-realtime*') OR json_extract(agent_snapshot, '$.realtime_voice') GLOB '[a-z][a-z]_[A-Z][A-Z]-*' THEN '' ELSE json_extract(agent_snapshot, '$.realtime_voice') END)
WHERE json_valid(agent_snapshot) AND ((json_extract(agent_snapshot, '$.realtime_model') <> '' AND json_extract(agent_snapshot, '$.realtime_model') <> 'kataleptic-realtime-hd' AND json_extract(agent_snapshot, '$.realtime_model') NOT GLOB 'gpt-realtime*') OR json_extract(agent_snapshot, '$.realtime_voice') GLOB '[a-z][a-z]_[A-Z][A-Z]-*')
  AND ((COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'kataleptic' AND (SELECT realtime_base_url FROM provider_settings WHERE business_id=compatibility_sync_state.business_id) IN ('', 'wss://api.kataleptic.com/v1/realtime', 'wss://api.kataleptic.com/v1/realtime/')) OR COALESCE((SELECT realtime_provider FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), 'instance') = 'instance');

UPDATE compatibility_sync_state SET agent_snapshot = json_replace(agent_snapshot, '$.llm_model', '')
WHERE json_valid(agent_snapshot) AND json_extract(agent_snapshot, '$.llm_model') IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b')
  AND COALESCE((SELECT llm_base_url FROM provider_settings WHERE business_id=compatibility_sync_state.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/')
  AND COALESCE((SELECT llm_base_url FROM agent_settings WHERE business_id=compatibility_sync_state.business_id), '') IN ('', 'https://api.kataleptic.com/v1', 'https://api.kataleptic.com/v1/');

UPDATE provider_settings SET llm_model = ''
WHERE llm_model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b') AND llm_base_url = '';

UPDATE summary_settings SET model = '', revision = lower(hex(randomblob(16)))
WHERE model IN ('qwen3-8b', 'qwen2.5-coder-7b', 'mistral-nemo-12b', 'gemma3-27b', 'glm4-9b') AND mode = 'workspace'
  AND COALESCE((SELECT llm_base_url FROM provider_settings WHERE business_id=summary_settings.business_id), '') = '';
