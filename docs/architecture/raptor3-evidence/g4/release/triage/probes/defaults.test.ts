/** Triage probe: which literal defaults disagree between the two MySQL snapshots. */
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { getMigrationDriver } from "@migrations/drivers";
import { serializeModels } from "@migrations/serializer";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;

const probe = (() => {
  const row = s
    .model({
      id: s.string().id(),
      text: s.string().default("draft"),
      flag: s.boolean().default(true),
      count: s.int().default(7),
      state: s.enum(["draft", "review"]).default("draft"),
    })
    .map("zz_default_probe");
  return { row };
})();

test("prints desired vs live defaults", async () => {
  const driver = new MySQL2Driver({
    databaseUrl: CONNECTION,
    migrationNamespaceAttestation: "non-redirecting",
  });
  const empty = createClient({ schema: {}, driver });
  await syncLiveSchema(empty);
  const client = createClient({ schema: probe, driver });
  const first = await syncLiveSchema(client).catch((e: unknown) => e);
  console.log("PUSH:", first instanceof Error ? first.message : "applied");
  const migrationDriver = getMigrationDriver(driver);
  const desired = serializeModels(probe as never, { migrationDriver } as never);
  const live = await migrationDriver.introspect(
    ((sql: string, params?: unknown[]) =>
      driver._executeRaw(sql, params ?? [])) as never
  );
  const d = desired.tables.find((t) => t.name === "zz_default_probe");
  const l = live.tables.find((t) => t.name === "zz_default_probe");
  console.log("DESIRED:", JSON.stringify(d?.columns));
  console.log("LIVE:   ", JSON.stringify(l?.columns));
  await syncLiveSchema(empty);
  await driver.disconnect();
  expect(true).toBe(true);
}, 120_000);
