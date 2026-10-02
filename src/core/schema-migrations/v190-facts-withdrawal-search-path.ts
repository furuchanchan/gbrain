import type { Migration } from './types.ts';

export const v190: Migration = {
  version: 190,
  name: 'facts_withdrawal_search_path',
  // #5190: the withdrawal DDL (v148/v174 replay) creates four gbrain-owned
  // functions without a pinned search_path, so Supabase's advisor flags
  // function_search_path_mutable on every hosted brain. Same hardening as
  // v120/#1647: ALTER FUNCTION (not CREATE OR REPLACE) leaves each body
  // untouched — lowest drift risk — and the IF EXISTS guard skips functions a
  // given brain never created. The IF EXISTS loop is engine-agnostic.
  // Fresh installs are born correct: the shared DDL in withdrawal-schema.ts
  // carries SET search_path = pg_catalog, public.
  idempotent: true,
  sql: `
      DO $$
      DECLARE spec text;
      BEGIN
        FOREACH spec IN ARRAY ARRAY[
          'gbrain_fact_fingerprint_v1(text)','gbrain_fact_normalize(text)',
          'gbrain_fact_fingerprint(text)','gbrain_preserve_fact_withdrawal()'
        ] LOOP
          IF EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = split_part(spec, '(', 1)
          ) THEN
            EXECUTE format('ALTER FUNCTION public.%s SET search_path = pg_catalog, public', spec);
          END IF;
        END LOOP;
      END $$;
    `,
};
