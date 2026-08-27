/**
 * The ONE command view a READ-ONLY migration command renders from (§5.2).
 *
 * `status()`, `pending()` and a dry `push()` take no lock — they are
 * point-in-time reports, not concurrency-stable decisions — but they still talk
 * to a server whose own spelling of the configured database can differ from the
 * configured one. Proving the spelling and then rendering the configured one is
 * what made a case-folded match read `Alpha`.`_viborm_migrations` off a server
 * that only has `alpha`, and made a dry push return DDL naming a database the
 * server does not have.
 *
 * So the falsifier is the same on all three verbs: the configured spelling
 * reaches the server ONLY as bound catalog data, and every rendered identifier
 * carries the spelling the server answered with.
 */

import { pending, push, status } from "@migrations";
import type { MigrationClient } from "@migrations/push";
import type { MigrationEntry, MigrationJournal } from "@migrations/types";
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

const INIT: MigrationEntry = {
  idx: 0,
  version: "20240101000000",
  name: "init",
  when: 1,
  checksum: "checksum-init",
  mode: "generated",
  rollback: { kind: "automatic" },
};

const JOURNAL: MigrationJournal = {
  version: "3",
  target: { dialect: "mysql" },
  entries: [INIT],
};

/**
 * A server that HAS `alpha` and does not have `Alpha`.
 *
 * `lower_case_table_names` is why the proof accepts one case-folded candidate;
 * the server still answers to exactly one spelling, and this fixture answers
 * every catalog read with it.
 */
function alphaServer(): RecordingDriver {
  const driver = mysqlEstateDriver({ namespace: "Alpha", attested: true });
  driver.respond = (sql: string) =>
    sql.includes("SCHEMATA") ? [{ SCHEMA_NAME: "alpha" }] : [];
  return driver;
}

async function seededStorage(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await storage.writeJournal(JOURNAL);
  storage.writes.length = 0;
  storage.reads.length = 0;
  return storage;
}

/** The one statement a read-only applied-state read renders. */
const TRACKING_SELECT = /^SELECT name, checksum, applied_at FROM /;

describe("read-only commands render from the spelling the server answered", () => {
  it("status() reads tracking from the resolved database", async () => {
    const driver = alphaServer();
    const storage = await seededStorage();

    const statuses = await status(clientFor(driver), {
      storageDriver: storage,
    });

    expect(statuses.map((entry) => entry.applied)).toEqual([false]);
    const select = driver.statements.find((sql) => TRACKING_SELECT.test(sql));
    expect(select).toContain("`alpha`.`_viborm_migrations`");
    // The configured spelling reached the server only as BOUND catalog data,
    // never as an identifier a statement rendered.
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
    // …and the proof it was bound to is the SAME read that answered the
    // spelling: one resolution, one view, no second namespace source.
    expect(
      driver.statements.filter((sql) => sql.includes("SCHEMATA"))
    ).toHaveLength(1);
    // The caller's own bound driver is untouched: the projection is
    // command-local and disappears with the command that resolved it.
    expect(driver.adapter.namespace).toBe("Alpha");
  });

  it("pending() reads tracking from the resolved database", async () => {
    const driver = alphaServer();
    const storage = await seededStorage();

    const entries = await pending(clientFor(driver), {
      storageDriver: storage,
    });

    expect(entries.map((entry) => entry.name)).toEqual(["init"]);
    const select = driver.statements.find((sql) => TRACKING_SELECT.test(sql));
    expect(select).toContain("`alpha`.`_viborm_migrations`");
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
  });

  it("a dry push RETURNS SQL carrying the resolved database", async () => {
    const driver = alphaServer();

    const result = await push(clientFor(driver), {
      force: true,
      dryRun: true,
    });

    expect(result.applied).toBe(false);
    // The introspection already filtered on the resolved spelling; the SQL the
    // caller is handed used to be rendered from the ORIGINAL bound driver, so
    // the preview named a database the server does not have.
    expect(result.sql.join("\n")).toContain("`alpha`.");
    expect(result.sql.join("\n")).not.toContain("Alpha");
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
  });

  it("leaves a byte-exact configured spelling alone", async () => {
    // The control: when the server answers with the configured name itself,
    // nothing is projected and every statement reads exactly as before.
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (sql: string) =>
      sql.includes("SCHEMATA") ? [{ SCHEMA_NAME: "alpha" }] : [];
    const storage = await seededStorage();

    await status(clientFor(driver), { storageDriver: storage });

    const select = driver.statements.find((sql) => TRACKING_SELECT.test(sql));
    expect(select).toContain("`alpha`.`_viborm_migrations`");
  });
});
