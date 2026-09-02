/**
 * Live fixed-decimal carrier lifecycle contracts.
 *
 * These tests own real in-memory SQLite and PGlite execution. Deterministic
 * parser and renderer contracts stay in decimal-descriptor-carriers.core.test.ts.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import type { ResolveChange } from "@migrations/types";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { beforeAll, describe, expect, it } from "vitest";

const ORPHANED_CARRIER = /viborm_decimal_amount_10_2/;
const UNMARKED_TEXT_STORAGE = /unmarked TEXT storage/i;
const CHANGE_REJECTED = /Change rejected/;

function ledgerModel(field: string, precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        [field]: s.decimal({ precision, scale }).nullable(),
      })
      .map("carriers"),
  };
}

function tableLedgerModel(table: string, precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision, scale }).nullable(),
        label: s.string(),
      })
      .map(table),
  };
}

function nestedRenameLedgerModel(
  table: string,
  field: string,
  precision: number,
  scale: number
) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        code: s.string().nullable(),
        label: s.string().nullable(),
        state: s.string().nullable(),
        owner: s.string().nullable(),
        created: s.string().nullable(),
        note: s.string().nullable(),
        [field]: s.decimal({ precision, scale }).nullable(),
      })
      .map(table),
  };
}

function renameResolver(seen: string[]) {
  return (change: ResolveChange) => {
    seen.push(`${change.type}:${change.description ?? ""}`);
    if (change.type === "ambiguous") return change.rename();
    if (change.type === "destructive") return change.proceed();
    return change.reject();
  };
}

describe("a decimal column's reserved constraint survives a rename", () => {
  it("renames and converts the carrier in one push, then converges", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "carriers" ("id","amount") VALUES ('a', 12345)`
    );

    // The same logical field, renamed AND rescaled: 12345 means 123.45 at
    // scale 2 and must mean 123.45 at scale 4 too, i.e. 1234500.
    const after = createClient({ schema: ledgerModel("total", 10, 4), driver });
    const seen: string[] = [];
    const rename = await push(after, {
      force: true,
      resolve: renameResolver(seen),
    });
    expect(rename.operations.map((operation) => operation.type)).toEqual([
      "renameColumn",
      "alterColumn",
    ]);

    const renamed = await driver._executeRaw<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='carriers'`
    );
    // The carrier is named after the column it constrains. SQLite rewrites
    // column REFERENCES inside a CHECK on RENAME COLUMN but never a constraint
    // NAME, so the native rename would leave `viborm_decimal_amount_10_2`
    // behind on a column called `total`.
    expect(renamed.rows[0]?.sql).toContain("viborm_decimal_total_10_4");
    expect(renamed.rows[0]?.sql).not.toContain("viborm_decimal_amount_10_2");

    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "carriers"`
    );
    expect(stored.rows[0]?.total).toBe(1_234_500);

    const second = await push(after, { force: true });
    expect(second.operations).toEqual([]);
    expect(seen.map((entry) => entry.split(":", 1)[0])).toEqual([
      "ambiguous",
      "destructive",
    ]);
    await after.$disconnect();
  });

  it("carries a partial-index predicate through the native rename replay", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .index(["amount"], {
            name: "indexed_amount",
            where: '"amount" > 0',
          })
          .map("indexed_carriers"),
      },
      driver,
    });
    await push(before, { force: true });

    const after = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            total: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .index(["total"], {
            name: "indexed_amount",
            where: '"total" > 0',
          })
          .map("indexed_carriers"),
      },
      driver,
    });
    const renamed = await push(after, {
      resolve: (change: ResolveChange) =>
        change.type === "ambiguous" ? change.rename() : change.reject(),
    });

    expect(renamed.operations.map((operation) => operation.type)).toEqual([
      "renameColumn",
    ]);
    const storedIndex = await driver._executeRaw<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='indexed_amount'`
    );
    expect(storedIndex.rows[0]?.sql).toContain('WHERE "total" > 0');
    await after.$disconnect();
  });

  it("refuses loudly when a carrier was orphaned outside VibORM", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(client, { force: true });
    await driver._executeRaw(
      `INSERT INTO "carriers" ("id","amount") VALUES ('a', 12345)`
    );
    // SQLite rewrites the CHECK body's column references and leaves the
    // constraint NAME alone, so a hand-run rename detaches the carrier.
    await driver._executeRaw(
      `ALTER TABLE "carriers" RENAME COLUMN "amount" TO "total"`
    );

    const moved = createClient({ schema: ledgerModel("total", 10, 4), driver });
    await expect(push(moved, { force: true })).rejects.toThrow(
      ORPHANED_CARRIER
    );
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "carriers"`
    );
    expect(stored.rows[0]?.total).toBe(12_345);
    await moved.$disconnect();
  });

  it("converges on the SECOND push when only the name moved", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "carriers" ("id","amount") VALUES ('a', 12345)`
    );

    const after = createClient({ schema: ledgerModel("total", 10, 2), driver });
    const seen: string[] = [];
    await push(after, { force: true, resolve: renameResolver(seen) });

    // §9.6: "Second push is empty on every admitted provider."
    const second = await push(after, { force: true });
    expect(second.operations).toEqual([]);
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "carriers"`
    );
    expect(stored.rows[0]?.total).toBe(12_345);
    await after.$disconnect();
  });
});
describe("the carrier survives every route that rewrites a column", () => {
  // The reader proves ownership by RE-RENDERING the clause, so a route that
  // re-spells the stored definition would stop it being readable. LibSQL's
  // native `ALTER COLUMN … TO` replaces the whole declaration and is the only
  // route that is not this driver's own `CREATE TABLE`.
  for (const substrate of [
    { name: "sqlite3", create: createInMemorySQLite3Driver },
  ]) {
    it(`${substrate.name} keeps it readable across a nullability change`, async () => {
      const driver = substrate.create();
      const model = (nullable: boolean) => ({
        m: s
          .model({
            id: s.string().id(),
            amount: nullable
              ? s.decimal({ precision: 10, scale: 2 }).nullable()
              : s.decimal({ precision: 10, scale: 2 }),
          })
          .map("nullswap"),
      });
      const before = createClient({ schema: model(true), driver });
      await push(before, { force: true });
      await driver._executeRaw(
        `INSERT INTO "nullswap" ("id","amount") VALUES ('a', 12345)`
      );

      const after = createClient({ schema: model(false), driver });
      await push(after, { force: true });
      // A descriptor the reader can no longer own would re-plan this forever.
      expect((await push(after, { force: true })).operations).toEqual([]);
      const stored = await driver._executeRaw<{ amount: number | bigint }>(
        `SELECT "amount" FROM "nullswap"`
      );
      expect(Number(stored.rows[0]?.amount)).toBe(12_345);
      await after.$disconnect();
    });
  }
});

describe("a renamed table keeps and converts its decimal carrier", () => {
  for (const substrate of [
    { name: "sqlite3", create: createInMemorySQLite3Driver },
  ]) {
    it(`${substrate.name} applies the rename and descriptor change in one push`, async () => {
      const driver = substrate.create();
      const before = createClient({
        schema: tableLedgerModel("ledger_before", 10, 2),
        driver,
      });
      await push(before, { force: true });
      await driver._executeRaw(
        `INSERT INTO "ledger_before" ("id","amount","label") VALUES ('a',12345,'kept')`
      );

      const after = createClient({
        schema: tableLedgerModel("ledger_after", 10, 4),
        driver,
      });
      const seen: string[] = [];
      const first = await push(after, {
        force: true,
        resolve: renameResolver(seen),
      });
      expect(first.operations.map((operation) => operation.type)).toEqual([
        "renameTable",
        "alterColumn",
      ]);
      const stored = await driver._executeRaw<{
        amount: number | bigint;
        label: string;
      }>(`SELECT "amount", "label" FROM "ledger_after"`);
      expect(
        stored.rows.map((row) => ({
          amount: Number(row.amount),
          label: row.label,
        }))
      ).toEqual([{ amount: 1_234_500, label: "kept" }]);
      expect((await push(after, { force: true })).operations).toEqual([]);
      await after.$disconnect();
    });
  }
});

describe("an outer table rename exposes its inner column decision", () => {
  it("asks for both renames, then asks before the revealed narrowing", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: nestedRenameLedgerModel("nested_before", "amount", 12, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "nested_before" ("id","amount") VALUES ('a',12345)`
    );

    const after = createClient({
      schema: nestedRenameLedgerModel("nested_after", "total", 10, 2),
      driver,
    });
    const seen: string[] = [];
    const first = await push(after, {
      resolve: (change: ResolveChange) => {
        if (change.type === "enumValueRemoval") return change.reject();
        seen.push(`${change.type}:${change.operation}`);
        if (change.type === "ambiguous") return change.rename();
        return change.proceed();
      },
    });

    expect(seen).toEqual([
      "ambiguous:renameTable",
      "ambiguous:renameColumn",
      "destructive:alterColumn",
    ]);
    expect(first.operations.map((operation) => operation.type)).toEqual([
      "renameTable",
      "renameColumn",
      "alterColumn",
    ]);
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "nested_after"`
    );
    expect(stored.rows).toEqual([{ total: 12_345 }]);
    await after.$disconnect();
  });

  it("treats addAndDrop as the destructive authorization it already is", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(before, { force: true });
    const after = createClient({
      schema: ledgerModel("total", 10, 2),
      driver,
    });
    const seen: string[] = [];

    const pushed = await push(after, {
      resolve: (change: ResolveChange) => {
        seen.push(change.type);
        if (change.type === "ambiguous") return change.addAndDrop();
        return change.reject();
      },
    });

    expect(seen).toEqual(["ambiguous"]);
    expect(pushed.operations.map((operation) => operation.type)).toEqual([
      "dropColumn",
      "addColumn",
    ]);
    await after.$disconnect();
  });

  it("rejects the revealed narrowing before either rename runs", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: nestedRenameLedgerModel("rejected_before", "amount", 12, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "rejected_before" ("id","amount") VALUES ('a',12345)`
    );
    const after = createClient({
      schema: nestedRenameLedgerModel("rejected_after", "total", 10, 2),
      driver,
    });
    const seen: string[] = [];

    await expect(
      push(after, {
        resolve: (change: ResolveChange) => {
          if (change.type === "enumValueRemoval") return change.reject();
          seen.push(`${change.type}:${change.operation}`);
          if (change.type === "ambiguous") return change.rename();
          return change.reject();
        },
      })
    ).rejects.toThrow(CHANGE_REJECTED);
    expect(seen).toEqual([
      "ambiguous:renameTable",
      "ambiguous:renameColumn",
      "destructive:alterColumn",
    ]);
    const tables = await driver._executeRaw<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rejected_%' ORDER BY name`
    );
    expect(tables.rows).toEqual([{ name: "rejected_before" }]);
    const columns = await driver._executeRaw<{ name: string }>(
      `PRAGMA table_info("rejected_before")`
    );
    expect(columns.rows.map((column) => column.name)).toContain("amount");
    expect(columns.rows.map((column) => column.name)).not.toContain("total");
    await after.$disconnect();
  });
});

describe("a user default cannot impersonate a reserved carrier", () => {
  it("N1 a user default that spells the reserved name cannot override the real descriptor", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: {
        m: s
          .model({
            // Sorted before `amount`, so a first-hit substring scan finds it.
            aaa: s
              .string()
              .default('CONSTRAINT "viborm_decimal_amount_10_4" CHECK'),
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("n1"),
      },
      driver,
    });
    await push(client, { force: true });
    await driver._executeRaw(
      `INSERT INTO "n1" ("id","aaa","amount") VALUES ('a','x', 12300)`
    );

    const second = await push(client, { force: true });
    expect(second.operations).toEqual([]);
    const stored = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "n1"`
    );
    expect(stored.rows[0]?.amount).toBe(12_300);
    await client.$disconnect();
  });
});

describe("adopting a column that carries no descriptor", () => {
  it("SQLite converts the logical integer into a coefficient", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = createClient({
      schema: {
        m: s
          .model({ id: s.string().id(), amount: s.int().nullable() })
          .map("adopt"),
      },
      driver,
    });
    await push(plain, { force: true });
    await driver._executeRaw(
      `INSERT INTO "adopt" ("id","amount") VALUES ('a', 123)`
    );

    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("adopt"),
      },
      driver,
    });
    await push(adopted, { force: true });
    const stored = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "adopt"`
    );
    // 123 meant one hundred and twenty-three; at scale 2 that is 12300.
    expect(stored.rows[0]?.amount).toBe(12_300);
    expect((await push(adopted, { force: true })).operations).toEqual([]);
    await adopted.$disconnect();
  });

  it("SQLite refuses an adoption the target domain cannot hold, and keeps the data", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = createClient({
      schema: {
        m: s
          .model({ id: s.string().id(), amount: s.int().nullable() })
          .map("adopt2"),
      },
      driver,
    });
    await push(plain, { force: true });
    // 10^9 at scale 2 needs 11 digits; the target holds 10.
    await driver._executeRaw(
      `INSERT INTO "adopt2" ("id","amount") VALUES ('a', 1000000000)`
    );

    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("adopt2"),
      },
      driver,
    });
    await expect(push(adopted, { force: true })).rejects.toThrow();
    const stored = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "adopt2"`
    );
    expect(stored.rows[0]?.amount).toBe(1_000_000_000);
    await adopted.$disconnect();
  });

  it("refuses a TEXT scalar before SQLite affinity can reinterpret it", async () => {
    const driver = createInMemorySQLite3Driver();
    await driver._executeRaw(
      `CREATE TABLE "adopt_text" ("id" TEXT NOT NULL PRIMARY KEY, "amount" TEXT)`
    );
    await driver._executeRaw(
      `INSERT INTO "adopt_text" ("id","amount") VALUES ('a', '123')`
    );
    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("adopt_text"),
      },
      driver,
    });

    await expect(push(adopted, { force: true })).rejects.toThrow(
      UNMARKED_TEXT_STORAGE
    );
    const preserved = await driver._executeRaw<{
      amount: string;
      storage: string;
    }>(`SELECT "amount", typeof("amount") AS "storage" FROM "adopt_text"`);
    expect(preserved.rows).toEqual([{ amount: "123", storage: "text" }]);
    await adopted.$disconnect();
  });

  it("refuses every unmarked list before a valid container can gain a scale", async () => {
    const driver = createInMemorySQLite3Driver();
    await driver._executeRaw(
      `CREATE TABLE "adopt_list" ("id" TEXT NOT NULL PRIMARY KEY, "samples" TEXT)`
    );
    await driver._executeRaw(
      `INSERT INTO "adopt_list" ("id","samples") VALUES ('a', '["120"]')`
    );
    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            samples: s.decimal({ precision: 10, scale: 2 }).array().nullable(),
          })
          .map("adopt_list"),
      },
      driver,
    });

    await expect(push(adopted, { force: true })).rejects.toThrow(
      UNMARKED_TEXT_STORAGE
    );
    const preserved = await driver._executeRaw<{ samples: string }>(
      `SELECT "samples" FROM "adopt_list"`
    );
    expect(preserved.rows).toEqual([{ samples: '["120"]' }]);
    await adopted.$disconnect();
  });
});

/**
 * The PostgreSQL leg answers from the worker's ONE PGlite through this suite's
 * own private schema, in place of a whole Wasm Postgres of its own. The family
 * carries no models: every case below still builds the estate it adopts. Raw
 * SQL is sent verbatim, so each statement names that schema itself.
 */
