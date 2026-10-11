/**
 * S10: a SQLite table recreation of a referenced parent runs only when the
 * foreign-key lift is PROVEN.
 *
 * `DROP TABLE` on a parent fires every child's referential action unless
 * `PRAGMA foreign_keys=OFF` really took effect. Each fault below is injected
 * into the stock better-sqlite3 driver, over one shared in-memory database:
 *
 *   - pragma-ignored: the OFF is a no-op (a Durable Object with a pending
 *     write), so `PRAGMA foreign_keys` still reads 1;
 *   - pragma-lies: the same, and every read-back answers 0, so only the
 *     child census around each `DROP TABLE` is left to see the damage;
 *   - transactionless: `supportsTransactions = false`, so nothing can be
 *     rolled back and nothing can be proven.
 *
 * Each is refused with a MigrationError and leaves every child, and the
 * parent's old shape, exactly as they were. 10,000 parents, each with one
 * CASCADE child and one SET NULL child. A transition that writes those
 * children itself, applied together with the rebuild, is not mistaken for one.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { isMigrationError, VibORMErrorCode } from "@errors";
import { applyV1 as apply } from "@migrations/apply-v1";
import {
  liftForeignKeyPragmas,
  withForeignKeysLifted,
} from "@migrations/foreign-keys";
import { generateV1 as generate } from "@migrations/generate-v1";
import { downV1 as down } from "@migrations/operators";
import { s } from "@schema";
import { sql } from "@sql";
import type { QueryResult } from "@src/drivers/types";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";
import { MemoryStorage } from "./_estate";

const ITEMS = 10_000;
const PRAGMA_OFF = /^\s*PRAGMA\s+foreign_keys\s*=\s*OFF\s*;?\s*$/i;
const PRAGMA_ON = /^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;?\s*$/i;
const PRAGMA_READ = /^\s*PRAGMA\s+foreign_keys\s*;?\s*$/i;
const OPENS = /^BEGIN\b/i;
const CLOSES = /^(COMMIT|ROLLBACK)\b/i;

type Fault = "none" | "pragma-ignored" | "pragma-lies" | "restore-dropped";
type SQLite3Database = InstanceType<typeof Database>;

/** The stock driver with one fault injected at its raw-statement seam. */
class FaultySqliteDriver extends SQLite3Driver {
  fault: Fault = "none";
  readonly seen: string[] = [];

  private intercept<T>(sql: string): QueryResult<T> | undefined {
    this.seen.push(sql.trim());
    if (this.fault === "none") return;
    if (this.fault === "restore-dropped") {
      return PRAGMA_ON.test(sql) ? { rows: [], rowCount: 0 } : undefined;
    }
    if (PRAGMA_OFF.test(sql)) return { rows: [], rowCount: 0 };
    if (this.fault === "pragma-lies" && PRAGMA_READ.test(sql)) {
      return { rows: [{ foreign_keys: 0 } as T], rowCount: 1 };
    }
    return;
  }

  protected override execute<T>(
    client: SQLite3Database,
    sql: string,
    params: unknown[],
    context?: Parameters<SQLite3Driver["execute"]>[3]
  ): Promise<QueryResult<T>> {
    const hit = this.intercept<T>(sql);
    return hit
      ? Promise.resolve(hit)
      : super.execute(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: SQLite3Database,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const hit = this.intercept<T>(sql);
    return hit ? Promise.resolve(hit) : super.executeRaw(client, sql, params);
  }
}

class TransactionlessSqliteDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
}

/** Records the hook's place in the statement stream. */
class SyncingSqliteDriver extends FaultySqliteDriver {
  protected override async beforeForeignKeysOff(): Promise<void> {
    this.seen.push("<hook>");
  }
}

function schema(version: "v1" | "v2") {
  const item = s.model({
    id: s.string().id(),
    sku: s.string().unique(),
    label: version === "v2" ? s.string().nullable() : s.string(),
    status: s.enum(["draft", "active", "archived"]),
    price: s.int(),
    stock: s.int().default(0),
    rating: s.int().nullable(),
    active: s.boolean().default(true),
    attributes: s.json().nullable(),
    weight: s.number().nullable(),
    note: s.string().nullable(),
    code: s.string().nullable(),
    createdAt: s.dateTime().now(),
    tags: s.toMany(() => tag),
    notes: s.toMany(() => note),
  });
  const tag = s.model({
    id: s.string().id(),
    name: s.string(),
    itemId: s.string(),
    item: s
      .toOne(() => item)
      .fields("itemId")
      .references("id")
      .onDelete("cascade"),
  });
  const note = s.model({
    id: s.string().id(),
    body: s.string(),
    itemId: s.string().nullable(),
    item: s
      .toOne(() => item)
      .fields("itemId")
      .references("id")
      .onDelete("setNull"),
  });
  return { item, tag, note };
}

function sharedDatabase(): SQLite3Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

const clientAt = (version: "v1" | "v2", driver: SQLite3Driver) =>
  createClient({ schema: schema(version), driver });

