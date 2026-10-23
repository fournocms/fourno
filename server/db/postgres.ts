import postgres from 'postgres'
import type { DbClient, DbResult } from './client'

type PostgresSql = postgres.Sql | postgres.TransactionSql

/**
 * Postgres via `postgres` (porsager/postgres.js): tagged-template queries
 * with server-side parameters, `unsafe()` for raw SQL, `begin()` for
 * transactions on a pooled connection. Server NOTICE messages (`… already
 * exists, skipping` from idempotent DDL) are not operator-relevant and are
 * dropped instead of printed.
 */
export function createPostgresClient(connectionString: string): DbClient {
  const sql = postgres(connectionString, { onnotice: () => {} })
  return wrapSql(sql, sql)
}

/**
 * Walk every column in a returned row and normalize dialect-specific values:
 *
 * - Date instances become ISO 8601 strings, matching SQLite timestamp reads.
 * - String-valued `*_json` columns are JSON.parsed, matching SQLite's TEXT
 *   JSON hydration and covering PG columns that intentionally store JSON in
 *   text rather than jsonb.
 */
export function normalizePostgresRow<Row>(row: Row): Row {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const normalized = value instanceof Date ? value.toISOString() : value
    if (key.endsWith('_json') && typeof normalized === 'string' && normalized.length > 0) {
      try {
        result[key] = JSON.parse(normalized)
      } catch {
        result[key] = normalized
      }
    } else {
      result[key] = normalized
    }
  }
  return result as Row
}

/**
 * Plain objects and arrays are bound as JSON, whatever the target column.
 *
 * postgres.js picks a parameter's serializer from the column type the server
 * reports: `json`/`jsonb` columns get `JSON.stringify`, but a `text` column
 * (several `*_json` columns are text on purpose) gets `'' + value`, which
 * stores an array of blocks as `[object Object]`. The SQLite adapter already
 * stringifies every plain object it is handed; `sql.json` gives Postgres the
 * same rule, and the server casts the JSON value to `text` on assignment.
 * Dates, buffers and postgres.js fragments are left alone.
 */
function bindJsonValues(sql: PostgresSql, values: readonly unknown[]): unknown[] {
  return values.map((value) => (isPlainJsonValue(value) ? sql.json(value as postgres.JSONValue) : value))
}

function isPlainJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return true
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Affected-or-returned row count for a postgres.js result.
 *
 * postgres.js exposes the command's row count on the result array's `.count` property:
 * for SELECT / RETURNING it equals the number of returned rows, and for a
 * non-RETURNING UPDATE / DELETE / INSERT it is the number of *affected* rows
 * (which PostgreSQL streams as a CommandComplete tag, not as data rows — so
 * `result.length` is 0 there). Using `.count` makes `rowCount` mean the same
 * thing as the SQLite adapter's `info.changes`. Falls back to `length` if the
 * property is ever absent.
 */
function resultRowCount<Row>(result: Row[]): number {
  const count = (result as { count?: unknown }).count
  return typeof count === 'number' ? count : result.length
}

/**
 * Wrap a postgres.js handle in the DbClient interface.
 *
 * `pool` is set only on the client returned by `createPostgresClient`, which
 * owns the connection pool. The transaction-scoped client handed to a
 * `.transaction()` callback borrows a pooled connection and gets `null`: only
 * the owner may end the pool, since ending it mid-transaction would tear the
 * connection out from under the surrounding `sql.begin()`. A `.transaction()`
 * call on a transaction-scoped client opens a savepoint.
 */
function wrapSql(sql: PostgresSql, pool: postgres.Sql | null): DbClient {
  const fn = (async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // postgres.js types rows as `object`; the DbClient contract leaves the
    // row shape to the caller's generic, exactly as the SQLite adapter does.
    const rows = (await sql(strings, ...(bindJsonValues(sql, values) as postgres.ParameterOrFragment<never>[]))) as unknown as Row[]
    return { rows: rows.map(normalizePostgresRow), rowCount: resultRowCount(rows) }
  }) as DbClient

  fn.unsafe = async <Row = Record<string, unknown>>(
    rawSql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    const result = params !== undefined
      ? await sql.unsafe(rawSql, bindJsonValues(sql, params) as postgres.ParameterOrJSON<never>[])
      : await sql.unsafe(rawSql)
    const rows = result as unknown as Row[]
    return { rows: rows.map(normalizePostgresRow), rowCount: resultRowCount(rows) }
  }

  fn.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> => {
    const run = (txSql: postgres.TransactionSql): Promise<T> => cb(wrapSql(txSql, null))
    const result = 'begin' in sql ? await sql.begin(run) : await sql.savepoint(run)
    return result as T
  }

  fn.close = async (): Promise<void> => {
    if (!pool) return
    await pool.end()
  }

  return Object.assign(fn, { dialect: 'postgres' as const })
}
