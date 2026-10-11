/**
 * Estate storage in a SQLite-backed Durable Object's own storage.
 *
 * Conditional create is one `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * statement on `ctx.storage.sql`. The SQL API is synchronous, so the
 * existence check and the write are one SQLite statement with no await
 * between them: no other request, and no other publish from this one, can
 * interleave, even when callers race across awaits.
 */

import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { MigrationStorageWriter } from "./contract";
import { ObjectStoreEstateStorage } from "./object-store";

const TABLE = "viborm_migration_estate";

/**
 * History writer over `ctx.storage` of a SQLite-backed Durable Object
 * (`new_sqlite_classes`). Each value is one row, so one artifact is at most
 * the platform's 2 MB row size.
 */
export function createDurableObjectStorageWriter(
  storage: DurableObjectStorage
): MigrationStorageWriter {
  const { sql } = storage;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, bytes BLOB NOT NULL)`
  );
  return new ObjectStoreEstateStorage({
    putIfAbsent: async (key, bytes) =>
      sql
        .exec(
          `INSERT INTO ${TABLE} (key, bytes) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
          key,
          bytes.slice().buffer
        )
        .toArray().length === 1
        ? "created"
        : "exists",
    get: async (key) => {
      const [row] = sql
        .exec<{ bytes: ArrayBuffer }>(
          `SELECT bytes FROM ${TABLE} WHERE key = ?`,
          key
        )
        .toArray();
      return row ? new Uint8Array(row.bytes) : null;
    },
    list: async (prefix) =>
      sql
        .exec<{ key: string }>(
          `SELECT key FROM ${TABLE} WHERE substr(key, 1, ?) = ? ORDER BY key`,
          prefix.length,
          prefix
        )
        .toArray()
        .map((row) => row.key),
  });
}
