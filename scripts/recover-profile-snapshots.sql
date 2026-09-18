-- Only for an already-0017 database, after the compatibility guards are installed.
-- One atomic UPDATE clears at most400 rows total and never more than each
-- workspace's remaining daily quota. Existing0017 triggers remain authoritative.
-- No credentials or endpoint values are returned. See migration-compatibility.md.
WITH pending AS (
  SELECT id, business_id,
    ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY id) AS position
  FROM engine_profiles WHERE llm_base_url <> '' OR llm_api_key <> ''
), eligible AS (
  SELECT pending.id FROM pending
  LEFT JOIN rate_counters AS budget
    ON budget.bucket = 'presets:' || pending.business_id
    AND budget.window_start = CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400
  WHERE pending.position <= MAX(0, 400 - COALESCE(budget.count, 0))
  ORDER BY pending.id LIMIT 400
)
UPDATE engine_profiles SET llm_base_url='', llm_api_key=''
WHERE id IN (SELECT id FROM eligible);
