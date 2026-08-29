/**
 * §7.3's transition matrix, executed.
 *
 * Six rows — precision widening, precision narrowing, scale increase, scale
 * decrease, the same rule applied to every member of a list, and malformed
 * storage — each with the exact conversion it must perform and the refusal it
 * must make instead. The refusal half is the point of the file: a descriptor
 * change never rounds existing data, so the way a value that no longer fits is
 * handled is to fail and leave the old schema and data exactly where they were.
 *
 * Two live substrates, because the two families convert by different means: the
 * SQLite family rebuilds the table and rescales the stored coefficient inside
 * one `INSERT ... SELECT`, while PostgreSQL validates through a constraint and
 * then moves the typmod. MySQL's half is a rendering claim (it commits DDL
 * implicitly, so its refusal is what it does NOT emit) and lives in
 * `ddl-drivers.core.test.ts` beside the other MySQL renderers.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { generate } from "@migrations";
import { postgresDecimalFitsCheck } from "@migrations/decimal";
import type { AlterColumnOperation } from "@migrations/drivers/base";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { loadMigrationGraph } from "@migrations/graph";
import { invertOperations } from "@migrations/invert";
import { introspect as introspectClient } from "@migrations/push";
import { sliceDispatch } from "@migrations/sql-blob";
import type { MigrationOperationV1 } from "@migrations/v1-types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ddlContext, MemoryStorage, mysqlEstateDriver } from "./_estate";

async function readPublishedTransition(
  storage: MemoryStorage,
  stateId: string | null
) {
  if (stateId === null) throw new Error("missing generated state");
  const graph = await loadMigrationGraph(storage);
  const state = graph.states.get(stateId);
  if (!state) throw new Error("generated state was not published");
  const transition = state.parents[0];
  const blob = graph.sql.get(state.sqlHash);
  if (!(transition && blob))
    throw new Error("generated transition is incomplete");
  return { blob, transition };
}

function operationSql(
  blob: Uint8Array,
  operations: readonly MigrationOperationV1[]
): string[] {
  return operations.flatMap((operation) =>
    operation.steps.map((step) => sliceDispatch(blob, step.execute))
  );
}

const TABLE = "dec_tx";
const MYSQL_LIST_NARROWING_REFUSAL =
  /narrows its JSON list.*refused before any statement runs/s;

function ledger(precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision, scale }).nullable(),
      })
      .map(TABLE),
  };
}

function listLedger(precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        samples: s.decimal({ precision, scale }).array(),
      })
      .map(TABLE),
  };
}

function nullableListLedger(precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        samples: s.decimal({ precision, scale }).array().nullable(),
      })
      .map(TABLE),
  };
}

// =============================================================================
// THE SQLITE FAMILY — rebuild and rescale the stored coefficient
// =============================================================================

type AnySqliteDriver = SQLite3Driver;

/**
 * Every client in this file shares ONE driver and nothing disconnects until the
 * test is over: an in-memory SQLite database lives on its connection, so a
 * `$disconnect()` between two pushes would hand the second one an empty
 * database and turn a conversion into a `createTable` that passes for the wrong
 * reason.
 */
async function pushSchema(
  driver: AnySqliteDriver,
  schema: ReturnType<typeof ledger>
) {
  const client = createClient({ schema, driver });
  return await push(client, { force: true });
}

async function coefficients(driver: AnySqliteDriver): Promise<unknown[]> {
  const rows = await driver._executeRaw<{ amount: unknown }>(
    `SELECT "amount" FROM "${TABLE}" ORDER BY "id"`
  );
  return rows.rows.map((row) =>
    typeof row.amount === "bigint" ? Number(row.amount) : row.amount
  );
}

/** Runs one SQLite transition and reports what happened to the stored rows. */
async function sqliteTransition(options: {
  from: readonly [number, number];
  to: readonly [number, number];
  coefficients: readonly (number | null)[];
}): Promise<{ refusal: string | undefined; stored: unknown[] }> {
  const driver = createInMemorySQLite3Driver();
  await pushSchema(driver, ledger(...options.from));
  for (const [index, value] of options.coefficients.entries()) {
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","amount") VALUES ('${index}', ${value ?? "NULL"})`
    );
  }

  let refusal: string | undefined;
  const second = createClient({ schema: ledger(...options.to), driver });
  try {
    await push(second, { force: true });
  } catch (error) {
    refusal = (error as Error).message;
  }
  const stored = await coefficients(driver);
  await second.$disconnect();
  return { refusal, stored };
}

