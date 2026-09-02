/** Live provider proof that invalid resolution results cause no schema or row effects. */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { ResolveCallback, ResolveChange } from "@migrations/types";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

const INVALID_RESOLUTION_RESULT = /invalid resolution result/i;

/**
 * Every PostgreSQL case below answers from the worker's ONE PGlite through this
 * suite's own private schema. The family carries no models of its own: each
 * case pushes the estate it is about to attack.
 */
const getFamily = usePGliteSchemaFamily({});

/**
 * The private schema outlives each case, where a fresh database used to hand
 * every case an empty one. Dropping the estate a case is about to build gives
 * it the same starting point: no ledger table, and no enum type left behind by
 * an earlier case for this one's introspection to find.
 */
async function dropLedgerEstate(enumName: string): Promise<void> {
  const { database, namespace } = getFamily();
  await database.exec(`DROP TABLE IF EXISTS "${namespace}"."ledger"`);
  await database.exec(`DROP TYPE IF EXISTS "${namespace}"."${enumName}"`);
}

function ledger(field: string, precision: number) {
  return {
    ledger: s.model({
      id: s.string().id(),
      [field]: s.decimal({ precision, scale: 2 }),
    }),
  };
}

async function storedLedgerAmount(
  driver: ReturnType<typeof createInMemorySQLite3Driver>
): Promise<number> {
  const stored = await driver._executeRaw<{ amount: number }>(
    `SELECT "amount" FROM "ledger" WHERE "id" = 'kept'`
  );
  return stored.rows[0]?.amount ?? Number.NaN;
}

describe("migration resolution result kind boundary", () => {
  it("refuses proceed instead of turning an ambiguity into add-and-drop", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: ledger("amount", 10), driver });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "ledger" ("id", "amount") VALUES ('kept', 12345)`
    );
    const after = createClient({ schema: ledger("total", 10), driver });

    await expect(push(after, { resolve: () => "proceed" })).rejects.toThrow(
      INVALID_RESOLUTION_RESULT
    );
    expect(await storedLedgerAmount(driver)).toBe(12_345);
    await after.$disconnect();
  });

  it.each([
    "rename",
    "addAndDrop",
  ] as const)("refuses %s instead of authorizing a destructive decimal narrowing", async (resolution) => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: ledger("amount", 12), driver });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "ledger" ("id", "amount") VALUES ('kept', 12345)`
    );
    const after = createClient({ schema: ledger("amount", 10), driver });

    await expect(push(after, { resolve: () => resolution })).rejects.toThrow(
      INVALID_RESOLUTION_RESULT
    );
    expect(await storedLedgerAmount(driver)).toBe(12_345);
    await after.$disconnect();
  });

  it("refuses an unknown hostile JavaScript result before a rename effect", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: ledger("amount", 10), driver });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "ledger" ("id", "amount") VALUES ('kept', 12345)`
    );
    const after = createClient({ schema: ledger("total", 10), driver });

    await expect(
      push(after, { resolve: (() => "renmae") as never })
    ).rejects.toThrow(INVALID_RESOLUTION_RESULT);
    expect(await storedLedgerAmount(driver)).toBe(12_345);
    await after.$disconnect();
  });

  it("does not let a mutated callback discriminant authorize add-and-drop", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: ledger("amount", 10), driver });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "ledger" ("id", "amount") VALUES ('kept', 12345)`
    );
    const after = createClient({ schema: ledger("total", 10), driver });

    await expect(
      push(after, {
        resolve: (change) => {
          Reflect.set(change, "type", "destructive");
          return "proceed";
        },
      })
    ).rejects.toThrow(INVALID_RESOLUTION_RESULT);
    expect(await storedLedgerAmount(driver)).toBe(12_345);
    await after.$disconnect();
  });
});

