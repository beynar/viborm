/**
 * platform-06: push never renames a table it cannot prove is this schema's.
 *
 * A history-free push pairs every dropped live table with every new model
 * table and asks the resolver. Before 1.0.1 the shipped `lenientResolver` and
 * the documented config resolver answered `rename()` for every pair, and the
 * plan was labelled non-destructive, so a populated table of another
 * application became the new model's table with no consent. Now a table pair
 * is renamed only by a resolver naming it, a table rename always needs the
 * preview's exact consent, and a scoped push creates the model beside the
 * foreign table without seeing it.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { lenientResolver } from "@src/migrations/resolver";
import type { ResolveCallback } from "@src/migrations/types";
import type { AnyModel } from "@src/schema/model";
import { describe, expect, test } from "vitest";

const ROWS = 10_000;

const fields = {
  id: s.string().id(),
  email: s.string(),
  name: s.string(),
  role: s.string(),
  loginCount: s.int(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};
const users = s.model(fields).map("users");
const accounts = s.model(fields).map("accounts");

/** The push docs' resolver: columns rename, a table only by its named pair. */
const docsResolver: ResolveCallback = (change) => {
  if (change.type === "ambiguous" && change.operation === "renameColumn")
    return change.rename();
  if (
    change.type === "ambiguous" &&
    change.oldName === "users" &&
    change.newName === "accounts"
  )
    return change.rename();
  return change.reject();
};

/** The pre-1.0.1 documented resolver: rename whatever pair is offered. */
const renameEveryPair: ResolveCallback = (change) =>
  change.type === "ambiguous" ? change.rename() : change.reject();

const providers = [
  {
    name: "sqlite3",
    open: (): AnyDriver => new SQLite3Driver({ dataDir: ":memory:" }),
    series: (select: string) =>
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) ${select} FROM n`,
    instant: "'2026-01-01T00:00:00.000Z'",
  },
  {
    name: "pglite",
    open: (): AnyDriver => new PGliteDriver(),
    series: (select: string) =>
      `${select} FROM generate_series(1, ${ROWS}) AS n(i)`,
    instant: "'2026-01-01T00:00:00Z'::timestamptz",
  },
] as const;

describe.each(providers)("$name push and table renames", (provider) => {
  async function withDatabase(
    run: (driver: AnyDriver) => Promise<void>
  ): Promise<void> {
    const driver = provider.open();
    try {
      await run(driver);
    } finally {
      await driver.disconnect();
    }
  }

  const migrationsFor = (
    driver: AnyDriver,
    schema: Record<string, AnyModel>,
    tables?: readonly string[]
  ) => {
    const client = createClient({ schema, driver });
    return tables
      ? createMigrationClient(client, { tables })
      : createMigrationClient(client);
  };

  async function contents(driver: AnyDriver, table: string) {
    const { rows } = await driver._executeRaw<{ c: unknown; s: unknown }>(
      `SELECT count(*) AS c, sum(length("email")) AS s FROM "${table}"`
    );
    return { rows: Number(rows[0]?.c), checksum: Number(rows[0]?.s) };
  }

  test("a foreign table is never paired into a new model without a named pair", async () => {
    await withDatabase(async (driver) => {
      await driver._executeRaw(
        `CREATE TABLE "billing_invoices" ("id" INTEGER PRIMARY KEY, "email" TEXT NOT NULL, "amount_cents" INTEGER NOT NULL)`
      );
      await driver._executeRaw(
        provider.series(
          `INSERT INTO "billing_invoices" SELECT i, 'payer' || i || '@corp.example', i * 7`
        )
      );
      const foreign = await contents(driver, "billing_invoices");
      expect(foreign.rows).toBe(ROWS);

      const unscoped = migrationsFor(driver, { users });
      for (const resolve of [lenientResolver, docsResolver]) {
        await expect(
          unscoped.push({ dryRun: true, resolve })
        ).rejects.toMatchObject({
          code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
          message: expect.stringContaining(
            'Table "billing_invoices" → "users"'
          ),
        });
      }

      expect(await contents(driver, "billing_invoices")).toEqual(foreign);
      await expect(contents(driver, "users")).rejects.toThrow();

      // The shared-database route: scope the push to the schema's tables.
      const scoped = migrationsFor(driver, { users }, ["users"]);
      const created = await scoped.push({ resolve: lenientResolver });
      expect(created.outcome).toBe("applied");
      expect(created.operations.map((operation) => operation.label)).toEqual([
        '+ Create table "users" with 7 columns',
      ]);
      expect((await scoped.push({ resolve: docsResolver })).outcome).toBe(
        "noop"
      );
      expect(await contents(driver, "billing_invoices")).toEqual(foreign);
      expect(await contents(driver, "users")).toEqual({
        rows: 0,
        checksum: 0,
      });
    });
  });

  test("a named pair renames a populated table through exact consent", async () => {
    await withDatabase(async (driver) => {
      await migrationsFor(driver, { users }).push();
      await driver._executeRaw(
        provider.series(
          `INSERT INTO "users" ("id", "email", "name", "role", "loginCount", "createdAt", "updatedAt") SELECT 'u' || i, 'user' || i || '@app.example', 'User ' || i, 'member', i, ${provider.instant}, ${provider.instant}`
        )
      );
      const before = await contents(driver, "users");
      expect(before.rows).toBe(ROWS);

      const migrations = migrationsFor(driver, { accounts });
      await expect(
        migrations.push({ dryRun: true, resolve: lenientResolver })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      });
      // Whoever decides the rename, it is never a silent, additive plan.
      for (const resolve of [renameEveryPair, docsResolver]) {
        const planned = await migrations.push({ dryRun: true, resolve });
        expect(planned.destructive).toBe(true);
        expect(planned.operations).toMatchObject([
          { label: '~ Rename table "users" → "accounts"', risk: "destructive" },
        ]);
        await expect(migrations.push({ resolve })).rejects.toMatchObject({
          code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
        });
      }
      const preview = await migrations.push({
        dryRun: true,
        resolve: docsResolver,
      });

      expect(
        (await migrations.push({ consent: preview.consent })).outcome
      ).toBe("applied");
      expect(await contents(driver, "accounts")).toEqual(before);
      await expect(contents(driver, "users")).rejects.toThrow();
    });
  });
});
