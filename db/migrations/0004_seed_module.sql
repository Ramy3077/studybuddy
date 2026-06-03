-- Ensure the Machine Learning module exists so users can enrol even before
-- ingestion has run. Idempotent.
INSERT INTO modules (slug, name)
VALUES ('ml', 'Machine Learning')
ON CONFLICT (slug) DO NOTHING;
