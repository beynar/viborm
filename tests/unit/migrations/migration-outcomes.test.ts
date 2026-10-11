/**
 * S3 (honest outcomes) and S4 (honest recovery) on SQLite, at realistic scale.
 *
 * S3: a migration error keeps the migration metadata it carries; a failed
 * transactional dispatch is a MigrationError naming its edge, dispatch,
 * statement and provider code; a rolled-back attempt leaves a durable `failed`
 * ledger event that `status().lastFailure` reports; a COMMIT whose reply is
 * lost reports what the marker proves.
 *
 * S4: `apply` starts again after a failed first attempt; a relative `down`
 * honours `expectRevision`; a rollback that would drop rows asks first.
 *
 * Stepwise outcomes (V11020, `resolve('rolled-back')`) need a stepwise
 * provider: they are in `migration-outcomes-pglite.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@client/client";
import { createClient as createSQLite3Client } from "@drivers/sqlite3";
import {
  isMigrationError,
  sanitizeErrorMetadata,
  VibORMErrorCode,
} from "@errors";
import { createMigrationClient, rejectAllResolver } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ROWS = 10_000;
const BATCH = 1000;
const COMMIT = /^\s*COMMIT\b/i;

const invoiceFields = {
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
const invoice = s.model(invoiceFields);

const lineItem = s.model({
  id: s.string().id(),
  invoiceId: s.string(),
  sku: s.string(),
  description: s.string(),
  kind: s.enum(["product", "service", "fee", "discount"]).default("product"),
  quantity: s.int(),
  unitCents: s.int(),
  taxRate: s.int().default(0),
  currency: s.string().default("EUR"),
  attributes: s.json().nullable(),
  note: s.string().nullable(),
  shippedAt: s.dateTime().nullable(),
  returned: s.boolean().default(false),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

type InvoiceClient = ReturnType<typeof invoiceClient>;

function invoiceClient() {
  return createClient({
    schema: { invoice },
    driver: createInMemorySQLite3Driver(),
  });
}

async function seedInvoices(client: {
  readonly invoice: InvoiceClient["invoice"];
}): Promise<void> {
  for (let start = 0; start < ROWS; start += BATCH) {
    await client.invoice.createMany({
      data: Array.from({ length: BATCH }, (_, offset) => {
        const i = start + offset;
        return {
          id: `inv-${i}`,
          number: `N-${i}`,
          customerEmail: `c${i}@example.test`,
          amountCents: 1000,
          balanceCents: 1000,
          metadata: { batch: i % 7 },
        };
      }),
    });
  }
}

async function totalBalance(client: InvoiceClient): Promise<number> {
  const result = await client.$driver._executeRaw<{ total: number }>(
    `SELECT sum("balanceCents") AS total FROM "invoice"`
  );
  return Number(result.rows[0]?.total);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/**
 * A better-sqlite3 handle whose first COMMIT after the armed statement runs
 * through `around`. The COMMIT may arrive through `exec` or through a prepared
 * statement, so both are covered.
 */
function aroundArmedCommit(
  db: Database.Database,
  armedBy: string,
  around: (commit: () => unknown) => unknown
) {
  let armed = false;
  let spent = false;
  const once = (commit: () => unknown) => {
    spent = true;
    return around(commit);
  };
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "exec" && property !== "prepare") {
        return value.bind(target);
      }
      return (text: string, ...rest: unknown[]) => {
        if (text.includes(armedBy)) armed = true;
        if (spent || !(armed && COMMIT.test(text))) {
          return value.call(target, text, ...rest);
        }
        if (property === "exec") return once(() => value.call(target, text));
        const result = value.call(target, text, ...rest);
        return new Proxy(result, {
          get(statement, member) {
            const method = Reflect.get(statement, member, statement);
            if (member !== "run" || typeof method !== "function") {
              return typeof method === "function"
                ? method.bind(statement)
                : method;
            }
            return (...args: unknown[]) =>
              once(() => method.apply(statement, args));
          },
        });
      };
    },
  });
}

