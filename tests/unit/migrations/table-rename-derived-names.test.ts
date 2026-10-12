/**
 * A table rename carries the names the serializer derived from the table
 * (PostgreSQL, PGlite): `<table>_<rest>` becomes `<new table>_<rest>`, where
 * the rest is whatever the serializer put there — SQL columns, TypeScript
 * field names, or a compound key's name. A name the schema sets itself stays.
 *
 * The estate is realistic: mapped snake_case columns, a compound unique over
 * them, a named compound unique, a unique and a plain index over mapped
 * fields, a per-column enum, a foreign key and its index, 2,000 rows. The
 * rename is one `renameTable` and no rebuild, the rows stay, push finds
 * nothing left to do, and `down` restores every name.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { createMigrationClient, createPredefinedResolver } from "@migrations";
import { s } from "@schema";
import type { AnyModel } from "@src/schema/model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const ROWS = 2000;

function schemaAt(table: string): Record<string, AnyModel> {
  const account: AnyModel = s
    .model({
      id: s.string().id(),
      email: s.string().map("email_address"),
      firstName: s.string().map("first_name"),
      lastName: s.string().map("last_name"),
      nickname: s.string().unique(),
      handle: s.string(),
      country: s.string().map("country_code"),
      status: s.enum(["trial", "active"]).default("trial"),
      teamId: s.string().nullable().map("team_id"),
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
    })
    .unique(["firstName", "lastName"])
    .unique(["handle", "country"], { name: "handlePerCountry" })
    .index(["email"], { unique: true })
    .index(["country"])
    .index(["handle"], { name: "by_handle" })
    .map(table);
  const team: AnyModel = s
    .model({
      id: s.string().id(),
      name: s.string(),
      accounts: s.toMany(() => account),
    })
    .map("teams");
  return { team, account };
}

/** The names a fresh `<table>` declares, spelled as the serializer does. */
const declaredNames = (table: string) =>
  [
    "by_handle",
    `${table}_country_idx`,
    `${table}_email_idx`,
    `${table}_firstName_lastName_key`,
    `${table}_handlePerCountry_key`,
    `${table}_nickname_key`,
    `${table}_pkey`,
    `${table}_status_enum`,
    `${table}_team_id_fkey`,
    `${table}_team_id_idx`,
    "teams_pkey",
  ].sort();

describe("renaming a PostgreSQL table with derived names", () => {
  const driver = new PGliteDriver();
  const storage = new MemoryStorage();
  const migrationsAt = (table: string) =>
    createMigrationClient(createClient({ driver, schema: schemaAt(table) }), {
      storage,
    });

  async function physicalNames(): Promise<string[]> {
    const { rows } = await driver._executeRaw<{ name: string }>(
      `SELECT name FROM (
         SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'i'
         UNION SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype <> 'n'
         UNION SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
       ) AS names WHERE name NOT LIKE '\\_viborm\\_%' ORDER BY 1`
    );
    return rows.map(({ name }) => name);
  }

  beforeAll(async () => {
    const first = migrationsAt("accounts");
    await first.generate({ name: "accounts" });
    await first.apply();
    await driver._executeRaw(`INSERT INTO "teams" VALUES ('t1', 'one')`);
    await driver._executeRaw(
      `INSERT INTO "accounts" ("id", "email_address", "first_name", "last_name", "nickname", "handle", "country_code", "team_id")
       SELECT 'a' || g, 'u' || g || '@example.com', 'f' || g, 'l' || g, 'n' || g, 'h' || g, 'FR', 't1'
       FROM generate_series(1, ${ROWS}) g`
    );
  });
  afterAll(() => driver.disconnect());

  it("moves every derived name in one renameTable, and down restores them", async () => {
    expect(await physicalNames()).toEqual(declaredNames("accounts"));
    const renamed = migrationsAt("customers");
    const generated = await renamed.generate({
      name: "customers",
      resolve: createPredefinedResolver([
        {
          type: "table",
          from: "accounts",
          to: "customers",
          resolution: "rename",
        },
      ]),
    });
    expect(generated.operations.map(({ type }) => type)).toEqual([
      "renameTable",
    ]);

    await expect(renamed.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await physicalNames()).toEqual(declaredNames("customers"));
    const counted = await driver._executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM "customers" WHERE "team_id" = 't1'`
    );
    expect(counted.rows).toEqual([{ n: ROWS }]);
    await expect(
      createMigrationClient(
        createClient({ driver, schema: schemaAt("customers") })
      ).push({ dryRun: true })
    ).resolves.toMatchObject({ operations: [] });

    await renamed.down();
    expect(await physicalNames()).toEqual(declaredNames("accounts"));
  });
});
