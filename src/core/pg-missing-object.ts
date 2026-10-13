/**
 * #6599: strict "this object is missing" classification for old-schema
 * compatibility paths.
 *
 * Broad message regexes (`/halt_reasons/i`, `/no such table/i`) swallow real
 * driver errors — a 42501 permission error that names the column, or a 22P02
 * whose text happens to contain "no such table" — so a compat branch meant
 * for "the object predates this schema" must match SQLSTATE plus the exact
 * missing object: 42P01 + the relation name, or 42703 + the column name.
 *
 * Object identity comes from driver metadata first (postgres.js exposes
 * `table_name`/`column_name`; PGLite variants may expose `table`/`column`).
 * A numeric Bun `Error.column` is a source-code position, not a SQL
 * identifier, and never counts. Metadata naming a different object is a
 * contradiction the message cannot override; only when the driver reports
 * no object metadata does the canonical `... does not exist` / `no such
 * table` text name the object.
 */

export type PgMissingObject = { kind: 'relation' | 'column'; name: string };

/** A string that is one SQL identifier segment (metadata fields only). */
function identSegment(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) ? value : null;
}

/** The last identifier segment of a possibly-qualified name (`r.halt_reasons` → `halt_reasons`). */
function lastSegment(qualified: string): string {
  const parts = qualified.split('.');
  return parts[parts.length - 1]!;
}

const RELATION_RE = /\brelation\s+"?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)"?\s+does not exist/i;
const TABLE_RE = /\bno such table:?\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?/i;
const COLUMN_RE = /\bcolumn\s+"?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)"?\s+(?:of\s+relation\s+"?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*"?\s+)?does not exist/i;

/**
 * The object a Postgres "missing object" error names, or null when the error
 * is anything else. Requires SQLSTATE 42P01 (relation) or 42703 (column);
 * every other error — including ones whose message mentions the object —
 * returns null.
 */
export function pgMissingObject(err: unknown): PgMissingObject | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const code = typeof e.code === 'string' ? e.code : '';
  const table = identSegment(e.table_name) ?? identSegment(e.table);
  const column = identSegment(e.column_name) ?? identSegment(e.column);
  const msg = typeof e.message === 'string' ? e.message : String(err);
  if (code === '42P01') {
    if (table) return { kind: 'relation', name: table };
    const name = RELATION_RE.exec(msg)?.[1] ?? TABLE_RE.exec(msg)?.[1];
    return name ? { kind: 'relation', name: lastSegment(name) } : null;
  }
  if (code === '42703') {
    if (column) return { kind: 'column', name: column };
    const name = COLUMN_RE.exec(msg)?.[1];
    return name ? { kind: 'column', name: lastSegment(name) } : null;
  }
  return null;
}

export function isMissingPgRelation(err: unknown, relation: string): boolean {
  const missing = pgMissingObject(err);
  return missing?.kind === 'relation' && missing.name.toLowerCase() === relation.toLowerCase();
}

export function isMissingPgColumn(err: unknown, column: string): boolean {
  const missing = pgMissingObject(err);
  return missing?.kind === 'column' && missing.name.toLowerCase() === column.toLowerCase();
}
