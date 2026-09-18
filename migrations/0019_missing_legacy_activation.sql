-- Conservatively pause canonical primary assistants whose legacy settings are
-- absent. This cannot distinguish original0008 fallback activation from later
-- adapter loss. Preserve configuration/slugs; either case can be explicitly
-- activated after repair. Already-reconstructed rows cannot be identified here.
UPDATE assistants SET state='draft', activated_at=NULL
WHERE state='active'
  AND id='asst_' || business_id
  AND public_slug=(SELECT slug FROM businesses WHERE id=assistants.business_id)
  AND NOT EXISTS (SELECT 1 FROM agent_settings WHERE business_id=assistants.business_id);
