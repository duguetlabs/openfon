-- Replace fast password verifiers without rewriting deployed migration 0011.
-- Preserve routes/assignments and revocation state. All legacy routes require
-- explicit KDF reprovisioning and opt-in enablement; no SHA256 fallback exists.
UPDATE asterisk_routes SET enabled=0, password_sha256=lower(hex(randomblob(32)));
ALTER TABLE asterisk_routes ADD COLUMN password_hash TEXT
  CHECK(password_hash IS NOT NULL OR enabled=0);
-- password_sha256 remains only for schema compatibility. Its random placeholder
-- must never be derived from a password; new authentication ignores it entirely.
