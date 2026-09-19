/**
 * Triage probe (not part of any registered suite, not under tests/): names the
 * object the MySQL fingerprint attestation disagrees about.
 */
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createMigrationClient } from "@migrations";
import { fieldRefSchema } from "@tests/fixtures/field-ref-schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;

test("names the drifting object", async () => {
  const driver = new MySQL2Driver({
    databaseUrl: CONNECTION,
    migrationNamespaceAttestation: "non-redirecting",
  });
  const client = createClient({ schema: fieldRefSchema, driver });
  // Drop everything first, exactly like the suite's beforeEach.
  const empty = createClient({ schema: {}, driver: new MySQL2Driver({
    databaseUrl: CONNECTION,
    migrationNamespaceAttestation: "non-redirecting",
  }) });
  await syncLiveSchema(empty);
  await empty.$disconnect();
  const first = await syncLiveSchema(client).catch((error: unknown) => error);
  // eslint-disable-next-line no-console
  console.log("FIRST PUSH:", first instanceof Error ? `${first.name}: ${first.message}` : "applied");
  const migrations = createMigrationClient(client);
  const again = await migrations.push({ dryRun: true }).catch((e: unknown) => e);
  if (again instanceof Error) {
    console.log("SECOND DRY RUN THREW:", again.message);
  } else {
    console.log("SECOND DRY RUN OPERATIONS:", JSON.stringify(again.operations, null, 1));
    console.log("SECOND DRY RUN STATEMENTS:", JSON.stringify(again.statements.map((s: { sql: string }) => s.sql), null, 1));
  }
  await client.$disconnect();
  expect(true).toBe(true);
}, 120_000);
