-- Voice id passed verbatim to the realtime engine; each tier has its own
-- voice catalog, so this is separate from the Azure `voice` used by the
-- pipeline/HD tiers. Empty = tier default.
ALTER TABLE agent_settings ADD COLUMN realtime_voice TEXT NOT NULL DEFAULT '';
