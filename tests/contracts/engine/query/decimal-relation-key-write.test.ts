/**
 * A decimal RELATION KEY is written the same way as the column it references.
 *
 * Every decimal write in the engine goes through the dialect's exact-decimal
 * literal (`literals.decimal`, canonicalized first) in the FIELD's own declared
 * domain: PG casts to `NUMERIC(p,s)`, MySQL to `DECIMAL(p,s)`, and SQLite binds
 * the unscaled coefficient its INTEGER column stores. One path did not — the
 * relation-correlated foreign key.
 * `referenceSql` lowered an FK value as a plain parameter under
 * `getScalarCastType`, which answered `"numeric"` for a decimal. The result was
 * that the PARENT key and the CHILD foreign key holding the same logical value
 * were bound two different ways inside one statement pair:
 *
 *   sqlite  parent the coefficient          child `CAST(? AS NUMERIC)` -> REAL
 *   mysql   parent `CAST(? AS DECIMAL(p,s))` child `CAST(? AS DECIMAL)` -> DECIMAL(10,0)
 *
 * Both children are lossy, and lossy in a way the parent is not, so the two
 * ends of one relation stop matching. MySQL's bare `DECIMAL` is `DECIMAL(10,0)`
 * (see `src/migrations/drivers/type-mapping.ts`), which rounds away EVERY
 * fraction — a key of `9.5` lands as `10` — so this was never confined to
 * high-precision values. On SQLite the damage is visible only past double
 * precision, but there it is total: `CAST('1234567890123456789.123456789012'
 * AS NUMERIC)` is `1234567890123456800`.
 *
 * How it presents depends on one PRAGMA. With foreign keys ON (sqlite3, libsql)
 * a legal write throws `ForeignKeyError` against a parent row that exists. With
 * them OFF (bun:sqlite's default) the write reports success, the FK column holds
 * the rounded value, and the parent's `include` answers with an empty list — a
 * silent precision loss on write plus a silently wrong read.
 *
 * So this file pins the property in both places it can be pinned:
 *
 *  - LIVE, on the two local dialects, that a decimal relation key round-trips —
 *    PGlite with native numeric storage and SQLite3 with a scaled integer
 *    coefficient. Assertions are on the LINK (the child is reachable
 *    from the parent and its FK reads back exactly), not on the absence of a
 *    throw, because the bun:sqlite witness proves an absent throw means nothing.
 *  - ON THE SQL, for all three dialects including MySQL (which has no local
 *    leg), that the FK expression is byte-identical to the write lowering of
 *    the referenced column. That is the invariant — "an FK is written like the
 *    key it references" — rather than a dialect spelling, so it survives a
 *    change to any adapter's decimal literal.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";

import { buildScalarSqlValue } from "@query-engine/builders/values-builder";
import { createQueryScope } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { referenceSql } from "@src/query-engine/write-engine/fragment-builders";
import { createSchemaRegistry } from "@validation";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * The declared domain of this file's key pair. SQLite-legal on purpose
 * (`precision + scale <= 18`), because half of the live legs bind there — and
 * both ends of the reference declare the SAME domain, which is what makes a
 * decimal relation key comparable at all.
 */
const MONEY = { precision: 16, scale: 2 } as const;

/**
 * A decimal PRIMARY KEY with children holding a decimal FK to it. The FK is the
 * only field whose lowering this file is about; `label`/`note` exist so the
 * rows are distinguishable in a wrong-row answer.
 */
const vault = s
  .model({
    key: s.decimal(MONEY).id(),
    label: s.string(),
    slips: s.toMany(() => slip),
  })
  .map("decimal_relkey_vaults");

const slip = s
  .model({
    id: s.string().id(),
    note: s.string(),
    vaultKey: s.decimal(MONEY),
    vault: s
      .toOne(() => vault)
      .fields("vaultKey")
      .references("key"),
  })
  .map("decimal_relkey_slips");

const schema = { vault, slip };

/**
 * Past double precision: the coefficient 9007199254740993 is one more than
 * 2^53, so a value that goes through a REAL comes back as its neighbour and the
 * round-trip is unmistakable.
 */
const BIG30 = "90071992547409.93";

/**
 * The value that falsifies "only high-precision decimals are at risk". A double
 * holds `9.5` perfectly; `DECIMAL(10,0)` does not — it rounds to `10`. This one
 * fails on MySQL for a reason SQLite's REAL affinity never shows.
 */
const HALF = "9.5";

/** The widest value of the domain: through a double it becomes 100000000000000. */
const NEAR_MAX = "99999999999999.99";

