BEGIN;

INSERT INTO public.indicator_units (code, title, title_short, description)
VALUES
    (
        'rub_per_calendar_day',
        'руб. за каждый календарный день',
        'руб./день',
        'Фиксированная сумма в рублях, начисляемая за каждый календарный день.'
    ),
    (
        'rub_per_workday',
        'руб. за каждый рабочий день',
        'руб./р. день',
        'Фиксированная сумма в рублях, начисляемая за каждый рабочий день (понедельник–пятница).'
    )
ON CONFLICT (code) DO UPDATE
SET title = EXCLUDED.title,
    title_short = EXCLUDED.title_short,
    description = EXCLUDED.description;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.indicators'::regclass
           AND conname = 'indicators_ruble_units_penalty_only'
    ) THEN
        ALTER TABLE public.indicators
            ADD CONSTRAINT indicators_ruble_units_penalty_only
            CHECK (
                unit_code NOT IN ('rub_per_calendar_day', 'rub_per_workday')
                OR kind = 'penalty'
            );
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.fn_calc_amount_of_delay(
    p_dt_work_days bigint,
    p_dt_total_days bigint,
    p_unit_code text,
    p_value numeric,
    p_balance numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN GREATEST(COALESCE(p_balance, 0), 0) <= 0 THEN 0

        WHEN p_unit_code = 'rub_per_workday'
            THEN GREATEST(COALESCE(p_dt_work_days, 0), 0)::numeric
                 * COALESCE(p_value, 0)

        WHEN p_unit_code = 'rub_per_calendar_day'
            THEN GREATEST(COALESCE(p_dt_total_days, 0), 0)::numeric
                 * COALESCE(p_value, 0)

        WHEN p_unit_code = 'percent_per_workday'
            THEN (
                GREATEST(COALESCE(p_dt_work_days, 0), 0)::numeric
                * COALESCE(p_value, 0)
                * GREATEST(COALESCE(p_balance, 0), 0)
            ) / 100.0

        WHEN p_unit_code = 'percent_per_calendar_day'
            THEN (
                GREATEST(COALESCE(p_dt_total_days, 0), 0)::numeric
                * COALESCE(p_value, 0)
                * GREATEST(COALESCE(p_balance, 0), 0)
            ) / 100.0

        WHEN p_unit_code = 'percent_per_year'
            THEN (
                GREATEST(COALESCE(p_dt_total_days, 0), 0)::numeric
                * COALESCE(p_value, 0)
                * GREATEST(COALESCE(p_balance, 0), 0)
            ) / (100.0 * 365.0)

        ELSE 0
    END;
$$;

CREATE OR REPLACE FUNCTION public.fn_calc_amount_of_delay(
    p_dt_work_days integer,
    p_dt_total_days integer,
    p_unit_code text,
    p_value numeric,
    p_balance numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT public.fn_calc_amount_of_delay(
        p_dt_work_days::bigint,
        p_dt_total_days::bigint,
        p_unit_code,
        p_value,
        p_balance
    );
$$;

CREATE OR REPLACE VIEW public.all_balance AS
SELECT
    c.session_id,
    c.dt,
    c.accrued,
    c.paid,
    c.remains,
    c.balance,
    c.dt_end,
    c.comment,
    c.penalty_value,
    c.penalty_unit,
    c.cb_rate_value,
    c.cb_rate_unit,
    c.avg_loan_rate_value,
    c.avg_loan_rate_unit,
    c.yield_rate_value,
    c.yield_rate_unit,
    c.dt_work_days,
    c.dt_total_days,
    public.fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.penalty_unit,
        c.penalty_value,
        c.balance
    ) AS penalty_amount,
    public.fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.cb_rate_unit,
        c.cb_rate_value,
        c.balance
    ) AS cb_rate_amount,
    public.fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.avg_loan_rate_unit,
        c.avg_loan_rate_value,
        c.balance
    ) AS avg_loan_rate_amount,
    public.fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.yield_rate_unit,
        c.yield_rate_value,
        c.balance
    ) AS yield_rate_amount,
    CASE
        WHEN c.penalty_unit IN ('percent_per_workday', 'rub_per_workday')
            THEN c.dt_work_days::integer
        ELSE c.dt_total_days
    END AS penalty_quantity,
    CASE
        WHEN c.cb_rate_unit IN ('percent_per_workday', 'rub_per_workday')
            THEN c.dt_work_days::integer
        ELSE c.dt_total_days
    END AS cb_rate_quantity,
    CASE
        WHEN c.avg_loan_rate_unit IN ('percent_per_workday', 'rub_per_workday')
            THEN c.dt_work_days::integer
        ELSE c.dt_total_days
    END AS avg_loan_rate_quantity,
    CASE
        WHEN c.yield_rate_unit IN ('percent_per_workday', 'rub_per_workday')
            THEN c.dt_work_days::integer
        ELSE c.dt_total_days
    END AS yield_rate_quantity,
    COALESCE((
        SELECT d.title_short
          FROM public.indicator_units d
         WHERE d.code = c.penalty_unit
    ), '') AS penalty_unit_title_short,
    COALESCE((
        SELECT d.title_short
          FROM public.indicator_units d
         WHERE d.code = c.cb_rate_unit
    ), '') AS cb_rate_unit_title_short,
    COALESCE((
        SELECT d.title_short
          FROM public.indicator_units d
         WHERE d.code = c.avg_loan_rate_unit
    ), '') AS avg_loan_rate_unit_title_short,
    COALESCE((
        SELECT d.title_short
          FROM public.indicator_units d
         WHERE d.code = c.yield_rate_unit
    ), '') AS yield_rate_unit_title_short
