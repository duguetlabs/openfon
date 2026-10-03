-- Add SDK transcript identity/revision metadata without rewriting historical text or IDs.
ALTER TABLE call_turns ADD COLUMN source_id TEXT;
ALTER TABLE call_turns ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_turns ADD COLUMN source_final INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX call_turns_media_source ON call_turns(call_id,source_id);