async function seed(client: ReturnType<typeof clientAt>) {
  for (let start = 0; start < ITEMS; start += 1000) {
    const ids = Array.from({ length: 1000 }, (_, k) => `item-${start + k}`);
    await client.item.createMany({
      data: ids.map((id, k) => ({
        id,
        sku: `SKU-${start + k}`,
        label: `Item ${start + k}`,
        status: "active" as const,
        price: 100 + k,
        attributes: { color: "red", size: k % 5 },
      })),
    });
    await client.tag.createMany({
      data: ids.map((id) => ({ id: `tag-${id}`, name: "sale", itemId: id })),
    });
    await client.note.createMany({
      data: ids.map((id) => ({ id: `note-${id}`, body: "ok", itemId: id })),
    });
  }
}

/**
 * v1 applied and seeded through the honest driver; then, unapplied, the
 * optional `data` transition and v2.
 */
async function prepare(db: SQLite3Database, data?: readonly string[]) {
  const storage = new MemoryStorage();
  const honest = new SQLite3Driver({ client: db });
  const v1 = clientAt("v1", honest);
  const { stateId } = await generate(v1 as never, storage, { name: "v1" });
  await apply(v1 as never, storage);
  await seed(v1);
  if (data) {
    await generate(v1 as never, storage, {
      name: "data",
      manualMigration: {
        transitions: [
          {
            from: stateId,
            execution: "transactional",
            up: data.map((statement) => sql.raw(statement)),
            rollback: { kind: "irreversible", reason: "test data" },
          },
        ],
      },
    });
  }
  const v2 = clientAt("v2", honest);
  const generated = await generate(v2 as never, storage, { name: "v2" });
  if (!generated.sql.includes('"__new_item"')) {
    throw new Error("v2 does not recreate the parent table item");
  }
  return storage;
}

function census(db: SQLite3Database) {
  const one = (sql: string) =>
    Object.values(db.prepare(sql).get() as object)[0];
  return {
    items: one(`SELECT count(*) FROM "item"`),
    tags: one(`SELECT count(*) FROM "tag"`),
    linkedNotes: one(`SELECT count(*) FROM "note" WHERE "itemId" IS NOT NULL`),
    labelNullable:
      one(
        `SELECT "notnull" FROM pragma_table_info('item') WHERE name = 'label'`
      ) === 0,
    enforced: db.pragma("foreign_keys", { simple: true }),
  };
}

const UNTOUCHED = {
  items: ITEMS,
  tags: ITEMS,
  linkedNotes: ITEMS,
  labelNullable: false,
  enforced: 1,
};

const caught = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error
  );