FROM (
    SELECT
        b.session_id,
        b.dt,
        b.accrued,
        b.paid,
        b.remains,
        b.balance,
        b.dt_end,
        b.comment,
        b.penalty_value,
        b.penalty_unit,
        b.cb_rate_value,
        b.cb_rate_unit,
        b.avg_loan_rate_value,
        b.avg_loan_rate_unit,
        b.yield_rate_value,
        b.yield_rate_unit,
        (
            SELECT COUNT(*)
              FROM generate_series(
                    b.dt::timestamp with time zone,
                    b.dt_end::timestamp with time zone,
                    '1 day'::interval
              ) AS g(day)
             WHERE EXTRACT(isodow FROM g.day) < 6
        ) AS dt_work_days,
        GREATEST(0, b.dt_end - b.dt + 1) AS dt_total_days
    FROM (
        SELECT
            a.session_id,
            a.dt,
            a.accrued,
            a.paid,
            a.remains,
            SUM(COALESCE(a.remains, 0::numeric)) OVER (
                PARTITION BY a.session_id
                ORDER BY a.dt
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS balance,
            COALESCE(
                LEAD(a.dt) OVER (
                    PARTITION BY a.session_id
                    ORDER BY a.dt
                ) - 1,
                a.dt
            ) AS dt_end,
            public.fn_get_comment(a.session_id, a.dt) AS comment,
            public.fn_get_indicator_value(a.session_id, 'penalty', a.dt) AS penalty_value,
            public.fn_get_indicator_unit(a.session_id, 'penalty', a.dt) AS penalty_unit,
            public.fn_get_indicator_value(a.session_id, 'cb_rate', a.dt) AS cb_rate_value,
            public.fn_get_indicator_unit(a.session_id, 'cb_rate', a.dt) AS cb_rate_unit,
            public.fn_get_indicator_value(a.session_id, 'avg_loan_rate', a.dt) AS avg_loan_rate_value,
            public.fn_get_indicator_unit(a.session_id, 'avg_loan_rate', a.dt) AS avg_loan_rate_unit,
            public.fn_get_indicator_value(a.session_id, 'yield_rate', a.dt) AS yield_rate_value,
            public.fn_get_indicator_unit(a.session_id, 'yield_rate', a.dt) AS yield_rate_unit
        FROM public.all_acc_pay a
        ORDER BY a.dt
    ) b
) c;

GRANT SELECT ON TABLE public.indicator_units TO elegso_api;
GRANT SELECT ON TABLE public.all_balance TO elegso_api;
GRANT EXECUTE ON FUNCTION public.fn_calc_amount_of_delay(bigint, bigint, text, numeric, numeric) TO elegso_api;
GRANT EXECUTE ON FUNCTION public.fn_calc_amount_of_delay(integer, integer, text, numeric, numeric) TO elegso_api;

COMMIT;
