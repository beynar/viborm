/** Triage probe: prints the two snapshots MySQL's enum comparison reads. */
import { MySQL2Driver } from "@drivers/mysql2";
import { getMigrationDriver } from "@migrations/drivers";
import { serializeModels } from "@migrations/serializer";
import { fieldRefSchema } from "@tests/fixtures/field-ref-schema";
import { expect, test } from "vitest";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;
const only = (columns: { name: string }[]) =>
  columns.filter((c) => c.name === "status" || c.name === "review_status");

test("prints desired and live enum spellings", async () => {
  const driver = new MySQL2Driver({
    databaseUrl: CONNECTION,
    migrationNamespaceAttestation: "non-redirecting",
  });
  const migrationDriver = getMigrationDriver(driver);
  const desired = serializeModels(fieldRefSchema as never, {
    migrationDriver,
  } as never);
  console.log("DESIRED ENUMS:", JSON.stringify(desired.enums));
  const post = desired.tables.find((t) => t.name === "fieldref_posts");
  console.log("DESIRED COLUMNS:", JSON.stringify(only(post?.columns ?? [])));
  const live = await migrationDriver.introspect(
    ((sql: string, params?: unknown[]) =>
      driver._executeRaw(sql, params ?? [])) as never
  );
  console.log("LIVE ENUMS:", JSON.stringify(live.enums));
  const livePost = live.tables.find((t) => t.name === "fieldref_posts");
  console.log("LIVE COLUMNS:", JSON.stringify(only(livePost?.columns ?? [])));
  await driver.disconnect();
  expect(true).toBe(true);
}, 120_000);
