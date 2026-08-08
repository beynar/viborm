/**
 * SQLite-family integer safety.
 *
 * SQLite's INTEGER is 64-bit; JS numbers stop being exact at 2^53. Every
 * driver in the family therefore has to opt into a BigInt read mode, or the
 * value it hands back is quietly not the value that was stored.
 *
 * `sqlite3` opts in per statement (`safeIntegers(true)`), `libsql` forces
 * `intMode: "bigint"` on the connection, and `bun-sqlite` now opts in per
 * statement the same way `sqlite3` does. The shared scalar round-trip suite
 * pins the ORM-visible answer (9007199254740993n) on sqlite3 and libsql; this
 * file pins the DRIVER-level split those suites never reach — which statements
 * opt in, which deliberately do not, and what happens when the provider cannot
 * opt in at all.
 *
 * `bun-sqlite` cannot run under vitest (`bun:sqlite` only loads inside Bun), so
 * its provider is a controlled fake that reproduces the one behaviour that
 * matters: rounding unless `safeIntegers(true)` was called. That the real
 * `bun:sqlite` behaves exactly this way is pinned separately, on the real
 * runtime, by `bun-sqlite-runtime.test.ts`.
 */

import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { FeatureNotSupportedError } from "@errors";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

type BunSQLiteOptions = NonNullable<
  ConstructorParameters<typeof BunSQLiteDriver>[0]
>;
type BunSQLiteClient = NonNullable<BunSQLiteOptions["client"]>;

// One past Number.MAX_SAFE_INTEGER — the value the shared scalar round-trip
// suite pins — and what it becomes if it ever travels as a JS number.
const EXACT = 9_007_199_254_740_993n;
const ROUNDED = 9_007_199_254_740_992;

/**
 * A bun:sqlite stand-in that rounds exactly like the real one: INTEGER columns
 * come back as lossy numbers until `safeIntegers(true)` is called on the
 * statement. `supportsSafeIntegers: false` models a Bun older than 1.1.14,
 * whose statements have no such method.
 */
function createBunIntegerFixture({
  supportsSafeIntegers = true,
}: {
  supportsSafeIntegers?: boolean;
} = {}) {
  let safe = false;
  const safeIntegers = vi.fn((value: boolean) => {
    safe = value;
    return statement;
  });
  const all = vi.fn(() => [{ views: safe ? EXACT : ROUNDED }]);
  const statement = {
    columnNames: ["views"],
    all,
    get: vi.fn(() => null),
    run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    values: vi.fn(() => []),
    ...(supportsSafeIntegers ? { safeIntegers } : {}),
  };
  const database = {
    query: vi.fn(() => statement),
    prepare: vi.fn(() => statement),
    run: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction:
      <T>(fn: () => T) =>
      () =>
        fn(),
  };

  return {
    all,
    driver: new BunSQLiteDriver({
      // The real provider contract is private to the driver. This controlled
      // fake implements only the statement surface execution exercises.
      client: database as unknown as BunSQLiteClient,
    }),
    safeIntegers,
  };
}

/** A non-reader statement: no columns, so nothing is ever decoded. */
function createBunMutationFixture() {
  const safeIntegers = vi.fn(() => statement);
  const statement = {
    columnNames: [] as string[],
    all: vi.fn(() => []),
    get: vi.fn(() => null),
    run: vi.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
    safeIntegers,
    values: vi.fn(() => []),
  };
  const database = {
    query: vi.fn(() => statement),
    prepare: vi.fn(() => statement),
    run: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction:
      <T>(fn: () => T) =>
      () =>
        fn(),
  };

  return {
    driver: new BunSQLiteDriver({
      client: database as unknown as BunSQLiteClient,
    }),
    safeIntegers,
  };
}

describe("Bun SQLite integer safety", () => {
  test("the typed execute path reads INTEGER columns exactly past 2^53", async () => {
    const { driver, safeIntegers } = createBunIntegerFixture();

    try {
      const result = await driver._execute<{ views: bigint }>(
        sql`SELECT "views" FROM "measurements"`
      );

      expect(safeIntegers).toHaveBeenCalledWith(true);
      expect(result.rows[0]?.views).toBe(EXACT);
    } finally {
      await driver.disconnect();
    }
  });

  test("the raw path stays driver-native, exactly as sqlite3 does", async () => {
    const { driver, safeIntegers } = createBunIntegerFixture();

    try {
      const result = await driver._executeRaw<{ views: number }>(
        `SELECT "views" FROM "measurements"`
      );

      // Raw rows bypass the result parser, so they keep the provider's own
      // numbers. This is the same boundary sqlite3 has, kept identical on
      // purpose: $queryRawUnsafe answers the same way on both drivers.
      expect(safeIntegers).not.toHaveBeenCalled();
      expect(result.rows[0]?.views).toBe(ROUNDED);
    } finally {
      await driver.disconnect();
    }
  });

  test("a statement that decodes nothing is never switched", async () => {
    const { driver, safeIntegers } = createBunMutationFixture();

    try {
      const result = await driver._execute(
        sql`UPDATE "measurements" SET "views" = ${1}`
      );

      expect(result).toEqual({ rows: [], rowCount: 1 });
      expect(safeIntegers).not.toHaveBeenCalled();
    } finally {
      await driver.disconnect();
    }
  });

  test("a provider that cannot opt in is refused, not read", async () => {
    const { all, driver } = createBunIntegerFixture({
      supportsSafeIntegers: false,
    });

    try {
      await expect(
        driver._execute(sql`SELECT "views" FROM "measurements"`)
      ).rejects.toBeInstanceOf(FeatureNotSupportedError);
      // Fail closed: the rounded row is never even fetched, let alone returned.
      expect(all).not.toHaveBeenCalled();
    } finally {
      await driver.disconnect();
    }
  });
});

describe("SQLite3 integer safety (the contract bun-sqlite matches)", () => {
  test("execute reads exactly past 2^53 while raw stays native", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });

    try {
      await driver._executeRaw(
        `CREATE TABLE "measurements" ("views" INTEGER NOT NULL)`
      );
      await driver._executeRaw(`INSERT INTO "measurements" VALUES (?)`, [
        EXACT,
      ]);

      const typed = await driver._execute<{ views: bigint }>(
        sql`SELECT "views" FROM "measurements"`
      );
      const raw = await driver._executeRaw<{ views: number }>(
        `SELECT "views" FROM "measurements"`
      );

      expect(typed.rows[0]?.views).toBe(EXACT);
      expect(raw.rows[0]?.views).toBe(ROUNDED);
    } finally {
      await driver.disconnect();
    }
  });
});