describe("a SQLite parent rebuild runs only on a proven foreign-key lift", () => {
  it("applies on the honest driver and keeps every child", async () => {
    const db = sharedDatabase();
    const storage = await prepare(db);
    const driver = new SyncingSqliteDriver({ client: db });

    await apply(
      createClient({ schema: schema("v2"), driver }) as never,
      storage
    );

    expect(census(db)).toEqual({ ...UNTOUCHED, labelNullable: true });
    // The driver's hook runs immediately before the disable it prepares, with
    // no transaction open.
    const hook = driver.seen.indexOf("<hook>");
    expect(hook).toBeGreaterThanOrEqual(0);
    expect(driver.seen[hook + 1]).toMatch(PRAGMA_OFF);
    const before = driver.seen.slice(0, hook);
    expect(before.filter((sql) => OPENS.test(sql))).toHaveLength(
      before.filter((sql) => CLOSES.test(sql)).length
    );
  }, 60_000);

  it("applies a rebuild together with a transition that writes its children", async () => {
    const db = sharedDatabase();
    // 'item-1%' and 'item-2%' each match 1,111 of item-0 .. item-9999.
    const storage = await prepare(db, [
      `DELETE FROM "tag" WHERE "itemId" LIKE 'item-1%'`,
      `UPDATE "note" SET "itemId" = NULL WHERE "itemId" LIKE 'item-2%'`,
    ]);
    const driver = new FaultySqliteDriver({ client: db });

    await apply(
      createClient({ schema: schema("v2"), driver }) as never,
      storage
    );

    expect(census(db)).toEqual({
      ...UNTOUCHED,
      tags: ITEMS - 1111,
      linkedNotes: ITEMS - 1111,
      labelNullable: true,
    });
    // One transaction: nothing commits between the data write and the drop.
    const write = driver.seen.findIndex((sql) => sql.startsWith("DELETE"));
    const drop = driver.seen.indexOf('DROP TABLE "item"');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(write);
    expect(driver.seen.slice(write, drop).some((sql) => CLOSES.test(sql))).toBe(
      false
    );
  }, 60_000);

  it("refuses before any effect when PRAGMA foreign_keys=OFF is ignored", async () => {
    const db = sharedDatabase();
    const storage = await prepare(db);
    const driver = new FaultySqliteDriver({ client: db });
    driver.fault = "pragma-ignored";

    const error = await caught(
      apply(createClient({ schema: schema("v2"), driver }) as never, storage)
    );

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining("PRAGMA foreign_keys"),
    });
    expect(census(db)).toEqual(UNTOUCHED);
    // Refused before the transaction: no statement of the change ran.
    expect(driver.seen.some((sql) => sql.includes("__new_item"))).toBe(false);
  }, 60_000);

  it("rolls back when every read-back lies, because the children changed", async () => {
    const db = sharedDatabase();
    const storage = await prepare(db);
    const driver = new FaultySqliteDriver({ client: db });
    driver.fault = "pragma-lies";

    const error = await caught(
      apply(createClient({ schema: schema("v2"), driver }) as never, storage)
    );

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining('"tag"'),
    });
    expect(census(db)).toEqual(UNTOUCHED);
  }, 60_000);

  it("refuses a rebuild on a driver with no transaction to prove it in", async () => {
    const db = sharedDatabase();
    const storage = await prepare(db);
    const driver = new TransactionlessSqliteDriver({ client: db });

    const error = await caught(
      apply(createClient({ schema: schema("v2"), driver }) as never, storage)
    );

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining("without a transaction"),
    });
    expect(census(db)).toEqual(UNTOUCHED);
  }, 60_000);

  it("refuses a rollback the same way", async () => {
    const db = sharedDatabase();
    const storage = await prepare(db);
    const v2 = createClient({
      schema: schema("v2"),
      driver: new SQLite3Driver({ client: db }),
    });
    await apply(v2 as never, storage);
    const driver = new FaultySqliteDriver({ client: db });
    driver.fault = "pragma-lies";

    const error = await caught(
      down(createClient({ schema: schema("v2"), driver }) as never, storage, {
        steps: 1,
        resolve: (change) =>
          change.type === "destructive" ? change.proceed() : undefined,
      })
    );

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining('"tag" rows 10000 -> 0'),
    });
    expect(census(db)).toEqual({ ...UNTOUCHED, labelNullable: true });
  }, 60_000);

  it("refuses a push whose lift is not proven", async () => {
    const db = sharedDatabase();
    const v1 = clientAt("v1", new SQLite3Driver({ client: db }));
    await syncLiveSchema(v1 as never);
    await seed(v1);
    const driver = new FaultySqliteDriver({ client: db });
    driver.fault = "pragma-lies";

    const error = await caught(syncLiveSchema(clientAt("v2", driver) as never));

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining('"tag" rows 10000 -> 0'),
    });
    expect(census(db)).toEqual(UNTOUCHED);
  }, 60_000);

  it("reports a change that committed when enforcement does not come back", async () => {
    const db = sharedDatabase();
    db.exec('CREATE TABLE "scratch" ("id" TEXT PRIMARY KEY)');
    const driver = new FaultySqliteDriver({ client: db });
    // Enforcement really goes off; the re-enable is the one that is dropped.
    driver.fault = "restore-dropped";
    const { bracket } = liftForeignKeyPragmas(driver, [
      "PRAGMA foreign_keys=OFF",
      'DROP TABLE "scratch"',
      "PRAGMA foreign_keys=ON",
    ]);

    const error = await caught(
      withForeignKeysLifted(driver, bracket, (inside) =>
        driver.withTransaction((transaction) =>
          inside(transaction, async (producer) => {
            await producer._executeRaw('DROP TABLE "scratch"');
          })
        )
      )
    );

    expect(isMigrationError(error)).toBe(true);
    expect(error).toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining("committed"),
    });
    expect(
      db
        .prepare(
          `SELECT count(*) AS "n" FROM sqlite_master WHERE name = 'scratch'`
        )
        .get()
    ).toEqual({ n: 0 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  });
  it("counts around a drop in any spelling, and refuses one it cannot read", async () => {
    const db = sharedDatabase();
    db.exec(`
      CREATE TABLE "p" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "c" ("p" TEXT REFERENCES "p" ("id") ON DELETE CASCADE);
      INSERT INTO "p" VALUES ('a');
      INSERT INTO "c" VALUES ('a');
    `);
    const driver = new FaultySqliteDriver({ client: db });
    driver.fault = "pragma-lies";
    const { bracket } = liftForeignKeyPragmas(driver, [
      "PRAGMA foreign_keys=OFF",
      "PRAGMA foreign_keys=ON",
    ]);
    const drop = (statement: string) =>
      caught(
        withForeignKeysLifted(driver, bracket, (inside) =>
          driver.withTransaction((transaction) =>
            inside(transaction, (producer) => producer._executeRaw(statement))
          )
        )
      );

    expect(await drop("-- written by hand\nDROP TABLE main.p;")).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining('"c" rows 1 -> 0'),
    });
    expect(await drop("DROP TABLE `p`")).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining("cannot be read"),
    });
    expect(db.prepare(`SELECT count(*) AS "n" FROM "c"`).get()).toEqual({
      n: 1,
    });
  });
});
