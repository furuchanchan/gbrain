/**
 * `search.statement_timeout_ms` (#6495): the Postgres statement_timeout, in
 * milliseconds, applied per scoped read transaction to hybrid search's
 * keyword, title and CJK keyword arms (postgres-engine.ts). Integer,
 * default 8000, range 1000..60000; `config set` refuses other values. Read
 * from the merged config per hybrid request (file > DB) and passed to the
 * engine via SearchOpts.statementTimeoutMs — engines stay config-free.
 * Direct searchKeyword/searchTitles consumers (search-diagnose, eval
 * tooling) that do not set the option keep the default.
 */
import type { GBrainConfig } from '../config.ts';

export const SEARCH_STMT_TIMEOUT_KEY = 'search.statement_timeout_ms';
export const SEARCH_STMT_TIMEOUT_DEFAULT_MS = 8000;
export const SEARCH_STMT_TIMEOUT_MIN_MS = 1000;
export const SEARCH_STMT_TIMEOUT_MAX_MS = 60_000;

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= SEARCH_STMT_TIMEOUT_MIN_MS && n <= SEARCH_STMT_TIMEOUT_MAX_MS;
}

export function resolveSearchStatementTimeoutMs(cfg: Pick<GBrainConfig, 'search'> | null | undefined): number {
  const n = Number(cfg?.search?.statement_timeout_ms);
  return valid(n) ? n : SEARCH_STMT_TIMEOUT_DEFAULT_MS;
}

export function searchStatementTimeoutValueProblem(value: string): string | null {
  return valid(Number(value.trim()))
    ? null
    : `${SEARCH_STMT_TIMEOUT_KEY} must be an integer number of milliseconds from ${SEARCH_STMT_TIMEOUT_MIN_MS} to ${SEARCH_STMT_TIMEOUT_MAX_MS} (got '${value}'). Nothing was written.`;
}
