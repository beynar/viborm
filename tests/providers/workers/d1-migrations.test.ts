import { env } from "cloudflare:test";
import { createClient } from "@src/client/client";
import { D1Driver } from "@src/drivers/d1";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { getMigrationDriver } from "@src/migrations/drivers";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { s } from "@src/schema";
import { expect, it, vi } from "vitest";

it("reads the D1 user catalog without touching protected metadata or enabling migration writes", async () => {
  await env.DB.exec(
    'CREATE TABLE "viborm_d1_catalog_user" ("id" TEXT PRIMARY KEY); CREATE TABLE "_cfX_notes" ("id" TEXT PRIMARY KEY);'
  );
  const driver = new D1Driver({ database: env.DB });
  const client = createClient({
    driver,
    schema: {
      user: s.model({ id: s.string().id() }).map("viborm_d1_catalog_user"),
      note: s.model({ id: s.string().id() }).map("_cfX_notes"),
    },
  });
  try {
    const catalog = await driver._executeRaw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    expect(catalog.rows.map(({ name }) => name)).toContain("_cf_METADATA");
    await expect(
      driver._executeRaw('PRAGMA table_info("_cf_METADATA")')
    ).rejects.toThrow();

    const calls = vi.spyOn(driver, "_executeRaw");
    const snapshot = await getMigrationDriver(driver).introspect(
      (sql, params) => driver._executeRaw(sql, params)
    );
    expect(snapshot.tables.map(({ name }) => name)).toEqual([
      "_cfX_notes",
      "viborm_d1_catalog_user",
    ]);
    expect(
      calls.mock.calls.some(([sql]) => sql.includes('("_cf_METADATA")'))
    ).toBe(false);

    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "d1-catalog-proof" });
    expect((await migrations.push({ dryRun: true })).operations).toEqual([]);
    expect(await migrations.status()).toMatchObject({ control: "absent" });
    calls.mockClear();
    await expect(migrations.push()).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    expect(calls).not.toHaveBeenCalled();
  } finally {
    await client.$disconnect();
  }
});
