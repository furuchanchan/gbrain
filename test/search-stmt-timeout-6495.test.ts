/**
 * #6495: `search.statement_timeout_ms` — a bounded, operator-set Postgres
 * statement_timeout for hybrid search's lexical arms. The reporter's
 * 360k-page / 8.6M-chunk brain times out cold narrow queries under the
 * fixed 8s: this key raises it without a code change. Resolver, bounds,
 * and the `config set` refusal mirror `search.cjk_keyword_deadline_ms`.
 */
import { describe, expect, test } from 'bun:test';
import {
  resolveSearchStatementTimeoutMs,
  SEARCH_STMT_TIMEOUT_DEFAULT_MS,
  SEARCH_STMT_TIMEOUT_KEY,
  SEARCH_STMT_TIMEOUT_MAX_MS,
  SEARCH_STMT_TIMEOUT_MIN_MS,
  searchStatementTimeoutValueProblem,
} from '../src/core/search/search-stmt-timeout.ts';
import { searchConfigValueRefusal } from '../src/core/search/config-values.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

describe('#6495: search.statement_timeout_ms', () => {
  test('unset config keeps the 8000ms default', () => {
    expect(resolveSearchStatementTimeoutMs(null)).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
    expect(resolveSearchStatementTimeoutMs(undefined)).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
    expect(resolveSearchStatementTimeoutMs({})).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
    expect(resolveSearchStatementTimeoutMs({ search: {} })).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
  });

  test('a valid configured value wins', () => {
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: 20_000 } })).toBe(20_000);
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: SEARCH_STMT_TIMEOUT_MIN_MS } })).toBe(SEARCH_STMT_TIMEOUT_MIN_MS);
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: SEARCH_STMT_TIMEOUT_MAX_MS } })).toBe(SEARCH_STMT_TIMEOUT_MAX_MS);
  });

  test('out-of-range or non-integer values fall back to the default', () => {
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: 1 } })).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: 10 ** 9 } })).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: 20_000.5 } })).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
    expect(resolveSearchStatementTimeoutMs({ search: { statement_timeout_ms: Number('abc') } })).toBe(SEARCH_STMT_TIMEOUT_DEFAULT_MS);
  });

  test('config set refuses invalid values naming the key and range', () => {
    expect(searchStatementTimeoutValueProblem('20000')).toBeNull();
    const refusal = searchConfigValueRefusal(SEARCH_STMT_TIMEOUT_KEY, '9999999');
    expect(refusal?.message).toContain(SEARCH_STMT_TIMEOUT_KEY);
    expect(refusal?.message).toContain(String(SEARCH_STMT_TIMEOUT_MAX_MS));
    expect(refusal?.example).toBe(String(SEARCH_STMT_TIMEOUT_DEFAULT_MS));
    expect(searchConfigValueRefusal(SEARCH_STMT_TIMEOUT_KEY, 'abc')).not.toBeNull();
    // A request can never smuggle a timeout the operator did not set:
    // unset key means the engine default, always.
    expect(KNOWN_CONFIG_KEYS).toContain(SEARCH_STMT_TIMEOUT_KEY);
  });
});
