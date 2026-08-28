import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import {
  type PushOptionsV1,
  previewPush,
  pushV1,
} from "@src/migrations/push-v1";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, expectTypeOf, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

const SCHEMA_WRITE = /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

const counter = s.model({
  id: s.int().id(),
  label: s.string(),
});

describe("migration v1 authenticated push", () => {
  test("dry-run is effect-free and force-reset dry-run does not write", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const preview = await previewPush(client, { forceReset: true });
    expect(preview.consent.mode).toBe("force-reset");
    const tables = await driver._executeRaw<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    );
    expect(tables.rows.filter((row) => row.name === "user")).toHaveLength(0);
    await client.$disconnect();
  });

  test("stale consent refuses after an external schema change", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const preview = await previewPush(client);
    await pushV1(client);
    await expect(
      pushV1(client, { consent: preview.consent })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
    });
    await client.$disconnect();
  });

  test("consent from another driver binding is refused", async () => {
    const first = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    const second = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    const preview = await previewPush(first);
    await expect(
      pushV1(second, { consent: preview.consent })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
    });
    await first.$disconnect();
    await second.$disconnect();
  });

  test("ordinary dry-run plans a diff and writes nothing", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const preview = await previewPush(client);
    expect(preview.consent.mode).toBe("diff");
    expect(preview.outcome).toBe("planned");
    const afterPreview = await driver._executeRaw<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    );
    expect(afterPreview.rows.filter((row) => row.name === "user")).toHaveLength(
      0
    );
    const dry = await pushV1(client, { dryRun: true });
    expect(dry).toMatchObject({ outcome: "planned" });
    const afterDry = await driver._executeRaw<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    );
    expect(afterDry.rows.filter((row) => row.name === "user")).toHaveLength(0);
    await client.$disconnect();
  });

  test("RecordingDriver dry-run records no DDL or DML writes", async () => {
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };
    await pushV1(client, { dryRun: true });
    const writes = driver.statements.filter((sql) =>
      SCHEMA_WRITE.test(sql.trim())
    );
    expect(writes).toEqual([]);
  });

  test("a non-empty push against a migration marker is refused", async () => {
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const post = s.model({
      id: s.string().id(),
      title: s.string(),
    });
    const next = createClient({ schema: { user, post }, driver });
    await expect(pushV1(next)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("migration marker"),
    });
    await next.$disconnect();
    await client.$disconnect();
  });

  test("generic force is not a V1 option", async () => {
    const client = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    await expect(
      pushV1(client, { force: true } as never)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining("unknown key force"),
    });
    expectTypeOf<PushOptionsV1>().not.toHaveProperty("force");
    await client.$disconnect();
  });

  test("sqlite integer primary keys without AUTOINCREMENT attest", async () => {
    const client = createClient({
      schema: { counter },
      driver: createInMemorySQLite3Driver(),
    });
    const result = await pushV1(client);
    expect(result.outcome).toBe("applied");
    const second = await pushV1(client);
    expect(second.outcome).toBe("noop");
    await client.$disconnect();
  });

  test("a transactionless admitted driver still applies", async () => {
    class TransactionlessSQLite3 extends SQLite3Driver {
      override readonly supportsTransactions = false;
    }
    const driver = new TransactionlessSQLite3({ dataDir: ":memory:" });
    const client = createClient({ schema: { user }, driver });
    const result = await pushV1(client);
    expect(result.outcome).toBe("applied");
    await client.$disconnect();
  });

  test("second push is a no-op", async () => {
    const client = createClient({
      schema: { user },
      driver: createInMemorySQLite3Driver(),
    });
    const first = await pushV1(client);
    expect(first.outcome).toBe("applied");
    const second = await pushV1(client);
    expect(second.outcome).toBe("noop");
    await client.$disconnect();
  });

  test("sqlite enum CHECK is the same physical type after introspect", async () => {
    const item = s.model({
      id: s.string().id(),
      kind: s.enum(["alpha", "beta"]),
    });
    const client = createClient({
      schema: { item },
      driver: createInMemorySQLite3Driver(),
    });
    await pushV1(client);
    const second = await previewPush(client);
    expect(second.operations).toEqual([]);
    await client.$disconnect();
  });
});