describe("SQLite: §7.3 row by row", () => {
  it("widens the precision without touching a coefficient", async () => {
    // Scale unchanged, so the stored integer already means the same number.
    const { refusal, stored } = await sqliteTransition({
      from: [10, 2],
      to: [12, 2],
      coefficients: [12_345, -1, 0, null],
    });
    expect(refusal).toBeUndefined();
    expect(stored).toEqual([12_345, -1, 0, null]);
  });

  it("narrows the precision when every value fits, and refuses when one does not", async () => {
    const fits = await sqliteTransition({
      from: [12, 2],
      to: [10, 2],
      coefficients: [12_345, -99],
    });
    expect(fits.refusal).toBeUndefined();
    expect(fits.stored).toEqual([12_345, -99]);

    const overflows = await sqliteTransition({
      from: [12, 2],
      to: [10, 2],
      coefficients: [12_345, 99_999_999_999],
    });
    expect(overflows.refusal).toBeDefined();
    // The estate is exactly as it was: the rebuild runs inside a transaction,
    // so the failed INSERT takes the whole recreation back with it.
    expect(overflows.stored).toEqual([12_345, 99_999_999_999]);
  });

  it("increases the scale by rescaling, and refuses when the target precision cannot hold it", async () => {
    const exact = await sqliteTransition({
      from: [10, 2],
      to: [10, 4],
      coefficients: [12_345, -1, 0, null],
    });
    expect(exact.refusal).toBeUndefined();
    // 123.45 at scale 4 is 1234500 — the value did not change, its spelling did.
    expect(exact.stored).toEqual([1_234_500, -100, 0, null]);

    // 1000000.00 fits ten digits at scale 2; at scale 4 its coefficient needs
    // eleven, so the two extra fractional digits cost it an integer digit it
    // does not have.
    const overflows = await sqliteTransition({
      from: [10, 2],
      to: [10, 4],
      coefficients: [100_000_000],
    });
    expect(overflows.refusal).toBeDefined();
    expect(overflows.stored).toEqual([100_000_000]);
  });

  it("decreases the scale only when the digits it drops are zero", async () => {
    const exact = await sqliteTransition({
      from: [10, 4],
      to: [10, 2],
      coefficients: [1_234_500, -100, 0, null],
    });
    expect(exact.refusal).toBeUndefined();
    expect(exact.stored).toEqual([12_345, -1, 0, null]);

    // The whole reason the conversion is not a cast: PostgreSQL's `USING` cast
    // and MySQL's `MODIFY` would both round 123.456 to 123.46 and call the
    // migration a success. §7.3 forbids it outright.
    const rounds = await sqliteTransition({
      from: [10, 4],
      to: [10, 2],
      coefficients: [1_234_560],
    });
    expect(rounds.refusal).toBeDefined();
    expect(rounds.stored).toEqual([1_234_560]);
  });

  it("refuses a column whose storage carries no descriptor at all", async () => {
    // An estate written by something other than this driver: an INTEGER column
    // with no reserved constraint, holding text. There is no source domain to
    // convert from, so nothing is guessed — the value is copied as it stands
    // and the target's own CHECK refuses it.
    const driver = createInMemorySQLite3Driver();
    await driver._executeRaw(
      `CREATE TABLE "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "amount" INTEGER)`
    );
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","amount") VALUES ('a', '12.34')`
    );

    const client = createClient({ schema: ledger(10, 2), driver });
    await expect(push(client, { force: true })).rejects.toThrow();
    const rows = await driver._executeRaw<{ amount: unknown }>(
      `SELECT "amount" FROM "${TABLE}"`
    );
    // SQLite's INTEGER affinity converted the text into a REAL as it was
    // stored, which is exactly the storage this representation exists to
    // refuse — and the refusal above left it untouched.
    expect(rows.rows).toEqual([{ amount: 12.34 }]);
    await client.$disconnect();
  });
});