async function expectForgedEnumDecisionRejected(
  enumName: string,
  nullable: boolean,
  resolve: ResolveCallback
): Promise<{ failure: unknown; stored: Array<{ status: string }> }> {
  const { database: db, namespace } = getFamily();
  await dropLedgerEstate(enumName);
  const beforeStatus = nullable
    ? s.enum(["active", "retired"]).name(enumName).nullable()
    : s.enum(["active", "retired"]).name(enumName);
  const before = createClient({
    schema: {
      ledger: s.model({ id: s.string().id(), status: beforeStatus }),
    },
    driver: new PGliteDriver({ client: db, namespace }),
  });
  await push(before, { force: true });
  await db.exec(
    `INSERT INTO "${namespace}"."ledger" ("id", "status") VALUES ('kept', 'retired')`
  );
  const afterStatus = nullable
    ? s.enum(["active"]).name(enumName).nullable()
    : s.enum(["active"]).name(enumName);
  const after = createClient({
    schema: {
      ledger: s.model({ id: s.string().id(), status: afterStatus }),
    },
    driver: new PGliteDriver({ client: db, namespace }),
  });

  let failure: unknown;
  try {
    await push(after, { resolve });
  } catch (error) {
    failure = error;
  }
  try {
    const stored = await db.query<{ status: string }>(
      `SELECT "status" FROM "${namespace}"."ledger" WHERE "id" = 'kept'`
    );
    return { failure, stored: stored.rows };
  } finally {
    // The shared family owns the database; only this client is released here.
    await after.$disconnect();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

describe("enum resolution result kind boundary", () => {
  it("refuses a wrong-kind result before enum data or type effects", async () => {
    const { database: db, namespace } = getFamily();
    await dropLedgerEstate("resolution_status");
    const before = createClient({
      schema: {
        ledger: s.model({
          id: s.string().id(),
          status: s.enum(["active", "retired"]).name("resolution_status"),
        }),
      },
      driver: new PGliteDriver({ client: db, namespace }),
    });
    await push(before, { force: true });
    await db.exec(
      `INSERT INTO "${namespace}"."ledger" ("id", "status") VALUES ('kept', 'retired')`
    );
    const after = createClient({
      schema: {
        ledger: s.model({
          id: s.string().id(),
          status: s.enum(["active"]).name("resolution_status"),
        }),
      },
      driver: new PGliteDriver({ client: db, namespace }),
    });

    await expect(
      push(after, {
        resolve: (change: ResolveChange) =>
          change.type === "enumValueRemoval" ? "rename" : change.reject(),
      })
    ).rejects.toThrow(INVALID_RESOLUTION_RESULT);
    const stored = await db.query<{ status: string }>(
      `SELECT "status" FROM "${namespace}"."ledger" WHERE "id" = 'kept'`
    );
    expect(stored.rows).toEqual([{ status: "retired" }]);
    await after.$disconnect();
  });

  it("does not accept callback-forged enum mappings as authorization", async () => {
    const outcome = await expectForgedEnumDecisionRejected(
      "forged_mapping_status",
      false,
      (change) => {
        Reflect.set(change, "_mappings", { retired: "active" });
        return "enumMapped";
      }
    );
    expect(outcome.failure).toBeInstanceOf(Error);
    expect(errorMessage(outcome.failure)).toMatch(INVALID_RESOLUTION_RESULT);
    expect(outcome.stored).toEqual([{ status: "retired" }]);
  });

  it("does not accept a callback-forged use-null flag as authorization", async () => {
    const outcome = await expectForgedEnumDecisionRejected(
      "forged_null_status",
      false,
      (change) => {
        Reflect.set(change, "_useNullDefault", true);
        return "enumMapped";
      }
    );
    expect(outcome.failure).toBeInstanceOf(Error);
    expect(errorMessage(outcome.failure)).toMatch(INVALID_RESOLUTION_RESULT);
    expect(outcome.stored).toEqual([{ status: "retired" }]);
  });

  it("refuses a mixed enum decision instead of choosing one", async () => {
    const outcome = await expectForgedEnumDecisionRejected(
      "mixed_resolution_status",
      false,
      (change) => {
        if (change.type !== "enumValueRemoval") return change.reject();
        change.mapValues({ retired: "active" });
        return change.useNull();
      }
    );
    expect(outcome.failure).toBeInstanceOf(Error);
    expect(errorMessage(outcome.failure)).toMatch(INVALID_RESOLUTION_RESULT);
    expect(outcome.stored).toEqual([{ status: "retired" }]);
  });
});
