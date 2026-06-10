-- Per-business realtime model/tier override; empty = instance default
-- (REALTIME_MODEL var). Lets businesses compare engine tiers per call.
ALTER TABLE agent_settings ADD COLUMN realtime_model TEXT NOT NULL DEFAULT '';
