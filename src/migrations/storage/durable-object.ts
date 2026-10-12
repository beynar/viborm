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
 * the platform's 2 MB row size. `prefix` places one history under a key
 * prefix (for example `h2/`), so an object can hold a pruned history beside
 * its current one.
 */
export function createDurableObjectStorageWriter(
  storage: DurableObjectStorage,
  options: { readonly prefix?: string } = {}
): MigrationStorageWriter {
  const { sql } = storage;
  const prefix = options.prefix ?? "";
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, bytes BLOB NOT NULL)`
  );
  return new ObjectStoreEstateStorage({
    putIfAbsent: async (key, bytes) =>
      sql
        .exec(
          `INSERT INTO ${TABLE} (key, bytes) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
          `${prefix}${key}`,
          bytes.slice().buffer
        )
        .toArray().length === 1
        ? "created"
        : "exists",
    get: async (key) => {
      const [row] = sql
        .exec<{ bytes: ArrayBuffer }>(
          `SELECT bytes FROM ${TABLE} WHERE key = ?`,
          `${prefix}${key}`
        )
        .toArray();
      return row ? new Uint8Array(row.bytes) : null;
    },
    list: async (keyPrefix) =>
      sql
        .exec<{ key: string }>(
          `SELECT key FROM ${TABLE} WHERE substr(key, 1, length(?)) = ? ORDER BY key`,
          `${prefix}${keyPrefix}`,
          `${prefix}${keyPrefix}`
        )
        .toArray()
        .map((row) => row.key.slice(prefix.length)),
  });
}
