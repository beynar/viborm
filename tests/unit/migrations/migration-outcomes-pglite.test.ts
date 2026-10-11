/**
 * S3 and S4 on the PostgreSQL path (PGlite).
 *
 * S3, what `apply` reports when the end of a committed transition goes wrong:
 * - the COMMIT's reply is lost: the marker it compare-and-swapped is re-read,
 *   and the outcome is the one it proves;
 * - the marker cannot be re-read either: the ambiguous commit V11020;
 * - releasing the session lock fails after the commit: `applied`, with a
 *   warning.
 * And a stepwise V11020 names the edge and the dispatch it lost.
 *
 * S4: `resolve('rolled-back')` refuses an attempt whose opaque step committed
 * (no double credit), and `apply` starts again after a first attempt closed as
 * rolled back.
 */

import { createClient } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { isMigrationError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { describe, expect, it } from "vitest";

const ROWS = 2000;
const COMMIT = /^\s*COMMIT\b/i;

const fields = {
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  currency: s.string().default("EUR"),
  amountCents: s.int(),
  taxCents: s.int().default(0),
  balanceCents: s.int(),
  notes: s.string().nullable(),
  metadata: s.json().nullable(),
  dueAt: s.dateTime().nullable(),
  paidAt: s.dateTime().nullable(),
  reminderCount: s.int().default(0),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};
const invoice = s.model(fields);

const populated = {
  kind: "trusted-read",
  query: sql.raw(`SELECT EXISTS (SELECT 1 FROM "invoice") AS ok`),
  equals: true,
} as const;

type Fault =
  | "lose-commit-reply"
  | "lose-connection-at-commit"
  | "fail-unlock"
  | "none";

/**
 * A PGlite whose `query`/`exec` fail as `fault` says once `armedBy` ran.
 * Every other statement reaches the database.
 */
function faulty(database: PGlite, fault: Fault, armedBy: string) {
  const state = { armed: false, dead: false, fired: 0 };
  const proxy = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "query" && property !== "exec") {
        return value.bind(target);
      }
      return async (text: string, ...rest: unknown[]) => {
        if (state.dead) throw new Error("connection is gone");
        if (text.includes(armedBy)) state.armed = true;
        if (
          state.armed &&
          fault === "fail-unlock" &&
          text.includes("pg_advisory_unlock")
        ) {
          state.armed = false;
          state.fired += 1;
          throw new Error("unlock reply lost");
        }
        const result = await value.call(target, text, ...rest);
        if (
          state.armed &&
          (fault === "lose-commit-reply" ||
            fault === "lose-connection-at-commit") &&
          COMMIT.test(text)
        ) {
          state.armed = false;
          state.fired += 1;
          state.dead = fault === "lose-connection-at-commit";
          throw new Error("COMMIT reply lost");
        }
        return result;
      };
    },
  });
  return { proxy, state };
}

/** An applied `init` over `ROWS` invoices on a faulty PGlite. */
async function invoices(fault: Fault, armedBy: string) {
  const database = openTestPGlite();
  const { proxy, state } = faulty(database, fault, armedBy);
  const storage = new MemoryEstateStorage();
  const v1 = createClient({ client: proxy, schema: { invoice } });
  const first = createMigrationClient(v1, { storage, tables: ["invoice"] });
  const init = (await first.generate({ name: "init" })).stateId;
  await first.apply();
  for (let start = 0; start < ROWS; start += 500) {
    await v1.invoice.createMany({
      data: Array.from({ length: 500 }, (_, offset) => ({
        id: `inv-${start + offset}`,
        number: `N-${start + offset}`,
        customerEmail: `c${start + offset}@example.test`,
        amountCents: 1000,
        balanceCents: 1000,
      })),
    });
  }
  const close = async () => {
    await v1.$disconnect();
    await closeTestPGlite(database);
  };
  return { database, proxy, state, storage, v1, first, init, close };
}

async function settle<T>(promise: Promise<T>): Promise<T | unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

/** A transactional `add-reference` transition through `fault`. */
async function addReference(fault: Fault) {
  const run = await invoices(fault, `ADD COLUMN "reference"`);
  const v2 = createClient({
    client: run.proxy,
    schema: {
      invoice: s.model({ ...fields, reference: s.string().nullable() }),
    },
  });
  const migrations = createMigrationClient(v2, {
    storage: run.storage,
    tables: ["invoice"],
  });
  const target = (await migrations.generate({ name: "add-reference" })).stateId;
  const outcome = await settle(migrations.apply());
  run.state.dead = false;
  const status = await migrations.status();
  await v2.$disconnect();
  await run.close();
  return { outcome, status, target, fired: run.state.fired };
}

/** A stepwise late fee whose second statement fails on a missing table. */
async function stepwiseLateFee(run: Awaited<ReturnType<typeof invoices>>) {
  return (
    await run.first.generate({
      name: "late-fee",
      manualMigration: {
        transitions: [
          {
            from: run.init,
            execution: "stepwise",
            originChecks: [populated],
            up: [
              sql.raw(
                `UPDATE "invoice" SET "balanceCents" = "balanceCents" + 500`
              ),
              sql.raw(`INSERT INTO "fee_audit" ("id") VALUES ('late-fee')`),
            ],
            rollback: { kind: "irreversible", reason: "late fees stay" },
          },
        ],
        destinationChecks: [populated],
      },
    })
  ).stateId;
}

