/**
 * Migrations on `viborm/durable-object`, in the object: push, generate and
 * apply, down and reset, the platform's `_cf_` tables, table recreation with
 * foreign keys lifted after a pending write, and the frame lock. Ported from
 * the first Durable Object driver an application wrote (Flarion, 2026-11).
 */
import type {
  DurableObjectState,
  DurableObjectStorage,
} from "@cloudflare/workers-types";
import { DURABLE_OBJECT_MIGRATION_CAPABILITY } from "@src/drivers/driver";
import {
  createClient,
  createDurableObjectDriver,
} from "@src/drivers/durable-object";
import { createMigrationClient } from "@src/migrations/client";
import { getMigrationDriver } from "@src/migrations/drivers";
import { createDurableObjectStorageWriter } from "@src/migrations/storage/durable-object";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { createTenantMigrator } from "@src/migrations/tenant";
import type { ResolveCallback } from "@src/migrations/types";
import { s } from "@src/schema";
import { describe, expect, test, vi } from "vitest";
import { inObject } from "./objects";

const v1 = {
  user: s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => v1.post),
    })
    .map("users"),
  post: s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => v1.user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts"),
};

/** A nullable column and a unique constraint: the second recreates `users`. */
const v2 = {
  user: s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      bio: s.string().nullable(),
      posts: s.toMany(() => v2.post),
    })
    .map("users"),
  post: s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => v2.user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts"),
};

/** What a Durable Object refuses, and so what the driver must never send. */
const REFUSED_BY_THE_PLATFORM =
  /^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b|busy_timeout/i;

const sqlOf = (state: DurableObjectState) => (statement: string) =>
  state.storage.sql.exec(statement).toArray();

function tableNames(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
    .toArray()
    .map(({ name }) => name);
}

async function pushed(storage: DurableObjectStorage) {
  const client = createClient({ storage, schema: v1 });
  const migrations = createMigrationClient(client);
  const preview = await migrations.push({ dryRun: true });
  await migrations.push({ consent: preview.consent });
  return client;
}

/** Accepts every destructive change, refuses anything else. */
const proceed: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : change.reject();