describe("MySQL: same-scale decimal-list transitions", () => {
  const transition = (
    fromPrecision: number,
    toPrecision: number
  ): AlterColumnOperation => ({
    type: "alterColumn",
    tableName: "ledger",
    columnName: "samples",
    from: {
      name: "samples",
      type: "JSON",
      nullable: false,
      decimal: { precision: fromPrecision, scale: 2 },
    },
    to: {
      name: "samples",
      type: "JSON",
      nullable: false,
      decimal: { precision: toPrecision, scale: 2 },
    },
  });

  it("admits widening but refuses the automatic narrowing down before DDL", () => {
    const up = transition(10, 12);
    const down = invertOperations([up], { tables: [] }).operations[0];
    expect(down).toEqual({ ...up, from: up.to, to: up.from });

    const statements = mysqlMigrationDriver
      .generateDDL(up, ddlContext("live"))
      .split(";\n");

    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe(
      "ALTER TABLE `ledger` ADD CONSTRAINT `viborm_decimal_l_10_2` CHECK (`samples` IS NULL OR (LEFT(CAST(`samples` AS CHAR CHARACTER SET utf8mb4), 1) = '[' AND RIGHT(CAST(`samples` AS CHAR CHARACTER SET utf8mb4), 1) = ']' AND REGEXP_LIKE(CAST(`samples` AS CHAR CHARACTER SET utf8mb4), '^.((\"0\"|\"-?[1-9][0-9]{0,9}\")(, (\"0\"|\"-?[1-9][0-9]{0,9}\"))*)?.$', 'c')))"
    );
    expect(statements[1]).toBe(
      "ALTER TABLE `ledger` MODIFY COLUMN `samples` JSON NOT NULL COMMENT 'viborm:decimal(12,2)'"
    );
    expect(statements[2]).toBe(
      "ALTER TABLE `ledger` DROP CHECK `viborm_decimal_l_10_2`"
    );

    if (down === undefined) throw new Error("missing automatic down");
    expect(() =>
      mysqlMigrationDriver.generateDDL(down, ddlContext("live"))
    ).toThrow(MYSQL_LIST_NARROWING_REFUSAL);
  });

  it.each([
    false,
    true,
  ])("generates widening with an irreversible down (dryRun=%s)", async (dryRun) => {
    const storage = new MemoryStorage();
    const driver = mysqlEstateDriver({ namespace: "ledger_test" });
    await generate({ $schema: listLedger(10, 2), $driver: driver }, storage, {
      name: "init",
    });
    storage.writes.length = 0;

    const widened = await generate(
      { $schema: listLedger(12, 2), $driver: driver },
      storage,
      { name: "widen", dryRun }
    );

    expect(widened.outcome).toBe(dryRun ? "preview" : "published");
    expect(widened.sql.match(/ALTER TABLE/g)).toHaveLength(3);
    expect(storage.writes.length === 0).toBe(dryRun);
    if (!dryRun) {
      const { transition } = await readPublishedTransition(
        storage,
        widened.stateId
      );
      expect(transition.rollback).toEqual({
        kind: "irreversible",
        reason: expect.stringContaining(
          "MySQL cannot automatically roll back the decimal-list widening"
        ),
      });
    }
  });

  it("keeps an ordinary scalar widening rollback automatic", async () => {
    const storage = new MemoryStorage();
    const driver = mysqlEstateDriver({ namespace: "ledger_test" });
    await generate({ $schema: ledger(10, 2), $driver: driver }, storage, {
      name: "init",
    });

    const widened = await generate(
      { $schema: ledger(12, 2), $driver: driver },
      storage,
      { name: "widen" }
    );

    const { blob, transition } = await readPublishedTransition(
      storage,
      widened.stateId
    );
    expect(transition.rollback.kind).toBe("schema");
    if (transition.rollback.kind !== "schema") {
      throw new Error("expected an automatic schema rollback");
    }
    expect(operationSql(blob, transition.rollback.operations)).toEqual([
      "ALTER TABLE `dec_tx` ADD CONSTRAINT `viborm_decimal_s_10_2` CHECK (`amount` IS NULL OR `amount` = CAST(`amount` AS DECIMAL(10,2)))",
      "ALTER TABLE `dec_tx` MODIFY COLUMN `amount` DECIMAL(10,2)",
      "ALTER TABLE `dec_tx` DROP CHECK `viborm_decimal_s_10_2`",
    ]);
  });
});

