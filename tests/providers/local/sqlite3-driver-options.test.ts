/**
 * What the SQLite convenience wrappers do with the options they are handed.
 *
 * - platform-07: the caller's better-sqlite3 `timeout` is the busy timeout the
 *   connection keeps; VibORM's 5000 ms applies only when it is absent (libsql
 *   already behaved this way). It used to be overwritten by `busy_timeout = 5000`.
 * - platform-16: a key the wrapper does not read is refused at `createClient`.
 *   `databaseUrl` on viborm/sqlite3 used to open an in-memory database silently.
 *   bun-sqlite is covered here too: its module loads `bun:sqlite` only when it
 *   connects, so the construction-time refusal runs under Node.
 */

import { createClient as createBunSQLiteClient } from "@drivers/bun-sqlite";
import { createClient as createSQLite3Client } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

const note = s.model({ id: s.int().id(), body: s.string() });

async function busyTimeout(
  options: { timeout?: number } | undefined
): Promise<number> {
  const db = createSQLite3Client({
    schema: { note },
    ...(options === undefined ? {} : { options }),
  });
  try {
    const rows = await db.$queryRawUnsafe<{ timeout: number }>(
      "PRAGMA busy_timeout"
    );
    return Number(rows[0]?.timeout);
  } finally {
    await db.$disconnect();
  }
}

describe("viborm/sqlite3 busy timeout", () => {
  it("keeps the caller's timeout", async () => {
    expect(await busyTimeout({ timeout: 1000 })).toBe(1000);
    expect(await busyTimeout({ timeout: 0 })).toBe(0);
  });

  it("applies 5000 ms when the caller gives none", async () => {
    expect(await busyTimeout(undefined)).toBe(5000);
    expect(await busyTimeout({})).toBe(5000);
  });
});

describe("viborm/bun-sqlite busy timeout", () => {
  // The value is interpolated into `PRAGMA busy_timeout`, so construction
  // admits only a non-negative integer. The pragma itself is proven on the
  // real runtime by tests/providers/platform/bun-sqlite-options.test.ts.
  it.each([
    -1,
    1.5,
    Number.NaN,
  ])("refuses timeout %s at construction", (timeout) => {
    expect(() =>
      createBunSQLiteClient({ schema: { note }, options: { timeout } })
    ).toThrow(
      'The bun-sqlite "timeout" option must be a non-negative integer number of milliseconds.'
    );
  });
});

describe("SQLite wrappers refuse keys they do not read", () => {
  it("names databaseUrl and points viborm/sqlite3 at dataDir", () => {
    const attempt = () =>
      createSQLite3Client({
        schema: { note },
        // @ts-expect-error -- not a viborm/sqlite3 option
        databaseUrl: "file:./x.db",
      });
    expect(attempt).toThrow(ClientInitializationError);
    expect(attempt).toThrow(
      'viborm/sqlite3 does not accept "databaseUrl"; pass the database file as dataDir.'
    );
  });

  it("refuses a held configuration the same way", () => {
    const held = { schema: { note }, dataDir: ":memory:", pool: { max: 1 } };
    // @ts-expect-error -- `pool` is not a viborm/sqlite3 option
    expect(() => createSQLite3Client(held)).toThrow(
      'viborm/sqlite3 does not accept "pool"; it accepts schema, skipSchemaValidation, client, dataDir, options.'
    );
  });

  it("refuses databaseUrl on viborm/bun-sqlite before loading bun:sqlite", () => {
    expect(() =>
      createBunSQLiteClient({
        schema: { note },
        // @ts-expect-error -- not a viborm/bun-sqlite option
        databaseUrl: "file:./x.db",
      })
    ).toThrow(
      'viborm/bun-sqlite does not accept "databaseUrl"; pass the database file as dataDir.'
    );
  });

  it("accepts every documented key", async () => {
    const db = createSQLite3Client({
      schema: { note },
      dataDir: ":memory:",
      options: {},
      skipSchemaValidation: false,
    });
    await db.$disconnect();
  });
});