/** A handle whose armed COMMIT commits, then throws: the reply is lost. */
function losingCommitReply(
  db: Database.Database,
  armedBy: string,
  code?: string
) {
  const state = { lost: 0 };
  const handle = aroundArmedCommit(db, armedBy, (commit) => {
    commit();
    state.lost += 1;
    throw Object.assign(new Error("connection lost after COMMIT"), { code });
  });
  return { handle, state };
}

describe("S3 honest outcomes", () => {
  it("keeps every migration metadata key through the error sanitizer", () => {
    expect(
      sanitizeErrorMetadata({
        lastConfirmedStep: "a".repeat(64),
        effectState: "may-have-committed",
        partial: true,
        stateId: "b".repeat(64),
        estateHash: "c".repeat(64),
        planHash: "d".repeat(64),
        fromState: "e".repeat(64),
        toState: "f".repeat(64),
        operationId: "manual:0",
        dispatchId: "0".repeat(64),
      })
    ).toEqual({
      dispatchId: "0".repeat(64),
      effectState: "may-have-committed",
      estateHash: "c".repeat(64),
      fromState: "e".repeat(64),
      lastConfirmedStep: "a".repeat(64),
      operationId: "manual:0",
      partial: true,
      planHash: "d".repeat(64),
      stateId: "b".repeat(64),
      toState: "f".repeat(64),
    });
    expect(
      sanitizeErrorMetadata({ effectState: "rolled-back", partial: "yes" })
    ).toEqual({});
  });

  it("a failed transactional dispatch is a MigrationError, rolled back and recorded as failed", async () => {
    const client = invoiceClient();
    // `fee_audit` is the operator's own table, outside the managed scope.
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
      tables: ["invoice"],
    });
    const init = (await migrations.generate({ name: "init" })).stateId;
    await migrations.apply();
    await seedInvoices(client);
    const lateFee = (
      await migrations.generate({
        name: "late-fee",
        manualMigration: {
          transitions: [
            {
              from: init,
              execution: "transactional",
              up: [
                sql.raw(
                  `UPDATE "invoice" SET "balanceCents" = "balanceCents" + 500`
                ),
                sql.raw(`INSERT INTO "fee_audit" ("id") VALUES ('late-fee')`),
              ],
              rollback: { kind: "irreversible", reason: "late fees stay" },
            },
          ],
        },
      })
    ).stateId;

    const error = await rejection(migrations.apply());
    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: {
        fromState: init,
        toState: lateFee,
        statementIndex: 1,
        providerCode: "SQLITE_ERROR",
        dispatchId: expect.any(String),
        operationId: expect.any(String),
      },
    });
    expect(await totalBalance(client)).toBe(ROWS * 1000);

    const failed = (await migrations.log()).filter(
      (event) => event.kind === "failed"
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      fromState: init,
      toState: lateFee,
      direction: "forward",
      effectState: "none",
      dispatchId: (error as { meta: { dispatchId: string } }).meta.dispatchId,
    });
    expect(failed[0]?.failure).toContain(VibORMErrorCode.MIGRATION_FAILED);

    const status = await migrations.status();
    expect(status.unfinished).toBe(false);
    expect(status.marker?.stateId).toBe(init);
    expect(status.lastFailure).toEqual(failed[0]);

    // The failed attempt is closed: once the cause is fixed, apply runs.
    await client.$driver._executeRaw(
      `CREATE TABLE "fee_audit" ("id" TEXT PRIMARY KEY)`
    );
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await totalBalance(client)).toBe(ROWS * 1500);
    expect((await migrations.status()).lastFailure).toEqual(failed[0]);
    await client.$disconnect();
  });

  it("a lost COMMIT reply reports the outcome the marker proves", async () => {
    const db = new Database(":memory:");
    const { handle, state } = losingCommitReply(db, `ADD COLUMN "reference"`);
    const storage = new MemoryEstateStorage();
    const v1 = createSQLite3Client({ client: handle, schema: { invoice } });
    const v2 = createSQLite3Client({
      client: handle,
      schema: {
        invoice: s.model({
          ...invoiceFields,
          reference: s.string().nullable(),
        }),
      },
    });
    await createMigrationClient(v1, { storage }).generate({ name: "init" });
    await createMigrationClient(v1, { storage }).apply();
    await seedInvoices(v1);
    const next = createMigrationClient(v2, { storage });
    const target = (await next.generate({ name: "add-reference" })).stateId;

    const outcome = await rejection(next.apply());
    expect(state.lost).toBe(1);
    // The COMMIT landed, marker included.
    const marker = db
      .prepare(
        `SELECT json_extract(payload, '$.stateId') AS stateId FROM "_viborm_migration_state"`
      )
      .get() as { stateId: string };
    expect(marker.stateId).toBe(target);
    // The COMMIT that landed left no transaction for the cleanup ROLLBACK, so
    // the driver refuses every statement after it: the marker cannot be
    // re-read and the outcome is the ambiguous commit V11020, never a plain
    // failure and never a `failed` record. (A provider whose ROLLBACK outside
    // a transaction is harmless re-reads it: migration-outcomes-pglite.)
    expect(outcome).toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      meta: { toState: target, effectState: "may-have-committed" },
    });
    expect(
      db
        .prepare(
          `SELECT count(*) AS n FROM "_viborm_migration_log" WHERE kind = 'failed'`
        )
        .get()
    ).toEqual({ n: 0 });
    await v1.$disconnect().catch(() => undefined);
    await v2.$disconnect().catch(() => undefined);
    db.close();
  });

  it("a COMMIT refused while a reader holds the database rolls back, re-reads the marker and records the failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viborm-s3-busy-"));
    const file = join(dir, "estate.db");
    // A short busy timeout: the COMMIT gives up while the reader holds on.
    const db = new Database(file, { timeout: 50 });
    const reader = new Database(file, { readonly: true, timeout: 50 });
    const state = { busy: 0 };
    const handle = aroundArmedCommit(db, `ADD COLUMN "reference"`, (commit) => {
      // Another process reads the table as the migration commits: in
      // rollback-journal mode its shared lock keeps the COMMIT from writing.
      const rows = reader.prepare(`SELECT "id" FROM "invoice"`).iterate();
      rows.next();
      try {
        return commit();
      } catch (error) {
        state.busy += 1;
        throw error;
      } finally {
        rows.return?.();
      }
    });
    const storage = new MemoryEstateStorage();
    const v1 = createSQLite3Client({ client: handle, schema: { invoice } });
    const v2 = createSQLite3Client({
      client: handle,
      schema: {
        invoice: s.model({
          ...invoiceFields,
          reference: s.string().nullable(),
        }),
      },
    });
    const root = (
      await createMigrationClient(v1, { storage }).generate({ name: "init" })
    ).stateId;
    await createMigrationClient(v1, { storage }).apply();
    await seedInvoices(v1);
    const next = createMigrationClient(v2, { storage });
    const target = (await next.generate({ name: "add-reference" })).stateId;

    const outcome = await rejection(next.apply());
    expect(state.busy).toBe(1);
    // The provider's refusal of the COMMIT itself, a retryable contention.
    expect(outcome).toMatchObject({
      code: VibORMErrorCode.TRANSACTION_CONTENTION,
      meta: { providerCode: "SQLITE_BUSY" },
    });
    // SQLite kept the transaction open; it rolled back, and the marker the
    // command re-read proves the transition did not land.
    const status = await next.status();
    expect(status.marker?.stateId).toBe(root);
    expect(status.unfinished).toBe(false);
    expect(status.lastFailure).toMatchObject({
      kind: "failed",
      fromState: root,
      toState: target,
      effectState: "none",
    });
    // Once the reader is gone, the same command applies.
    await expect(next.apply()).resolves.toMatchObject({
      outcome: "applied",
      path: [target],
    });
    await v1.$disconnect().catch(() => undefined);
    await v2.$disconnect().catch(() => undefined);
    reader.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("S3 a COMMIT lost with its connection", () => {
  it("is the ambiguous commit V11020, sends nothing more, and a retry finds it applied", async () => {
    const db = new Database(":memory:");
    // A provider code the driver mapping reads as a lost connection.
    const { handle, state } = losingCommitReply(
      db,
      `ADD COLUMN "reference"`,
      "ECONNRESET"
    );
    const storage = new MemoryEstateStorage();
    const v1 = createSQLite3Client({ client: handle, schema: { invoice } });
    const v2Schema = {
      invoice: s.model({ ...invoiceFields, reference: s.string().nullable() }),
    };
    const v2 = createSQLite3Client({ client: handle, schema: v2Schema });
    const root = (
      await createMigrationClient(v1, { storage }).generate({ name: "init" })
    ).stateId;
    await createMigrationClient(v1, { storage }).apply();
    await seedInvoices(v1);
    const next = createMigrationClient(v2, { storage });
    const target = (await next.generate({ name: "add-reference" })).stateId;

    const outcome = await rejection(next.apply());
    expect(state.lost).toBe(1);
    // The pinned session refused the marker re-read on the lost connection.
    expect(outcome).toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      cause: expect.any(Error),
      meta: {
        fromState: root,
        toState: target,
        effectState: "may-have-committed",
      },
    });
    // Nothing was recorded on the lost connection: no `failed` event.
    expect(
      db
        .prepare(
          `SELECT count(*) AS n FROM "_viborm_migration_log" WHERE kind = 'failed'`
        )
        .get()
    ).toEqual({ n: 0 });
    // The COMMIT landed: a fresh client re-reads the marker and has nothing to do.
    const fresh = createSQLite3Client({ client: db, schema: v2Schema });
    await expect(
      createMigrationClient(fresh, { storage }).apply()
    ).resolves.toMatchObject({ outcome: "noop" });
    await v1.$disconnect().catch(() => undefined);
    await v2.$disconnect().catch(() => undefined);
    db.close();
  });
});

