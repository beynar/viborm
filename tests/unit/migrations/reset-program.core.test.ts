import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import type { Sha256 } from "@src/migrations/identity";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { publishLegacyStepwise } from "./_legacy-stepwise";

/**
 * `reset()` on SQLite runs the program apply runs, under the same refusals.
 *
 * Reset replays the whole history from empty in one command, so each test
 * builds an estate whose path apply already handles — relations, a manual
 * seed, a later table recreation, a manual trigger, a stepwise edge — and
 * asks reset for the same answer apply gives, at a few thousand rows.
 */

const ROWS = 2000;

// better-sqlite3 answers synchronously: give the worker's event loop a turn.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

type Driver = ReturnType<typeof createInMemorySQLite3Driver>;

async function count(driver: Driver, query: string): Promise<number> {
  const { rows } = await driver._executeRaw<{ n: number }>(query);
  return Number(rows[0]?.n);
}

const seeded = (from: string | undefined, up: readonly string[]) => ({
  manualMigration: {
    transitions: [
      {
        from,
        execution: "transactional",
        up: up.map((text) => sql.raw(text)),
        rollback: { kind: "irreversible", reason: "seed" },
      },
    ],
    destinationChecks: [],
  },
});

const series = (n: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})`;

describe("reset() over SQLite foreign keys", () => {
  const library = () => {
    const author = s.model({
      id: s.string().id(),
      favoriteId: s.string().nullable(),
      favorite: s
        .toOne(() => book)
        .name("favorite")
        .fields("favoriteId")
        .references("id"),
      books: s.toMany(() => book).name("authorship"),
    });
    const book = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .name("authorship")
        .fields("authorId")
        .references("id"),
      favoredBy: s.toMany(() => author).name("favorite"),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => book)
        .fields("parentId")
        .references("id"),
      sequels: s.toMany(() => book),
    });
    return { author, book };
  };
  const fill = async (driver: Driver) => {
    await driver._executeRaw(
      `${series(ROWS)} INSERT INTO "author" ("id") SELECT 'a' || i FROM n`
    );
    await driver._executeRaw(
      `${series(ROWS)} INSERT INTO "book" ("id", "authorId", "parentId") SELECT 'b' || i, 'a' || i, CASE WHEN i > 1 THEN 'b' || (i - 1) END FROM n`
    );
    await driver._executeRaw(
      `UPDATE "author" SET "favoriteId" = 'b' || substr("id", 2)`
    );
  };

  test("reset and its preview clear populated tables that reference each other", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: library(), driver });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "library" });
    await migrations.apply();
    await fill(driver);

    const preview = await migrations.reset({ dryRun: true });
    expect(preview.tables).toEqual(expect.arrayContaining(["author", "book"]));
    await expect(migrations.reset()).resolves.toMatchObject({ preview: false });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    expect(await count(driver, 'SELECT count(*) AS n FROM "book"')).toBe(0);
    expect(await count(driver, 'SELECT count(*) AS n FROM "author"')).toBe(0);
    await client.$disconnect();
  });

  test("push({ forceReset }) rebuilds populated tables that reference each other", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: library(), driver });
    const migrations = createMigrationClient(client);
    await migrations.push();
    await fill(driver);

    const preview = await migrations.push({ forceReset: true, dryRun: true });
    await expect(
      migrations.push({ consent: preview.consent })
    ).resolves.toMatchObject({ outcome: "applied" });
    expect(await count(driver, 'SELECT count(*) AS n FROM "book"')).toBe(0);
    await client.$disconnect();
  });

  test("a replayed recreation keeps the seeded rows that reference the rebuilt table", async () => {
    const schema = (labelNullable: boolean) => {
      const item = s.model({
        id: s.string().id(),
        label: labelNullable ? s.string().nullable() : s.string(),
        tags: s.toMany(() => tag),
        notes: s.toMany(() => note),
      });
      const tag = s.model({
        id: s.string().id(),
        itemId: s.string(),
        item: s
          .toOne(() => item)
          .fields("itemId")
          .references("id")
          .onDelete("cascade"),
      });
      const note = s.model({
        id: s.string().id(),
        itemId: s.string().nullable(),
        item: s
          .toOne(() => item)
          .fields("itemId")
          .references("id")
          .onDelete("setNull"),
      });
      return { item, tag, note };
    };
    const storage = new MemoryEstateStorage();
    const author = createClient({
      schema: schema(false),
      driver: createInMemorySQLite3Driver(),
    });
    const v1 = await createMigrationClient(author, { storage }).generate({
      name: "v1",
    });
    await createMigrationClient(author, { storage }).generate({
      name: "seed",
      ...seeded(v1.stateId!, [
        `${series(ROWS)} INSERT INTO "item" ("id", "label") SELECT 'i' || i, 'item' FROM n`,
        `${series(ROWS)} INSERT INTO "tag" ("id", "itemId") SELECT 't' || i, 'i' || i FROM n`,
        `${series(ROWS)} INSERT INTO "note" ("id", "itemId") SELECT 'n' || i, 'i' || i FROM n`,
      ]),
    } as never);
    const widened = createClient({
      schema: schema(true),
      driver: createInMemorySQLite3Driver(),
    });
    const v2 = await createMigrationClient(widened, { storage }).generate({
      name: "v2",
    });
    expect(v2.sql).toContain("__new_item");
    await author.$disconnect();
    await widened.$disconnect();

    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: schema(true), driver });
    const migrations = createMigrationClient(client, { storage });
    await expect(migrations.reset()).resolves.toMatchObject({ preview: false });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    expect(await count(driver, 'SELECT count(*) AS n FROM "tag"')).toBe(ROWS);
    expect(
      await count(
        driver,
        'SELECT count(*) AS n FROM "note" WHERE "itemId" IS NOT NULL'
      )
    ).toBe(ROWS);
    await client.$disconnect();
  });
});

describe("reset() refuses what apply refuses, before any effect", () => {
  test("a replayed recreation that would drop a manual trigger", async () => {
    const schema = (qtyText: boolean) => ({
      item: s.model({
        id: s.string().id(),
        qty: qtyText ? s.string() : s.int(),
      }),
      audit: s.model({ id: s.string().id(), msg: s.string() }),
    });
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: schema(false), driver });
    const migrations = createMigrationClient(client, { storage });
    const a = await migrations.generate({ name: "a" });
    const b = await migrations.generate({
      name: "b",
      ...seeded(a.stateId!, [
        `CREATE TRIGGER "item_audit" AFTER INSERT ON "item" BEGIN INSERT INTO "audit" ("id", "msg") VALUES (new."id", 'x'); END`,
      ]),
    } as never);
    await migrations.apply();
    await client.item.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({ id: `i${i}`, qty: i })),
    });
    const retyped = createClient({ schema: schema(true), driver });
    const later = createMigrationClient(retyped, { storage });
    const c = await later.generate({
      name: "c",
      resolve: (change: { proceed?: () => unknown }) => change.proceed?.(),
    } as never);
    await expect(later.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining('trigger "item_audit"'),
      meta: { feature: "table recreation" },
    });

    const lost = {
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining('trigger "item_audit"'),
      meta: { feature: "table recreation" },
    };
    await expect(
      later.reset({ to: { id: c.stateId! }, dryRun: true })
    ).rejects.toMatchObject(lost);
    await expect(later.reset({ to: { id: c.stateId! } })).rejects.toMatchObject(
      lost
    );
    expect((await later.status()).marker?.stateId).toBe(b.stateId!);
    expect(await count(driver, 'SELECT count(*) AS n FROM "item"')).toBe(ROWS);
    expect(
      await count(
        driver,
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'"
      )
    ).toBe(1);
    await client.$disconnect();
  });

  test("a stepwise SQLite transition 1.1.0 published", async () => {
    const schema = {
      account: s.model({ id: s.string().id(), balance: s.int() }),
    };
    const authored = new MemoryEstateStorage();
    const author = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });
    const v1 = await createMigrationClient(author, {
      storage: authored,
    }).generate({ name: "v1" });
    const credit = await createMigrationClient(author, {
      storage: authored,
    }).generate({
      name: "credit",
      ...seeded(v1.stateId!, [
        'UPDATE "account" SET "balance" = "balance" + 10',
      ]),
    } as never);
    await author.$disconnect();
    // Generate refuses it since 1.2.0 (plan S5): the head is 1.1.0's.
    const storage = new MemoryEstateStorage();
    await storage.publishEstate((await authored.readEstate())!);
    for (const hash of await authored.listSnapshots()) {
      await storage.publishSnapshot(hash, (await authored.readSnapshot(hash))!);
    }
    for (const hash of await authored.listSql()) {
      await storage.publishSql(hash, (await authored.readSql(hash))!);
    }
    await storage.publishState(
      v1.stateId!,
      (await authored.readState(v1.stateId!))!
    );
    await publishLegacyStepwise(authored, storage, credit.stateId as Sha256);

    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.apply({ to: { id: v1.stateId! } });
    await client.account.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({
        id: `a${i}`,
        balance: i,
      })),
    });
    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      meta: { feature: "stepwise execution" },
    });

    await expect(migrations.reset()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      meta: { feature: "stepwise execution" },
    });
    expect((await migrations.status()).marker?.stateId).toBe(v1.stateId!);
    expect(await count(driver, 'SELECT count(*) AS n FROM "account"')).toBe(
      ROWS
    );
    await client.$disconnect();
  });
});
