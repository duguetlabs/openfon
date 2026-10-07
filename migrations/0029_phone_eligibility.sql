-- Operators record an actual end-user regulatory review, not inventory visibility.
CREATE TABLE commercial_phone_approvals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  country TEXT NOT NULL CHECK(length(country)=2 AND country GLOB '[A-Z][A-Z]'),
  number_type TEXT NOT NULL CHECK(number_type IN ('local','toll_free')),
  -- NULL means explicitly reviewed country-wide scope, never missing evidence.
  area_code TEXT CHECK(area_code IS NULL OR (length(area_code) BETWEEN 1 AND 6 AND area_code NOT GLOB '*[^0-9]*')),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
  business_name TEXT NOT NULL,
  business_address TEXT NOT NULL,
  business_country TEXT NOT NULL CHECK(length(business_country)=2 AND business_country GLOB '[A-Z][A-Z]'),
  reviewed_at TEXT,
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX commercial_phone_approval_scope ON commercial_phone_approvals(business_id,country,number_type,status);
-- Every material operator edit invalidates existing quotes, including revoke/reapprove.
CREATE TRIGGER commercial_phone_approval_revision
AFTER UPDATE OF business_id,country,number_type,area_code,status,business_name,business_address,business_country,reviewed_at,expires_at ON commercial_phone_approvals
BEGIN
  UPDATE commercial_phone_approvals SET revision=OLD.revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER commercial_phone_approval_revision_monotonic
BEFORE UPDATE OF revision ON commercial_phone_approvals
WHEN NEW.revision != OLD.revision+1
BEGIN
  SELECT RAISE(ABORT,'approval revision must advance exactly once');
END;
ALTER TABLE commercial_phone_quotes ADD COLUMN approval_id TEXT REFERENCES commercial_phone_approvals(id);
ALTER TABLE commercial_phone_quotes ADD COLUMN approval_revision INTEGER;
ALTER TABLE commercial_phone_quotes ADD COLUMN area_code TEXT;