describe("S4 honest recovery", () => {
  it("apply starts again after a failed first attempt, with no marker", async () => {
    const client = createClient({
      schema: { account: s.model({ id: s.string().id(), balance: s.int() }) },
      driver: createInMemorySQLite3Driver(),
    });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
      tables: ["account"],
    });
    const first = await migrations.generate({
      name: "first",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "transactional",
            up: [
              sql.raw(
                `CREATE TABLE "account" ("id" TEXT NOT NULL, "balance" INTEGER NOT NULL, PRIMARY KEY ("id"))`
              ),
              sql.raw(
                `INSERT INTO "account" ("id", "balance") SELECT "id", 0 FROM "seed_source"`
              ),
            ],
            rollback: { kind: "irreversible", reason: "first state" },
          },
        ],
      },
    });
    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
    });
    expect(await migrations.status()).toMatchObject({
      control: "present",
      marker: null,
      unfinished: false,
      lastFailure: { kind: "failed", fromState: null, toState: first.stateId },
    });

    await client.$driver._executeRaw(`CREATE TABLE "seed_source" ("id" TEXT)`);
    await client.$driver._executeRaw(
      `INSERT INTO "seed_source" ("id") SELECT 'a' || value FROM json_each(json_array(${Array.from({ length: 100 }, (_, i) => i).join(",")}))`
    );
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    const rows = await client.$driver._executeRaw<{ n: number }>(
      `SELECT count(*) AS n FROM "account"`
    );
    expect(rows.rows[0]?.n).toBe(100);
    await client.$disconnect();
  });

  it("a retried relative down with a stale expectRevision is refused", async () => {
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    const tag = s.model({ id: s.string().id(), label: s.string() });
    const reminder = s.model({
      id: s.string().id(),
      invoiceId: s.string(),
      sendAt: s.dateTime(),
    });
    const clients = [
      createClient({ schema: { invoice }, driver }),
      createClient({ schema: { invoice, tag }, driver }),
      createClient({ schema: { invoice, tag, reminder }, driver }),
    ] as const;
    for (const [index, client] of clients.entries()) {
      const migrations = createMigrationClient(client, { storage });
      await migrations.generate({ name: `s${index + 1}` });
      await migrations.apply();
    }
    await seedInvoices(clients[2]);
    const migrations = createMigrationClient(clients[2], { storage });
    const revision = (await migrations.status()).marker?.revision ?? 0;

    await expect(
      migrations.down({ steps: 1, expectRevision: revision })
    ).resolves.toMatchObject({ preview: false });
    await expect(
      migrations.down({ steps: 1, expectRevision: revision })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    const status = await migrations.status();
    expect(status.marker?.revision).toBe(revision + 1);
    expect(status.marker?.path).toHaveLength(2);
    await expect(
      migrations.down({ steps: 1, expectRevision: 0 })
    ).rejects.toMatchObject({ code: VibORMErrorCode.INVALID_INPUT });
    await expect(
      migrations.down({ steps: 1, resolve: "proceed" as never })
    ).rejects.toThrow("down resolve must be a function");
    for (const client of clients) await client.$disconnect();
  });

  it("a rollback that would drop populated tables asks first; an empty one does not", async () => {
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    const v1 = createClient({ schema: { invoice }, driver });
    const v2 = createClient({ schema: { invoice, lineItem }, driver });
    await createMigrationClient(v1, { storage }).generate({ name: "invoices" });
    await createMigrationClient(v1, { storage }).apply();
    const migrations = createMigrationClient(v2, { storage });
    await migrations.generate({ name: "line-items" });
    await migrations.apply();
    for (let start = 0; start < ROWS; start += BATCH) {
      await v2.lineItem.createMany({
        data: Array.from({ length: BATCH }, (_, offset) => {
          const i = start + offset;
          return {
            id: `li-${i}`,
            invoiceId: `inv-${i % 97}`,
            sku: `SKU-${i % 311}`,
            description: "consulting",
            quantity: 1 + (i % 5),
            unitCents: 1250,
            attributes: { lot: i % 13 },
          };
        }),
      });
    }
    const back = { to: { name: "invoices" } } as const;
    const lineItems = async () =>
      Number(
        (
          await driver._executeRaw<{ n: number }>(
            `SELECT count(*) AS n FROM "lineItem"`
          )
        ).rows[0]?.n
      );

    const unasked = await rejection(migrations.down(back));
    expect(unasked).toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
    });
    expect(String((unasked as Error).message)).toContain(`"lineItem"`);
    await expect(
      migrations.down({ ...back, resolve: rejectAllResolver })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
    });
    expect(await lineItems()).toBe(ROWS);

    const asked: string[] = [];
    await expect(
      migrations.down({
        ...back,
        resolve: (change) => {
          asked.push(change.type);
          return change.type === "destructive" ? change.proceed() : undefined;
        },
      })
    ).resolves.toMatchObject({ preview: false });
    expect(asked).toEqual(["destructive"]);
    expect((await migrations.status()).pending).toHaveLength(1);

    // Re-applied, the table is empty: the same rollback needs no answer.
    await migrations.apply();
    await expect(migrations.down(back)).resolves.toMatchObject({
      preview: false,
    });
    await v1.$disconnect();
    await v2.$disconnect();
  });

  it("a multi-edge rollback over a table a later state dropped needs no answer", async () => {
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    const clients = [
      createClient({ schema: { invoice }, driver }),
      createClient({ schema: { invoice, lineItem }, driver }),
      createClient({ schema: { invoice }, driver }),
    ] as const;
    for (const [index, client] of clients.entries()) {
      const migrations = createMigrationClient(client, { storage });
      await migrations.generate({
        name: `s${index + 1}`,
        resolve: (change) =>
          change.type === "destructive" ? change.proceed() : undefined,
      });
      await migrations.apply();
    }
    await seedInvoices(clients[2]);
    const migrations = createMigrationClient(clients[2], { storage });

    // s3 -> s2 recreates "lineItem" empty, and s2 -> s1 drops it again: the
    // live database has no such table to read, and no row is at risk.
    await expect(
      migrations.down({ to: { name: "s1" } })
    ).resolves.toMatchObject({ preview: false });
    expect((await migrations.status()).pending).toHaveLength(2);
    expect(await totalBalance(clients[0])).toBe(ROWS * 1000);
    for (const client of clients) await client.$disconnect();
  });
});
