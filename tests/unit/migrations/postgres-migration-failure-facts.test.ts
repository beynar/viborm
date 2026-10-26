/**
 * What a migration failure tells its caller (PGlite), the four gaps Pyxel met
 * on a PlanetScale Postgres (Neki) `reset()` that failed as a bare
 * `V2001 { driver, operation: "transaction" }`:
 *
 * - a provider code outside the SQL standard's classes (Neki's `NK013`) is
 *   kept, so the refusal is a located `MigrationError`, not a transport
 *   failure;
 * - the failure names where it happened (`step`, `stateId`, `statementIndex`,
 *   `strategy`) without diagnostics;
 * - with the client's `instrumentation({ diagnostics })`, the provider's text
 *   and the statement are disclosed, as they are for client operations.
 *
 * A DDL event trigger raising `NK013` stands in for Neki refusing a statement.
 * A connection cut under a statement needs a real server: see
 * `postgres-failure-facts-docker.test.ts`.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { VibORMErrorCode } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import { afterEach, expect, test } from "vitest";

const v1 = {
  account: s
    .model({ id: s.string().id(), email: s.string() })
    .map("mff_account"),
};
const v2 = {
  account: s
    .model({
      id: s.string().id(),
      email: s.string(),
      name: s.string().nullable(),
    })
    .map("mff_account"),
};
const diagnostics = {
  diagnostics: { includeProviderDetails: true, includeSql: true },
} as const;

const drivers: PGliteDriver[] = [];
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.disconnect()));
});

/** Neki's refusal of every `tag` statement, as its own SQLSTATE class. */
async function refuse(driver: PGliteDriver, tag: string): Promise<void> {
  await driver._executeRaw(`
    CREATE FUNCTION mff_refuse() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'neki refused %', tg_tag USING ERRCODE = 'NK013'; END $$`);
  await driver._executeRaw(
    `CREATE EVENT TRIGGER mff_refuse ON ddl_command_start WHEN TAG IN ('${tag}') EXECUTE FUNCTION mff_refuse()`
  );
}

/** Every message down the cause chain, outermost first. */
function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let link = (error as { cause?: unknown }).cause;
  while (link instanceof Error) {
    messages.push(link.message);
    link = link.cause;
  }
  return messages;
}

async function applied(withDiagnostics: boolean) {
  const driver = new PGliteDriver();
  drivers.push(driver);
  const storage = new MemoryEstateStorage();
  const client = (schema: typeof v1 | typeof v2) => {
    const base = createClient({ schema, driver });
    return withDiagnostics ? base.$extends(instrumentation(diagnostics)) : base;
  };
  const first = createMigrationClient(client(v1), { storage });
  const root = (await first.generate({ name: "root" })).stateId!;
  await first.apply();
  return { driver, storage, client, root };
}

test("an apply statement Neki refuses is a located MigrationError carrying NK013, disclosed per the client's diagnostics", async () => {
  for (const withDiagnostics of [false, true]) {
    const { driver, storage, client } = await applied(withDiagnostics);
    const migrations = createMigrationClient(client(v2), { storage });
    const next = (await migrations.generate({ name: "add-name" })).stateId!;
    await refuse(driver, "ALTER TABLE");

    const failure = await migrations.apply().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toMatchObject({
      name: "MigrationError",
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: {
        step: "apply",
        stateId: next,
        toState: next,
        statementIndex: 0,
        strategy: expect.any(String),
        providerCode: "NK013",
      },
    });
    const messages = causeMessages(failure).join(" | ");
    if (withDiagnostics) {
      expect(messages).toContain("neki refused ALTER TABLE");
    } else {
      expect(messages).not.toContain("neki refused");
    }
  }
});

test("a reset whose clear Neki refuses names the clear statement and its target, disclosed per the client's diagnostics", async () => {
  for (const withDiagnostics of [false, true]) {
    const { driver, client } = await applied(withDiagnostics);
    // A fresh history the database's marker is not part of.
    const fresh = createMigrationClient(client(v2), {
      storage: new MemoryEstateStorage(),
    });
    const target = (await fresh.generate({ name: "fresh-root" })).stateId!;
    await refuse(driver, "DROP TABLE");

    const failure = await fresh.reset().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toMatchObject({
      name: "MigrationError",
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: {
        step: "reset-clear",
        stateId: target,
        statementIndex: expect.any(Number),
        strategy: "transactional",
        providerCode: "NK013",
      },
    });
    const messages = causeMessages(failure).join(" | ");
    if (withDiagnostics) {
      expect(messages).toContain("neki refused DROP TABLE");
    } else {
      expect(messages).not.toContain("neki refused");
    }
  }
});

test("a replayed reset statement that fails names its step, edge and statement", async () => {
  const { driver, client } = await applied(false);
  const fresh = createMigrationClient(client(v2), {
    storage: new MemoryEstateStorage(),
  });
  const target = (await fresh.generate({ name: "fresh-root" })).stateId!;
  await refuse(driver, "CREATE TABLE");

  await expect(fresh.reset()).rejects.toMatchObject({
    name: "MigrationError",
    code: VibORMErrorCode.MIGRATION_FAILED,
    meta: {
      step: "reset-replay",
      stateId: target,
      toState: target,
      statementIndex: 0,
      providerCode: "NK013",
    },
  });
});
