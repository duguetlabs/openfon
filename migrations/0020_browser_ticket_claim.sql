-- Historical and old-writer tickets may already own a session without a
-- connected_at marker. Only a current issuer may opt a new ticket into the
-- atomic WebSocket claim protocol; never infer this from backfilled assistant IDs.
ALTER TABLE calls ADD COLUMN browser_claim_required INTEGER NOT NULL DEFAULT 0
  CHECK (browser_claim_required IN (0, 1));
