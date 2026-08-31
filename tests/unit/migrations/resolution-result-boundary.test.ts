/** Live provider proof that invalid resolution results cause no schema or row effects. */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import type { ResolveCallback, ResolveChange } from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INVALID_RESOLUTION_RESULT = /invalid resolution result/i;

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
  const db = new PGlite();
  const beforeStatus = nullable
    ? s.enum(["active", "retired"]).name(enumName).nullable()
    : s.enum(["active", "retired"]).name(enumName);
  const before = createClient({
    schema: {
      ledger: s.model({ id: s.string().id(), status: beforeStatus }),
    },
    driver: new PGliteDriver({ client: db }),
  });
  await push(before, { force: true });
  await db.exec(
    `INSERT INTO "ledger" ("id", "status") VALUES ('kept', 'retired')`
  );
  const afterStatus = nullable
    ? s.enum(["active"]).name(enumName).nullable()
    : s.enum(["active"]).name(enumName);
  const after = createClient({
    schema: {
      ledger: s.model({ id: s.string().id(), status: afterStatus }),
    },
    driver: new PGliteDriver({ client: db }),
  });

  let failure: unknown;
  try {
    await push(after, { resolve });
  } catch (error) {
    failure = error;
  }
  try {
    const stored = await db.query<{ status: string }>(
      `SELECT "status" FROM "ledger" WHERE "id" = 'kept'`
    );
    return { failure, stored: stored.rows };
  } finally {
    await after.$disconnect();
    await db.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

describe("enum resolution result kind boundary", () => {
  let db: PGlite;

  beforeAll(() => {
    db = new PGlite();
  });

  afterAll(async () => {
    await db.close();
  });

  it("refuses a wrong-kind result before enum data or type effects", async () => {
    const before = createClient({
      schema: {
        ledger: s.model({
          id: s.string().id(),
          status: s.enum(["active", "retired"]).name("resolution_status"),
        }),
      },
      driver: new PGliteDriver({ client: db }),
    });
    await push(before, { force: true });
    await db.exec(
      `INSERT INTO "ledger" ("id", "status") VALUES ('kept', 'retired')`
    );
    const after = createClient({
      schema: {
        ledger: s.model({
          id: s.string().id(),
          status: s.enum(["active"]).name("resolution_status"),
        }),
      },
      driver: new PGliteDriver({ client: db }),
    });

    await expect(
      push(after, {
        resolve: (change: ResolveChange) =>
          change.type === "enumValueRemoval" ? "rename" : change.reject(),
      })
    ).rejects.toThrow(INVALID_RESOLUTION_RESULT);
    const stored = await db.query<{ status: string }>(
      `SELECT "status" FROM "ledger" WHERE "id" = 'kept'`
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
