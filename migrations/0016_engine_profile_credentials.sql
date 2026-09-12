-- Engine presets select behavior, not provider destinations or credentials.
-- Remove obsolete snapshots from both Studio and legacy profile writers while
-- preserving profile IDs, behavior, timestamps and current workspace credentials.
UPDATE engine_profiles SET llm_api_key = '', llm_base_url = '';
