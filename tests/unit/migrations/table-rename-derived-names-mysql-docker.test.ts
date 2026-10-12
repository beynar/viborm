/**
 * A table rename carries the names the serializer derived from the table on
 * MySQL too, through the rule PostgreSQL uses: an index or unique (one object
 * on MySQL) is renamed with `RENAME INDEX`, and a foreign key, which MySQL
 * cannot rename, is dropped and added under its new name in the same
 * statement. A name the schema sets itself stays.
 *
 * The estate mirrors `table-rename-derived-names.test.ts`: mapped columns, a
 * compound unique over them, a named compound unique, a unique and a plain
 * index over mapped fields, a foreign key and its index, 2,000 rows.
 *
 * NOTE: requires a running MySQL (docker). Set MYSQL_TEST_CONNECTION_STRING.
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createMigrationClient, createPredefinedResolver } from "@migrations";
import { s } from "@schema";
import type { AnyModel } from "@src/schema/model";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING ?? "";
const describeIfMySQL = CONNECTION ? describe : describe.skip;

const DATABASE = "viborm_rename_names";
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
    "PRIMARY",
    "by_handle",
    `${table}_country_idx`,
    `${table}_email_idx`,
    `${table}_firstName_lastName_key`,
    `${table}_handlePerCountry_key`,
    `${table}_nickname_key`,
    `${table}_team_id_fkey`,
    `${table}_team_id_idx`,
  ].sort();

describeIfMySQL("renaming a MySQL table with derived names", () => {
  let pool: Pool;
  let admin: MySQL2Driver;
  const storage = new MemoryStorage();
  const clientAt = (table: string) =>
    createClient({
      schema: schemaAt(table),
      driver: new MySQL2Driver({
        pool,
        namespace: DATABASE,
        migrationNamespaceAttestation: "non-redirecting",
      }),
    });

  async function physicalNames(table: string): Promise<string[]> {
    const { rows } = await admin._executeRaw<{ name: string }>(
      `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       UNION SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [DATABASE, table, DATABASE, table]
    );
    return rows.map(({ name }) => name).sort();
  }

  beforeAll(async () => {
    pool = createPool(CONNECTION);
    admin = new MySQL2Driver({
      pool,
      migrationNamespaceAttestation: "non-redirecting",
    });
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await admin._executeRaw(`CREATE DATABASE \`${DATABASE}\``);
    const first = createMigrationClient(clientAt("accounts"), { storage });
    await first.generate({ name: "accounts" });
    await first.apply();
    await admin._executeRaw(
      `INSERT INTO \`${DATABASE}\`.\`teams\` VALUES ('t1', 'one')`
    );
    await admin._executeRaw(
      `INSERT INTO \`${DATABASE}\`.\`accounts\` (id, email_address, first_name, last_name, nickname, handle, country_code, team_id)
       WITH d (n) AS (SELECT 0 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9),
         g (n) AS (SELECT a.n + 10 * b.n + 100 * c.n + 1000 * e.n FROM d a, d b, d c, d e WHERE a.n + 10 * b.n + 100 * c.n + 1000 * e.n < ${ROWS})
       SELECT CONCAT('a', n), CONCAT('u', n, '@example.com'), CONCAT('f', n), CONCAT('l', n), CONCAT('n', n), CONCAT('h', n), 'FR', 't1' FROM g`
    );
  });
  afterAll(async () => {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await pool.end();
  });

  it("moves every derived name in one renameTable, and down restores them", async () => {
    expect(await physicalNames("accounts")).toEqual(declaredNames("accounts"));
    const renamed = createMigrationClient(clientAt("customers"), { storage });
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
    expect(await physicalNames("customers")).toEqual(
      declaredNames("customers")
    );
    const counted = await admin._executeRaw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${DATABASE}\`.\`customers\` WHERE team_id = 't1'`
    );
    expect(Number(counted.rows[0]?.n)).toBe(ROWS);
    await expect(
      createMigrationClient(clientAt("customers")).push({ dryRun: true })
    ).resolves.toMatchObject({ operations: [] });

    await renamed.down();
    expect(await physicalNames("accounts")).toEqual(declaredNames("accounts"));
  });
});
