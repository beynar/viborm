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
import type { ResolveCallback } from "@src/migrations/types";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
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
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };
    const preview = await previewPush(client, { forceReset: true });
    expect(preview.consent.mode).toBe("force-reset");
    expect(
      driver.statements.filter((statement) =>
        SCHEMA_WRITE.test(statement.trim())
      )
    ).toEqual([]);
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
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };
    const preview = await previewPush(client);
    expect(preview.consent.mode).toBe("diff");
    expect(preview.outcome).toBe("planned");
    const dry = await pushV1(client, { dryRun: true });
    expect(dry).toMatchObject({ outcome: "planned" });
    expect(
      driver.statements.filter((statement) =>
        SCHEMA_WRITE.test(statement.trim())
      )
    ).toEqual([]);
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
    await client.$disconnect();
  });

  test("generic force is not a V1 option", async () => {
    const client = createClient({
      schema: { user },
      driver: new PlanningDriver("sqlite"),
    });
    await expect(
      pushV1(client, { force: true } as never)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining("unknown key force"),
    });
    expectTypeOf<PushOptionsV1>().not.toHaveProperty("force");
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

  test("a resolved destructive change still requires consent, then applies the locked replan", async () => {
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: { user }, driver });
    await pushV1(initial);
    const reducedUser = s.model({ id: s.string().id() });
    const reduced = createClient({ schema: { user: reducedUser }, driver });
    const resolve: ResolveCallback = (change) =>
      change.type === "destructive" ? change.proceed() : undefined;

    await expect(pushV1(reduced, { resolve })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
    });
    const preview = await previewPush(reduced, { resolve });
    expect(preview.destructive).toBe(true);
    await expect(
      pushV1(reduced, { consent: preview.consent })
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(pushV1(reduced)).resolves.toMatchObject({ outcome: "noop" });
    await initial.$disconnect();
  });

  test("push refuses success when the provider does not realize its statements", async () => {
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: { user } };

    await expect(pushV1(client)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: expect.stringContaining("final live fingerprint"),
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("CREATE"))
    ).toBe(true);
  });
});