describe("SQLite: lists convert member by member", () => {
  it("preserves order and multiplicity, and refuses one bad member", async () => {
    const driver = createInMemorySQLite3Driver();
    const first = createClient({ schema: listLedger(10, 2), driver });
    await push(first, { force: true });
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","samples") VALUES ('a', '["300","100","300"]')`
    );
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","samples") VALUES ('b', '[]')`
    );

    const second = createClient({ schema: listLedger(10, 4), driver });
    await push(second, { force: true });
    const converted = await driver._executeRaw<{ samples: string }>(
      `SELECT "samples" FROM "${TABLE}" ORDER BY "id"`
    );
    // Order and duplicates survive: `json_each` yields the array position and
    // the aggregate reads it back in that order.
    expect(converted.rows.map((row) => row.samples)).toEqual([
      '["30000","10000","30000"]',
      "[]",
    ]);

    // One member that cannot be rescaled exactly routes the WHOLE column to a
    // value the target check refuses — a half-converted list is never written.
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","samples") VALUES ('c', '["1"]')`
    );
    const third = createClient({ schema: listLedger(10, 2), driver });
    await expect(push(third, { force: true })).rejects.toThrow();
    const preserved = await driver._executeRaw<{ samples: string }>(
      `SELECT "samples" FROM "${TABLE}" ORDER BY "id"`
    );
    expect(preserved.rows.map((row) => row.samples)).toEqual([
      '["30000","10000","30000"]',
      "[]",
      '["1"]',
    ]);
    await third.$disconnect();
  });

  it("refuses a valid JSON scalar before json_each can turn it into a list", async () => {
    const driver = createInMemorySQLite3Driver();
    const first = createClient({ schema: listLedger(10, 2), driver });
    await push(first, { force: true });

    // Simulate corrupted storage underneath the descriptor carrier. A JSON
    // string is valid JSON and json_each exposes it as one TEXT member, so a
    // member-only proof would quietly rewrite `"123"` into `["12300"]`.
    await driver._executeRaw("PRAGMA ignore_check_constraints=ON");
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","samples") VALUES ('scalar', '"123"')`
    );
    await driver._executeRaw("PRAGMA ignore_check_constraints=OFF");

    const second = createClient({ schema: listLedger(10, 4), driver });
    await expect(push(second, { force: true })).rejects.toThrow();
    const preserved = await driver._executeRaw<{ samples: string }>(
      `SELECT "samples" FROM "${TABLE}" WHERE "id" = 'scalar'`
    );
    expect(preserved.rows).toEqual([{ samples: '"123"' }]);
    await second.$disconnect();
  });
});

describe("SQLite family: a second push is empty", () => {
  for (const [name, make] of [
    ["sqlite3", createInMemorySQLite3Driver],
  ] as const) {
    it(`${name} converges after a fresh push and after a conversion`, async () => {
      const driver = make();
      const fresh = createClient({ schema: ledger(10, 2), driver });
      expect(
        (await push(fresh, { force: true })).operations.length
      ).toBeGreaterThan(0);
      // The descriptor round-trips through the reserved constraint: without it
      // the desired side declares a domain the introspected side cannot, and
      // every push re-plans the same alterColumn.
      expect((await push(fresh, { force: true })).operations).toEqual([]);
      await driver._executeRaw(
        `INSERT INTO "${TABLE}" ("id","amount") VALUES ('a', 12345)`
      );

      const moved = createClient({ schema: ledger(10, 4), driver });
      expect((await push(moved, { force: true })).operations.length).toBe(1);
      expect((await push(moved, { force: true })).operations).toEqual([]);
      expect(await coefficients(driver)).toEqual([1_234_500]);
      await moved.$disconnect();

      // A fresh database for the list: the two models describe the same table
      // name with different columns, so sharing one would be an unrelated
      // add/drop rather than the convergence claim.
      const listDriver = make();
      const list = createClient({
        schema: listLedger(8, 3),
        driver: listDriver,
      });
      expect(
        (await push(list, { force: true })).operations.length
      ).toBeGreaterThan(0);
      expect((await push(list, { force: true })).operations).toEqual([]);
      await list.$disconnect();
    });
  }
});

// =============================================================================
// POSTGRESQL — validate through a constraint, then move the typmod
// =============================================================================

