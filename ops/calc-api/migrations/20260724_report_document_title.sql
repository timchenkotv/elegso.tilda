BEGIN;

ALTER TABLE public.calculation_settings
    ADD COLUMN IF NOT EXISTS report_document_title text;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.calculation_settings
    TO elegso_api;

COMMIT;