describe("Durable Object driver: migrations", () => {
  test("binds the SQLite implementation with the Durable Object capability", async () => {
    await inObject(async (state) => {
      const bound = getMigrationDriver(
        createDurableObjectDriver(state.storage)
      );
      expect(bound.sqliteMigrationCapability).toEqual(
        DURABLE_OBJECT_MIGRATION_CAPABILITY
      );
      expect(bound.driverName).toBe("sqlite3");
    });
  });

  test("push creates the schema from an empty object, then is a no-op", async () => {
    await inObject(async (state) => {
      const client = createClient({ storage: state.storage, schema: v1 });
      const migrations = createMigrationClient(client);
      const preview = await migrations.push({ dryRun: true });
      expect(preview.operations.length).toBeGreaterThan(0);
      expect(
        (await migrations.push({ consent: preview.consent })).outcome
      ).toBe("applied");
      await client.user.create({
        data: {
          id: "u1",
          name: "Ada",
          posts: { create: { id: "p1", title: "Hi" } },
        },
      });
      expect((await migrations.push({ dryRun: true })).operations).toEqual([]);
    });
  });

  test("the platform's _cf_ tables are not the application's: push plans nothing for them", async () => {
    await inObject(async (state) => {
      await state.storage.put("some", "kv");
      await state.storage.setAlarm(Date.now() + 60_000);
      expect(tableNames(state.storage)).toContain("_cf_KV");
      const client = await pushed(state.storage);
      // No `tables`: every table but Cloudflare's is the schema's to manage.
      const again = await createMigrationClient(client).push({ dryRun: true });
      expect(again.operations).toEqual([]);
      expect(await state.storage.get("some")).toBe("kv");
      await state.storage.deleteAlarm();
    });
  });

  test("an FTS5 table stays usable when kept out of the managed tables", async () => {
    await inObject(async (state) => {
      state.storage.sql.exec(
        "CREATE VIRTUAL TABLE search USING fts5(page UNINDEXED, text)"
      );
      const storage = new MemoryEstateStorage();
      const client = createClient({ storage: state.storage, schema: v1 });
      const migrations = createMigrationClient(client, {
        storage,
        tables: ["users", "posts"],
      });
      await migrations.generate({ name: "init" });
      expect((await migrations.apply()).outcome).toBe("applied");
      state.storage.sql.exec(
        "INSERT INTO search (page, text) VALUES ('p1', 'hello world')"
      );
      expect(
        state.storage.sql
          .exec("SELECT page FROM search WHERE search MATCH 'hello'")
          .toArray()
      ).toEqual([{ page: "p1" }]);
    });
  });

  test("generate then apply; re-apply is a no-op; a recreation keeps child rows with foreign keys lifted for real", async () => {
    await inObject(async (state) => {
      const storage = new MemoryEstateStorage();
      const client1 = createClient({ storage: state.storage, schema: v1 });
      const m1 = createMigrationClient(client1, { storage });
      expect((await m1.generate({ name: "init" })).outcome).toBe("published");
      expect((await m1.apply()).outcome).toBe("applied");
      expect((await m1.apply()).outcome).toBe("noop");
      await client1.user.create({
        data: {
          id: "u1",
          name: "Ada",
          posts: { create: [{ id: "p1", title: "Hi" }] },
        },
      });

      const client2 = createClient({ storage: state.storage, schema: v2 });
      const m2 = createMigrationClient(client2, { storage });
      expect((await m2.generate({ name: "unique-name" })).outcome).toBe(
        "published"
      );
      expect((await m2.apply()).outcome).toBe("applied");
      expect(await client2.post.count()).toBe(1);
      const sql = sqlOf(state);
      expect(sql("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
      expect(sql("PRAGMA foreign_key_check")).toEqual([]);
      await expect(
        client2.user.create({ data: { id: "u2", name: "Ada" } })
      ).rejects.toMatchObject({ name: "UniqueConstraintError" });
    });
  });

  test("a write earlier in the same event does not turn the foreign-key lift into a no-op", async () => {
    await inObject(async (state) => {
      const storage = new MemoryEstateStorage();
      const client1 = createClient({ storage: state.storage, schema: v1 });
      const m1 = createMigrationClient(client1, { storage });
      await m1.generate({ name: "init" });
      await m1.apply();
      await client1.user.create({
        data: {
          id: "u1",
          name: "Ada",
          posts: {
            create: [
              { id: "p1", title: "a" },
              { id: "p2", title: "b" },
            ],
          },
        },
      });
      const client2 = createClient({ storage: state.storage, schema: v2 });
      const m2 = createMigrationClient(client2, { storage });
      await m2.generate({ name: "v2" });
      state.storage.sql.exec(
        "INSERT INTO users (id, name) VALUES ('u3', 'Cy')"
      );
      expect((await m2.apply()).outcome).toBe("applied");
      expect(await client2.post.count()).toBe(2);
    });
  });

  test("the beforeForeignKeysOff hook settles a pending write, without which the pragma is a no-op", async () => {
    await inObject(async (state) => {
      const driver = createDurableObjectDriver(state.storage);
      const sql = sqlOf(state);
      const foreignKeys = () =>
        (sql("PRAGMA foreign_keys")[0] as { foreign_keys: number })
          .foreign_keys;
      sql("CREATE TABLE fk_probe (id TEXT PRIMARY KEY)");
      // Control: a pending write turns the pragma into a no-op.
      sql("INSERT INTO fk_probe VALUES ('a')");
      sql("PRAGMA foreign_keys = OFF");
      expect(foreignKeys()).toBe(1);
      sql("INSERT INTO fk_probe VALUES ('b')");
      await driver["beforeForeignKeysOff"]();
      sql("PRAGMA foreign_keys = OFF");
      expect(foreignKeys()).toBe(0);
      sql("PRAGMA foreign_keys = ON");
    });
  });

  test("a failing migration rolls back completely and leaves the previous schema", async () => {
    await inObject(async (state) => {
      const storage = new MemoryEstateStorage();
      const client1 = createClient({ storage: state.storage, schema: v1 });
      const m1 = createMigrationClient(client1, { storage });
      await m1.generate({ name: "init" });
      await m1.apply();
      // Two users with one name: the v2 unique constraint cannot hold.
      await client1.user.create({ data: { id: "u1", name: "Ada" } });
      await client1.user.create({ data: { id: "u2", name: "Ada" } });
      const client2 = createClient({ storage: state.storage, schema: v2 });
      const m2 = createMigrationClient(client2, { storage });
      await m2.generate({ name: "v2" });
      await expect(m2.apply()).rejects.toBeTruthy();
      expect(
        sqlOf(state)("SELECT name FROM pragma_table_info('users')").map(
          (column) => (column as { name: string }).name
        )
      ).toEqual(["id", "name"]);
      expect(await client1.user.count()).toBe(2);
      expect(sqlOf(state)("PRAGMA foreign_keys")).toEqual([
        { foreign_keys: 1 },
      ]);
    });
  });

  test("down undoes the last state, reset replays them on empty tables", async () => {
    await inObject(async (state) => {
      const storage = new MemoryEstateStorage();
      const client1 = createClient({ storage: state.storage, schema: v1 });
      await createMigrationClient(client1, { storage }).generate({
        name: "init",
      });
      const client2 = createClient({ storage: state.storage, schema: v2 });
      const m2 = createMigrationClient(client2, { storage });
      await m2.generate({ name: "v2" });
      expect((await m2.apply()).outcome).toBe("applied");
      expect(
        sqlOf(state)("SELECT name FROM pragma_table_info('users')")
      ).toContainEqual({ name: "bio" });

      // A destructive change is confirmed by a callback, which the lock lets
      // go for: its frame commits before, and a new one opens after.
      expect(await m2.down({ steps: 1, resolve: proceed })).toMatchObject({
        preview: false,
      });
      expect(
        sqlOf(state)("SELECT name FROM pragma_table_info('users')")
      ).not.toContainEqual({ name: "bio" });

      // Reset drops the managed tables, then replays every state.
      state.storage.sql.exec(
        "INSERT INTO users (id, name) VALUES ('u1', 'Ada')"
      );
      expect(await m2.reset()).toMatchObject({ preview: false });
      expect(
        sqlOf(state)("SELECT name FROM pragma_table_info('users')")
      ).toContainEqual({ name: "bio" });
      expect(await client2.user.count()).toBe(0);
    });
  });

  test("apply in the constructor's blockConcurrencyWhile", async () => {
    await inObject(async (state) => {
      const storage = new MemoryEstateStorage();
      const client = createClient({ storage: state.storage, schema: v1 });
      const migrations = createMigrationClient(client, { storage });
      await migrations.generate({ name: "init" });
      expect(
        (await state.blockConcurrencyWhile(() => migrations.apply())).outcome
      ).toBe("applied");
      expect(
        (await state.blockConcurrencyWhile(() => migrations.apply())).outcome
      ).toBe("noop");
      await client.user.create({ data: { id: "u1", name: "Ada" } });
      expect(await client.user.count()).toBe(1);
    });
  });

  test("the tenant migrator with its history in the object", async () => {
    await inObject(async (state) => {
      const client = createClient({ storage: state.storage, schema: v1 });
      // The history is a table of this same database, so the managed set
      // names the application's tables.
      const migrator = createTenantMigrator({
        client,
        history: createDurableObjectStorageWriter(state.storage),
        tables: ["users", "posts"],
      });
      expect((await migrator.change(v1)).kind).toBe("applied");
      await client.user.create({
        data: {
          id: "u1",
          name: "Ada",
          posts: { create: { id: "p1", title: "x" } },
        },
      });
      expect((await migrator.change(v2)).kind).toBe("applied");
      expect((await migrator.change(v2)).kind).toBe("noop");
      expect(await client.post.count()).toBe(1);
    });
  });
});

describe("Durable Object driver: the migration frame", () => {
  test("the lock sends no BEGIN, SAVEPOINT, COMMIT, ROLLBACK or busy_timeout", async () => {
    await inObject(async (state) => {
      const driver = createDurableObjectDriver(state.storage);
      const statements = vi.spyOn(state.storage.sql, "exec");
      await pushed(state.storage);
      const client2 = createClient({ storage: state.storage, schema: v2 });
      const migrations = createMigrationClient(client2);
      await migrations.push({
        consent: (await migrations.push({ dryRun: true })).consent,
      });
      const sent = statements.mock.calls.map(([sql]) => String(sql));
      // The recreation ran, between two frames.
      expect(sent).toContain("PRAGMA foreign_keys=OFF;");
      expect(sent.filter((sql) => REFUSED_BY_THE_PLATFORM.test(sql))).toEqual(
        []
      );
      expect(client2.$driver).toBe(driver);
    });
  });

  test("while a frame is open, the driver's other callers wait and a raw statement joins the frame", async () => {
    await inObject(async (state) => {
      const client1 = await pushed(state.storage);
      const driver = createDurableObjectDriver(state.storage);
      const client2 = createClient({ storage: state.storage, schema: v2 });
      const migrations = createMigrationClient(client2);
      const consent = (await migrations.push({ dryRun: true })).consent;

      // Hold the migration at the provider boundary while it copies rows into
      // the rebuilt table (the CREATE before it opened a frame), then fail it.
      let reached: () => void = () => undefined;
      const atCopy = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let fail: (error: Error) => void = () => undefined;
      const failure = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      const provider = driver as unknown as {
        execute(
          storage: unknown,
          sql: string,
          params: unknown[]
        ): Promise<unknown>;
      };
      const execute = provider.execute;
      vi.spyOn(provider, "execute").mockImplementation(function (
        this: unknown,
        storage,
        sql,
        params
      ) {
        if (sql.includes('INSERT INTO "__new_users"')) {
          reached();
          return failure;
        }
        return execute.call(this, storage, sql, params);
      });

      const migration = migrations.push({ consent });
      migration.catch(() => undefined);
      await atCopy;

      let counted = false;
      const count = client1.user.count().then((n) => {
        counted = true;
        return n;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(counted).toBe(false);
      // Around the driver, a statement joins the open frame.
      state.storage.sql.exec(
        "INSERT INTO users (id, name) VALUES ('raw', 'r')"
      );

      fail(new Error("held migration failed"));
      await expect(migration).rejects.toThrow();
      // The frame rolled back, and the raw write with it; then the count ran.
      expect(await count).toBe(0);
      expect(
        state.storage.sql.exec("SELECT count(*) AS c FROM users").one()
      ).toEqual({ c: 0 });
    });
  });
});
