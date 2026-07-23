BEGIN;

CREATE TABLE IF NOT EXISTS public.calculation_settings (
    session_id text PRIMARY KEY,
    indicator_cutoff_date date,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.calculation_settings
    TO elegso_api;

COMMIT;