const getPostgresFamily = usePGliteSchemaFamily({});

describe("PostgreSQL validates against the target domain alone", () => {
  let db: PGlite;
  let namespace = "";
  beforeAll(() => {
    const family = getPostgresFamily();
    db = family.database;
    namespace = family.namespace;
  });

  it("refuses an unconstrained numeric whose value the target would round", async () => {
    await db.exec(`DROP TABLE IF EXISTS "${namespace}"."pgadopt"`);
    await db.exec(
      `CREATE TABLE "${namespace}"."pgadopt" ("id" TEXT NOT NULL PRIMARY KEY, "amount" numeric)`
    );
    await db.exec(
      `INSERT INTO "${namespace}"."pgadopt" ("id","amount") VALUES ('a', 123.456789)`
    );
    const client = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("pgadopt"),
      },
      driver: new PGliteDriver({ client: db, namespace }),
    });
    await expect(push(client, { force: true })).rejects.toThrow();
    const rows = await db.query<{ v: string }>(
      `SELECT "amount"::text AS v FROM "${namespace}"."pgadopt"`
    );
    // §7.3: "No descriptor change rounds existing data."
    expect(rows.rows[0]?.v).toBe("123.456789");
    await client.$disconnect();
  });

  it("adopts an unconstrained numeric whose values all fit, and converges", async () => {
    await db.exec(`DROP TABLE IF EXISTS "${namespace}"."pgadopt2"`);
    await db.exec(
      `CREATE TABLE "${namespace}"."pgadopt2" ("id" TEXT NOT NULL PRIMARY KEY, "amount" numeric)`
    );
    await db.exec(
      `INSERT INTO "${namespace}"."pgadopt2" ("id","amount") VALUES ('a', 123.45)`
    );
    const client = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("pgadopt2"),
      },
      driver: new PGliteDriver({ client: db, namespace }),
    });
    await push(client, { force: true });
    const rows = await db.query<{ v: string }>(
      `SELECT "amount"::text AS v FROM "${namespace}"."pgadopt2"`
    );
    expect(rows.rows[0]?.v).toBe("123.45");
    expect((await push(client, { force: true })).operations).toEqual([]);
    await client.$disconnect();
  });

  it("renames a table and moves its typmod in one convergent push", async () => {
    await db.exec(
      `DROP TABLE IF EXISTS "${namespace}"."pg_table_before", "${namespace}"."pg_table_after"`
    );
    const before = createClient({
      schema: tableLedgerModel("pg_table_before", 10, 2),
      driver: new PGliteDriver({ client: db, namespace }),
    });
    await push(before, { force: true });
    await db.exec(
      `INSERT INTO "${namespace}"."pg_table_before" ("id","amount","label") VALUES ('a',123.45,'kept')`
    );

    const after = createClient({
      schema: tableLedgerModel("pg_table_after", 10, 4),
      driver: new PGliteDriver({ client: db, namespace }),
    });
    const seen: string[] = [];
    const first = await push(after, {
      force: true,
      resolve: renameResolver(seen),
    });
    expect(first.operations.map((operation) => operation.type)).toEqual([
      "renameTable",
      "alterColumn",
    ]);
    const rows = await db.query<{ amount: string; label: string }>(
      `SELECT "amount"::text AS "amount", "label" FROM "${namespace}"."pg_table_after"`
    );
    expect(rows.rows).toEqual([{ amount: "123.4500", label: "kept" }]);
    expect((await push(after, { force: true })).operations).toEqual([]);
    await after.$disconnect();
  });

  it("retargets an enum-removal decision through accepted table and column renames", async () => {
    await db.exec(
      `DROP TABLE IF EXISTS "${namespace}"."enum_before", "${namespace}"."enum_after"; ` +
        `DROP TYPE IF EXISTS "${namespace}"."closure_state"`
    );
    const before = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            code: s.string().nullable(),
            label: s.string().nullable(),
            owner: s.string().nullable(),
            created: s.string().nullable(),
            note: s.string().nullable(),
            status: s.enum(["active", "retired"]).name("closure_state"),
          })
          .map("enum_before"),
      },
      driver: new PGliteDriver({ client: db, namespace }),
    });
    await push(before, { force: true });
    await db.exec(
      `INSERT INTO "${namespace}"."enum_before" ("id","status") VALUES ('a','retired')`
    );

    const after = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            code: s.string().nullable(),
            label: s.string().nullable(),
            owner: s.string().nullable(),
            created: s.string().nullable(),
            note: s.string().nullable(),
            state: s.enum(["active"]).name("closure_state"),
          })
          .map("enum_after"),
      },
      driver: new PGliteDriver({ client: db, namespace }),
    });
    const enumTargets: string[] = [];
    await push(after, {
      resolve: (change: ResolveChange) => {
        if (change.type === "ambiguous") return change.rename();
        if (change.type === "enumValueRemoval") {
          enumTargets.push(`${change.tableName}.${change.columnName}`);
          return change.mapValues({ retired: "active" });
        }
        return change.reject();
      },
    });

    expect(enumTargets).toEqual(["enum_after.state"]);
    const rows = await db.query<{ state: string }>(
      `SELECT "state" FROM "${namespace}"."enum_after"`
    );
    expect(rows.rows).toEqual([{ state: "active" }]);
    await after.$disconnect();
  });
});

describe("the destructive prompt a user actually meets", () => {
  it("J2 names both decimal domains for a narrowing change", async () => {
    const driver = createInMemorySQLite3Driver();
    const wide = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 12, scale: 2 }).nullable(),
          })
          .map("j2"),
      },
      driver,
    });
    await push(wide, { force: true });
    const narrow = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("j2"),
      },
      driver,
    });
    const seen: string[] = [];
    await push(narrow, {
      resolve: (change: ResolveChange) => {
        seen.push(change.description ?? "");
        return change.type === "destructive"
          ? change.proceed()
          : change.reject();
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("precision 12, scale 2");
    expect(seen[0]).toContain("precision 10, scale 2");
    await narrow.$disconnect();
  });
});