async function totalBalance(database: PGlite): Promise<number> {
  const { rows } = await database.query<{ total: string }>(
    `SELECT sum("balanceCents") AS total FROM "invoice"`
  );
  return Number(rows[0]?.total);
}

describe("S3 on PostgreSQL: the end of a committed transition", () => {
  it("a lost COMMIT reply reports `applied` once the re-read marker proves it", async () => {
    const { outcome, status, target, fired } =
      await addReference("lose-commit-reply");
    expect(fired).toBe(1);
    expect(outcome).toMatchObject({ outcome: "applied", path: [target] });
    expect(outcome).not.toHaveProperty("warnings");
    expect(status.marker?.stateId).toBe(target);
    expect(status.lastFailure).toBeUndefined();
  });

  it("a COMMIT lost with its connection is the ambiguous commit V11020", async () => {
    const { outcome, status, target, fired } = await addReference(
      "lose-connection-at-commit"
    );
    expect(fired).toBe(1);
    expect(isMigrationError(outcome)).toBe(true);
    expect(outcome).toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      meta: {
        toState: target,
        effectState: "may-have-committed",
        commitCertainty: "may-have-committed",
      },
    });
    // It had committed: the marker, read once the connection is back, says so.
    expect(status.marker?.stateId).toBe(target);
    expect(status.lastFailure).toBeUndefined();
  });

  it("an unlock failure after a stepwise commit returns `applied` with a warning", async () => {
    const run = await invoices("fail-unlock", `"reminderCount" + 1`);
    const reminded = (
      await run.first.generate({
        name: "remind",
        manualMigration: {
          transitions: [
            {
              from: run.init,
              execution: "stepwise",
              originChecks: [populated],
              up: [
                sql.raw(
                  `UPDATE "invoice" SET "reminderCount" = "reminderCount" + 1`
                ),
              ],
              rollback: { kind: "irreversible", reason: "reminders stay" },
            },
          ],
          destinationChecks: [populated],
        },
      })
    ).stateId;
    const outcome = await settle(run.first.apply());
    expect(run.state.fired).toBe(1);
    expect(outcome).toMatchObject({
      outcome: "applied",
      path: [reminded],
      warnings: [
        expect.stringContaining(VibORMErrorCode.MIGRATION_LOCK_FAILED),
      ],
    });
    expect((await run.first.status()).marker?.stateId).toBe(reminded);
    await run.close();
  });

  it("a stepwise V11020 names the edge and the dispatch it lost", async () => {
    const run = await invoices("none", "");
    const lateFee = await stepwiseLateFee(run);
    const error = await settle(run.first.apply());
    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      meta: {
        effectState: "may-have-committed",
        partial: true,
        fromState: run.init,
        toState: lateFee,
        statementIndex: 1,
        operationId: expect.any(String),
        dispatchId: expect.any(String),
        lastConfirmedStep: expect.any(String),
      },
    });
    await run.close();
  });
});

describe("S4 on PostgreSQL: honest recovery", () => {
  it("resolve('rolled-back') refuses an attempt whose opaque step committed", async () => {
    const run = await invoices("none", "");
    const lateFee = await stepwiseLateFee(run);
    await expect(run.first.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    const credited = await totalBalance(run.database);
    expect(credited).toBe(ROWS * 1500);

    await expect(
      run.first.resolve({ outcome: "rolled-back" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
      meta: { effectState: "committed", toState: lateFee, partial: true },
    });
    await run.database.exec(`CREATE TABLE "fee_audit" ("id" TEXT PRIMARY KEY)`);
    await expect(run.first.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
    });
    expect(await totalBalance(run.database)).toBe(credited);
    expect((await run.first.status()).unfinished).toBe(true);
    await run.close();
  });

  it("apply starts again after a first attempt closed by resolve('rolled-back')", async () => {
    const database = openTestPGlite();
    const client = createClient({
      client: database,
      schema: { account: s.model({ id: s.string().id(), balance: s.int() }) },
    });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
      tables: ["account"],
    });
    const exists = (table: string) =>
      ({
        kind: "trusted-read",
        query: sql.raw(`SELECT to_regclass('"${table}"') IS NOT NULL AS ok`),
        equals: true,
      }) as const;
    await migrations.generate({
      name: "first",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "stepwise",
            originChecks: [exists("seed_source")],
            up: [
              sql.raw(
                `CREATE TABLE "account" ("id" TEXT NOT NULL, "balance" INTEGER NOT NULL, CONSTRAINT "account_pkey" PRIMARY KEY ("id"))`
              ),
              sql.raw(
                `INSERT INTO "account" ("id", "balance") SELECT "id", 0 FROM "seed_source"`
              ),
            ],
            rollback: {
              kind: "manual",
              execution: "stepwise",
              sql: [sql.raw(`DROP TABLE IF EXISTS "account"`)],
            },
          },
        ],
        destinationChecks: [exists("account")],
      },
    });
    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
    });
    await database.exec(
      `CREATE TABLE "seed_source" ("id" TEXT); INSERT INTO "seed_source" SELECT 'a' || g FROM generate_series(1, ${ROWS}) AS g`
    );
    await expect(
      migrations.resolve({ outcome: "rolled-back" })
    ).resolves.toEqual({ outcome: "rolled-back" });

    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    const { rows } = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "account"`
    );
    expect(rows[0]?.n).toBe(ROWS);
    await client.$disconnect();
    await closeTestPGlite(database);
  });
});