describe("PostgreSQL: §7.3 on PGlite", () => {
  let database: PGlite | undefined;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE SCHEMA "tenant_dec"');
  });

  afterAll(async () => {
    await database?.close();
  });

  function clientFor(schema: ReturnType<typeof ledger>) {
    return createClient({
      schema,
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
  }

  async function reset() {
    await database?.exec(`DROP TABLE IF EXISTS "tenant_dec"."${TABLE}"`);
  }

  async function values(): Promise<unknown[]> {
    const rows = await database?.query<{ amount: unknown }>(
      `SELECT "amount"::text AS amount FROM "tenant_dec"."${TABLE}" ORDER BY "id"`
    );
    return (rows?.rows ?? []).map((row) => row.amount);
  }

  it("widens, narrows, and refuses a value the narrower domain cannot hold", async () => {
    await reset();
    const first = clientFor(ledger(12, 2));
    await push(first, { force: true });
    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","amount") VALUES ('a', 123.45)`
    );
    await first.$disconnect();

    const narrowed = clientFor(ledger(10, 2));
    await push(narrowed, { force: true });
    expect(await values()).toEqual(["123.45"]);
    await narrowed.$disconnect();

    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","amount") VALUES ('b', 12345678.90)`
    );
    const tooNarrow = clientFor(ledger(6, 2));
    await expect(push(tooNarrow, { force: true })).rejects.toThrow();
    // Refused BEFORE the type moved: both rows are still here, unrounded.
    expect(await values()).toEqual(["123.45", "12345678.90"]);
    await tooNarrow.$disconnect();
  });

  it("decreases the scale only when the discarded digits are zero — it never rounds", async () => {
    await reset();
    const first = clientFor(ledger(10, 4));
    await push(first, { force: true });
    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","amount") VALUES ('a', 123.4500)`
    );
    await first.$disconnect();

    const exact = clientFor(ledger(10, 2));
    await push(exact, { force: true });
    expect(await values()).toEqual(["123.45"]);
    await exact.$disconnect();

    // A bare `ALTER ... TYPE numeric(10,1) USING amount::numeric(10,1)` would
    // answer 123.5 and report success. The validation constraint is what turns
    // that into a refusal.
    const rounds = clientFor(ledger(10, 1));
    await expect(push(rounds, { force: true })).rejects.toThrow();
    expect(await values()).toEqual(["123.45"]);
    await rounds.$disconnect();
  });

  it("increases the scale exactly, and refuses when the target precision cannot hold it", async () => {
    await reset();
    const first = clientFor(ledger(10, 2));
    await push(first, { force: true });
    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","amount") VALUES ('a', 123.45)`
    );
    await first.$disconnect();

    const widened = clientFor(ledger(10, 4));
    await push(widened, { force: true });
    expect(await values()).toEqual(["123.4500"]);
    await widened.$disconnect();

    // 10000.0000 is nine digits at scale 4 and eleven at scale 6: the two
    // extra fractional digits cost integer digits the precision does not have.
    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","amount") VALUES ('b', 10000.0000)`
    );
    const overflows = clientFor(ledger(10, 6));
    await expect(push(overflows, { force: true })).rejects.toThrow();
    expect(await values()).toEqual(["123.4500", "10000.0000"]);
    await overflows.$disconnect();
  });

  it("converts an array's typmod and refuses a member that does not fit", async () => {
    await reset();
    const first = createClient({
      schema: listLedger(10, 2),
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    await push(first, { force: true });
    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","samples") VALUES ('a', '{1.25,3.00,1.25}')`
    );
    await first.$disconnect();

    const widened = createClient({
      schema: listLedger(12, 2),
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    await push(widened, { force: true });
    const rows = await database?.query<{ samples: string }>(
      `SELECT "samples"::text AS samples FROM "tenant_dec"."${TABLE}"`
    );
    // Order and duplicates are the array's own.
    expect(rows?.rows[0]?.samples).toBe("{1.25,3.00,1.25}");
    await widened.$disconnect();

    const narrowed = createClient({
      schema: listLedger(12, 1),
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    await expect(push(narrowed, { force: true })).rejects.toThrow();
    await narrowed.$disconnect();
  });

  it("refuses a null array member while preserving a nullable whole array", async () => {
    await reset();
    const first = createClient({
      schema: nullableListLedger(10, 2),
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    await push(first, { force: true });
    await database?.exec(
      `INSERT INTO "tenant_dec"."${TABLE}" ("id","samples") VALUES ` +
        `('whole-null', NULL), ` +
        `('member-null', ARRAY[1.25,NULL]::numeric(10,2)[])`
    );
    await first.$disconnect();

    const widened = createClient({
      schema: nullableListLedger(12, 2),
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    await expect(push(widened, { force: true })).rejects.toThrow();
    const preserved = await database?.query<{ samples: string | null }>(
      `SELECT "samples"::text AS "samples" FROM "tenant_dec"."${TABLE}" ORDER BY "id"`
    );
    expect(preserved?.rows).toEqual([
      { samples: "{1.25,NULL}" },
      { samples: null },
    ]);

    await database?.exec(
      `DELETE FROM "tenant_dec"."${TABLE}" WHERE "id" = 'member-null'`
    );
    await push(widened, { force: true });
    const nullable = await database?.query<{ samples: string | null }>(
      `SELECT "samples"::text AS "samples" FROM "tenant_dec"."${TABLE}"`
    );
    expect(nullable?.rows).toEqual([{ samples: null }]);
    await widened.$disconnect();
  });

  it("refuses every non-finite scalar and array member while preserving admitted rows", async () => {
    await database?.exec(
      `DROP TABLE IF EXISTS "tenant_dec"."decimal_fit_sql"; ` +
        `CREATE TABLE "tenant_dec"."decimal_fit_sql" (` +
        `"id" text PRIMARY KEY, "amount" numeric, "samples" numeric[]); ` +
        `ALTER TABLE "tenant_dec"."decimal_fit_sql" ADD CONSTRAINT "scalar_fits" ` +
        `CHECK (${postgresDecimalFitsCheck('"amount"', "numeric(10,2)")}); ` +
        `ALTER TABLE "tenant_dec"."decimal_fit_sql" ADD CONSTRAINT "list_fits" ` +
        `CHECK (${postgresDecimalFitsCheck('"samples"', "numeric(10,2)[]")})`
    );
    await database?.exec(
      `INSERT INTO "tenant_dec"."decimal_fit_sql" ("id","amount","samples") VALUES ` +
        `('nulls', NULL, NULL), ` +
        `('finite', 1.25, ARRAY[1.25,3.00,1.25]::numeric[])`
    );

    for (const [name, literal] of [
      ["nan", "'NaN'::numeric"],
      ["positive-infinity", "'Infinity'::numeric"],
      ["negative-infinity", "'-Infinity'::numeric"],
    ]) {
      await expect(
        database?.exec(
          `INSERT INTO "tenant_dec"."decimal_fit_sql" ("id","amount") ` +
            `VALUES ('${name}', ${literal})`
        )
      ).rejects.toThrow();
      for (const position of [
        `${literal},1.25,3.00`,
        `1.25,${literal},3.00`,
        `1.25,3.00,${literal}`,
      ]) {
        await expect(
          database?.exec(
            `INSERT INTO "tenant_dec"."decimal_fit_sql" ("id","samples") ` +
              `VALUES ('${name}', ARRAY[${position}]::numeric[])`
          )
        ).rejects.toThrow();
      }
    }

    const preserved = await database?.query<{
      id: string;
      amount: string | null;
      samples: string | null;
    }>(
      `SELECT "id", "amount"::text AS "amount", "samples"::text AS "samples" ` +
        `FROM "tenant_dec"."decimal_fit_sql" ORDER BY "id"`
    );
    expect(preserved?.rows).toEqual([
      { id: "finite", amount: "1.25", samples: "{1.25,3.00,1.25}" },
      { id: "nulls", amount: null, samples: null },
    ]);
  });

  it("converges on a second push, for a scalar and for an array", async () => {
    await reset();
    const scalar = clientFor(ledger(10, 5));
    expect(
      (await push(scalar, { force: true })).operations.length
    ).toBeGreaterThan(0);
    // The scalar typmod round-trips through `information_schema`.
    expect((await push(scalar, { force: true })).operations).toEqual([]);
    await scalar.$disconnect();

    await reset();
    const list = createClient({
      schema: listLedger(10, 5),
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    expect(
      (await push(list, { force: true })).operations.length
    ).toBeGreaterThan(0);
    // The ARRAY typmod is reported nowhere but `format_type`: read through
    // `udt_name` the column is a bare `numeric[]`, and every push re-alters it.
    const snapshot = await introspectClient(list);
    expect(
      snapshot.tables
        .find((table) => table.name === TABLE)
        ?.columns.map((c) => c.type)
    ).toContain("numeric(10,5)[]");
    expect((await push(list, { force: true })).operations).toEqual([]);
    await list.$disconnect();
  });

  it("keeps a negative default from churning", async () => {
    // PostgreSQL deparses `DEFAULT -12.34000` as `'-12.34000'::numeric` and
    // `DEFAULT 12.34000` as the bare literal, so the two sides only agree once
    // the read-back goes through the same DDL rendering the serializer used.
    await reset();
    const seeded = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            positive: s.decimal({ precision: 10, scale: 5 }).default("12.34"),
            negative: s.decimal({ precision: 10, scale: 5 }).default("-12.34"),
          })
          .map(TABLE),
      },
      driver: new PGliteDriver({ client: database, namespace: "tenant_dec" }),
    });
    expect(
      (await push(seeded, { force: true })).operations.length
    ).toBeGreaterThan(0);
    expect((await push(seeded, { force: true })).operations).toEqual([]);
    await seeded.$disconnect();
  });
});