/**
 * A NON-CANONICAL spelling of `HALF`. It is the same number, so it must reach
 * the same row — which it can only do if the FK path canonicalizes, exactly as
 * the parent write does. A cast alone cannot repair a spelling: on SQLite the
 * TEXT column holds `9.5`, and `CAST('9.50' AS TEXT)` is `'9.50'`, matching
 * nothing.
 */
const HALF_UNCANONICAL = "9.50";

// ============================================================================
// LIVE — the link survives, on an exact dialect and on a TEXT-storage one
// ============================================================================

type Live = {
  readonly name: string;
  readonly create: () => ReturnType<typeof createPGliteClient>;
};

const createPGliteClient = () =>
  createClient({ schema, driver: new PGliteDriver({ client: new PGlite() }) });

const createSQLite3Client = () =>
  createClient({
    schema,
    driver: new SQLite3Driver({ dataDir: ":memory:" }),
  }) as unknown as ReturnType<typeof createPGliteClient>;

const liveDialects: Live[] = [
  { name: "PGlite (exact decimals)", create: createPGliteClient },
  { name: "SQLite3 (integer coefficients)", create: createSQLite3Client },
];

describe.each(
  liveDialects
)("$name — decimal relation keys round-trip", (live) => {
  let client: ReturnType<typeof createPGliteClient>;

  beforeAll(async () => {
    client = live.create();
    await syncLiveSchema(client as never);
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  test("nested create writes an FK that matches the parent key", async () => {
    await client.vault.create({
      data: {
        key: BIG30,
        label: "nested-create",
        slips: { create: [{ id: "big-a", note: "a" }] },
      },
    });

    const found = await client.vault.findUnique({
      where: { key: BIG30 },
      include: { slips: true },
    });

    expect(found?.key.eq(BIG30)).toBe(true);
    expect(found?.slips.map((row) => row.id)).toEqual(["big-a"]);
    // The FK itself, not just the join: a rounded FK that happened to join
    // would still be a corrupted stored value.
    expect(found?.slips[0]?.vaultKey.eq(BIG30)).toBe(true);
  });

  test("connect links to an existing decimal key", async () => {
    await client.vault.create({ data: { key: HALF, label: "connect" } });
    await client.slip.create({
      data: {
        id: "half-a",
        note: "a",
        vault: { connect: { key: HALF } },
      },
    });

    const found = await client.vault.findUnique({
      where: { key: HALF },
      include: { slips: true },
    });

    expect(found?.slips.map((row) => row.id)).toEqual(["half-a"]);
    expect(found?.slips[0]?.vaultKey.eq(HALF)).toBe(true);
  });

  test("a non-canonical key spelling reaches the same row", async () => {
    await client.slip.create({
      data: {
        id: "half-b",
        note: "b",
        vault: { connect: { key: HALF_UNCANONICAL } },
      },
    });

    const found = await client.vault.findUnique({
      where: { key: HALF },
      include: { slips: true },
    });

    expect(found?.slips.map((row) => row.id).sort()).toEqual([
      "half-a",
      "half-b",
    ]);
    // The same NUMBER, whatever spelling the caller used.
    expect(found?.slips[1]?.vaultKey.eq(HALF)).toBe(true);
  });

  test("nested createMany writes matching FKs for every row", async () => {
    await client.vault.create({
      data: {
        key: NEAR_MAX,
        label: "many",
        slips: {
          createMany: {
            data: [
              { id: "tiny-a", note: "a" },
              { id: "tiny-b", note: "b" },
            ],
          },
        },
      },
    });

    const found = await client.vault.findUnique({
      where: { key: NEAR_MAX },
      include: { slips: true },
    });

    expect(found?.slips.map((row) => row.id).sort()).toEqual([
      "tiny-a",
      "tiny-b",
    ]);
    expect(found?.slips.every((row) => row.vaultKey.eq(NEAR_MAX))).toBe(true);
  });

  test("connectOrCreate on an absent decimal key creates and links", async () => {
    await client.slip.create({
      data: {
        id: "coc-a",
        note: "a",
        vault: {
          connectOrCreate: {
            where: { key: "42.12" },
            create: { key: "42.12", label: "coc" },
          },
        },
      },
    });

    const found = await client.vault.findUnique({
      where: { key: "42.12" },
      include: { slips: true },
    });

    expect(found?.slips.map((row) => row.id)).toEqual(["coc-a"]);
    expect(found?.slips[0]?.vaultKey.eq("42.12")).toBe(true);
  });
});

// ============================================================================
// SQL — the FK expression IS the referenced column's write lowering
// ============================================================================

class SqlOnlyDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `decimal-relkey-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // SQL-only driver: no external client is allocated.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const sqlDialects = [
  {
    name: "PostgreSQL",
    dialect: "postgresql" as Dialect,
    adapter: () => new PostgresAdapter(),
    /** The corruption spelling this dialect must never produce for a decimal. */
    forbidden: [] as string[],
    deferredDomain: "NUMERIC(16,2)",
  },
  {
    name: "MySQL",
    dialect: "mysql" as Dialect,
    adapter: () => new MySQLAdapter(),
    // Bare `DECIMAL` is `DECIMAL(10,0)`: every fraction rounded away.
    forbidden: ["AS DECIMAL)", "DECIMAL(65,30)"],
    deferredDomain: "DECIMAL(16,2)",
  },
  {
    name: "SQLite",
    dialect: "sqlite" as Dialect,
    adapter: () => new SQLiteAdapter(),
    // NUMERIC affinity puts the canonical TEXT spelling through a double.
    forbidden: ["AS NUMERIC)", "AS REAL)"],
    deferredDomain: "INTEGER",
  },
];

beforeAll(() => hydrateSchemaNames(schema));

const rendered = (fragment: ReturnType<typeof referenceSql>) => ({
  statement: fragment.toStatement("$n"),
  values: fragment.values,
});

describe.each(sqlDialects)("$name decimal FK lowering", (dialectCase) => {
  const engineFor = () => {
    const adapter = dialectCase.adapter();
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    return new QueryEngine(
      new SqlOnlyDriver(adapter, dialectCase.dialect),
      registry
    );
  };

  /**
   * The reference: how the PARENT's own decimal key is written. Every FK
   * carrying that same value has to be spelled this way or the two ends of the
   * relation disagree inside one statement pair.
   */
  const referencedColumnLowering = (
    engine: QueryEngine,
    value: unknown
  ): { statement: string; values: unknown[] } => {
    const scope = createQueryScope(engine, vault);
    return rendered(buildScalarSqlValue(scope, vault, "key", value));
  };

  // A `bigint` is deliberately absent: `DecimalInput` is
  // `Decimal | string | number`, so a bigint operand is refused by the schema
  // rather than lowered here.
  for (const value of [BIG30, HALF, HALF_UNCANONICAL, 9.5, new Decimal(12)]) {
    test(`FK lowering of ${String(value)} equals the referenced column's`, () => {
      const engine = engineFor();
      const fk = rendered(referenceSql(engine, slip, "vaultKey", value));

      expect(fk).toEqual(referencedColumnLowering(engine, value));
    });
  }

  test("the FK never wears a lossy decimal cast", () => {
    const engine = engineFor();
    const fk = rendered(referenceSql(engine, slip, "vaultKey", BIG30));

    for (const spelling of dialectCase.forbidden) {
      expect(fk.statement).not.toContain(spelling);
    }
    // Canonicalized before binding, not passed through as the caller spelled
    // it — and bound in the DIALECT's own physical spelling, which is the
    // referenced column's: the coefficient on SQLite, the logical value
    // elsewhere. Comparing against the parent's lowering is the claim; a
    // written-down string would only be one dialect's half of it.
    const uncanonical = rendered(
      referenceSql(engine, slip, "vaultKey", HALF_UNCANONICAL)
    );
    expect(uncanonical.values).toEqual(
      referencedColumnLowering(engine, HALF).values
    );
    expect(uncanonical.values).not.toContain(HALF_UNCANONICAL);
  });

  test("a deferred FK expression takes the EXACT-decimal cast, not the number one", () => {
    const engine = engineFor();
    // A `Ref`/subquery cannot be canonicalized at build time — its value does
    // not exist yet — so it keeps the cast path. That path must still land in
    // the exact decimal domain.
    const deferred = rendered(
      referenceSql(engine, slip, "vaultKey", sql.raw`captured_key`)
    );

    for (const spelling of dialectCase.forbidden) {
      expect(deferred.statement).not.toContain(spelling);
    }
    expect(deferred.statement).toContain("captured_key");
    expect(deferred.statement).toContain(dialectCase.deferredDomain);
  });

  test("an approximate column keeps the numeric cast — the two are not merged", () => {
    // The fix splits `decimal` off from `numeric`; this pins that `number` was
    // not dragged along with it into the exact-decimal domain.
    const engine = engineFor();
    const numberFk = rendered(referenceSql(engine, gauge, "readingRef", 1.5));

    expect(numberFk.statement).toContain("CAST(");
    expect(numberFk.values).toEqual([1.5]);
  });
});

/**
 * An approximate-number FK, to prove the `decimal`/`numeric` split did not
 * swallow the `number` scalar.
 */
const gauge = s
  .model({
    id: s.string().id(),
    readingRef: s.number(),
  })
  .map("decimal_relkey_gauges");
