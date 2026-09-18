-- Run this migration atomically: the consistency check, guards and scrub are
-- one compatibility barrier for Workers that still copy profile credentials.
-- RAISE is trigger-only in SQLite. Conditional malformed JSON makes this
-- read-only precondition fail before any DDL, even when there are no profiles.
-- On failure, reconcile missing/mismatched provider rows explicitly; do not
-- overwrite either credential pair automatically or skip this migration.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM agent_settings AS legacy
  LEFT JOIN provider_settings AS provider ON provider.business_id=legacy.business_id
  WHERE provider.business_id IS NULL
     OR legacy.llm_base_url IS NOT provider.llm_base_url
     OR legacy.llm_api_key IS NOT provider.llm_api_key
) THEN json('OPENFON_0016_PROVIDER_CREDENTIAL_MISMATCH') ELSE NULL END;

-- New handlers update provider_settings first in the same atomic batch.
-- Old requests may keep credentials, but cannot change them after this barrier.
CREATE TRIGGER IF NOT EXISTS legacy_provider_credentials_guard
BEFORE UPDATE OF llm_base_url, llm_api_key ON agent_settings
WHEN (NEW.llm_base_url IS NOT OLD.llm_base_url OR NEW.llm_api_key IS NOT OLD.llm_api_key)
 AND NOT EXISTS (
   SELECT 1 FROM provider_settings
   WHERE business_id=NEW.business_id
     AND llm_base_url IS NEW.llm_base_url AND llm_api_key IS NEW.llm_api_key
 )
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_PROVIDER_CREDENTIAL_WRITE_REQUIRES_CURRENT_WORKER');
END;

-- In-flight old profile writers cannot repopulate snapshots after the scrub.
CREATE TRIGGER IF NOT EXISTS engine_profile_credentials_insert_guard
BEFORE INSERT ON engine_profiles
WHEN NEW.llm_base_url <> '' OR NEW.llm_api_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_PROFILE_CREDENTIAL_SNAPSHOTS_DISABLED');
END;

CREATE TRIGGER IF NOT EXISTS engine_profile_credentials_update_guard
BEFORE UPDATE ON engine_profiles
WHEN NEW.llm_base_url <> '' OR NEW.llm_api_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_PROFILE_CREDENTIAL_SNAPSHOTS_DISABLED');
END;

-- Preserve profile IDs, behavioral fields, timestamps and current credentials.
UPDATE engine_profiles SET llm_api_key = '', llm_base_url = ''
WHERE llm_api_key <> '' OR llm_base_url <> '';
