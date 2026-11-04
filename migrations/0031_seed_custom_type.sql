-- Preserve the user's seed type, which is independent of catalog classification.
ALTER TABLE seeds ADD COLUMN custom_type TEXT;
