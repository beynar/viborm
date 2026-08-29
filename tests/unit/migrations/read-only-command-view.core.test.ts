/**
 * The ONE command view a READ-ONLY migration command renders from (§5.2).
 *
 * `status()` and a dry `push()` take no lock — they are point-in-time reports
 * — but preview planning still talks to a server whose own spelling of the
 * configured database can differ from the configured one. Proving the spelling
 * and then rendering the configured one is what made a dry push return DDL
 * naming a database the server does not have.
 */

import { createMigrationClient } from "@migrations";
import { statusV1 as status } from "@migrations/operators";
import type { MigrationClient } from "@migrations/push/planner";
import { previewPush } from "@migrations/push-v1";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  type RecordingDriver,
} from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

/**
 * A server that HAS `alpha` and does not have `Alpha`.
 *
 * `lower_case_table_names` is why the proof accepts one case-folded candidate;
 * the server still answers to exactly one spelling, and this fixture answers
 * every catalog read with it.
 */
function alphaServer(): RecordingDriver {
  const driver = mysqlEstateDriver({ namespace: "Alpha", attested: true });
  driver.respond = (sql: string) => {
    if (sql.includes("SCHEMATA")) return [{ SCHEMA_NAME: "alpha" }];
    if (sql.includes("EXISTS") && sql.includes("information_schema.tables")) {
      return [{ exists: 0 }];
    }
    return [];
  };
  return driver;
}

describe("read-only commands render from the spelling the server answered", () => {
  it("status() is a point-in-time report and never writes", async () => {
    const driver = alphaServer();
    const storage = new MemoryStorage();
    const migrations = createMigrationClient(clientFor(driver), { storage });
    await migrations.generate({ name: "init" });
    storage.writes.length = 0;

    const report = await status(clientFor(driver), storage);
    expect(report.control).toBe("absent");
    expect(report.pending).toHaveLength(1);
    expect(storage.writes).toEqual([]);
    expect(driver.sessions).toEqual([]);
    expect(driver.adapter.namespace).toBe("Alpha");
    const controlProbe = driver.statements.findIndex((sql) =>
      sql.includes("information_schema.tables")
    );
    expect(controlProbe).toBeGreaterThanOrEqual(0);
    expect(driver.parameters[controlProbe]).toContain("alpha");
    expect(driver.parameters[controlProbe]).not.toContain("Alpha");
  });

  it("a dry push RETURNS SQL carrying the resolved database", async () => {
    const driver = alphaServer();

    const result = await previewPush(clientFor(driver));

    expect(result.outcome).toBe("planned");
    const previewSql = result.statements
      .map((statement) => statement.sql)
      .join("\n");
    expect(previewSql).toContain("`alpha`.");
    expect(previewSql).not.toContain("Alpha");
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
  });

  it("leaves a byte-exact configured spelling alone", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (sql: string) =>
      sql.includes("SCHEMATA") ? [{ SCHEMA_NAME: "alpha" }] : [];

    const result = await previewPush(clientFor(driver));
    const previewSql = result.statements
      .map((statement) => statement.sql)
      .join("\n");
    expect(previewSql).toContain("`alpha`.");
  });
});
