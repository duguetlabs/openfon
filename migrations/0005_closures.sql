-- Special closures (holidays, vacation days) on top of weekly hours.
-- [{date: 'YYYY-MM-DD', reason: 'Public holiday'}]
ALTER TABLE businesses ADD COLUMN closures_json TEXT NOT NULL DEFAULT '[]';
