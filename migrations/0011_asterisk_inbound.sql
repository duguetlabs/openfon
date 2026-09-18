-- Operator-managed PBX credentials authorize exactly one workspace/assistant.
-- Store SHA-256 of a random >=32-byte password, never its plaintext value.
CREATE TABLE asterisk_routes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  assistant_id TEXT NOT NULL,
  password_sha256 TEXT NOT NULL CHECK(length(password_sha256)=64 AND password_sha256 NOT GLOB '*[^0-9a-f]*'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  FOREIGN KEY(assistant_id,business_id) REFERENCES assistants(id,business_id) ON DELETE CASCADE
);
