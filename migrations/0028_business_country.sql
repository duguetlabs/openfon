-- Existing locations stay unknown until the owner chooses a country.
ALTER TABLE businesses ADD COLUMN country TEXT CHECK(country IS NULL OR (length(country)=2 AND country GLOB '[A-Z][A-Z]'));
