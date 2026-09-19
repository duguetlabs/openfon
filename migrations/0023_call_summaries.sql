-- Absence preserves existing assistant-specific summary routing. Owners can
-- explicitly select one workspace summary model without rewriting voice profiles.
CREATE TABLE summary_settings (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('legacy', 'workspace', 'custom')),
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  revision TEXT NOT NULL
);
