/**
 * G4-02 phase-2 review FOLLOW-UP — `expressions.integerDivide` on PostgreSQL,
 * end to end.
 *
 * Round 3's note records as UNVERIFIED (§R2.10 item 5) that the PostgreSQL arm
 * of the new seam is measured only through the dialect contract test's rendered
 * SQL, "because PostgreSQL supports RETURNING and so `updatedIdentity` never
 * needs a name there. No cell exercises a PostgreSQL provider with
 * supportsReturning forced off."
 *
 * This cell does exactly that: a real PostgreSQL provider whose adapter
 * capability is forced to MySQL's, so the readback must NAME the updated key,
 * compared against the shipped engine on the same driver.
 *
 * Skipped unless `VIBORM_RAPTOR3_PROVIDER=pg` names a live provider.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

describe.runIf(provider === "pg" && port > 0)(
  "G4-02 review follow-up — native PostgreSQL, RETURNING forced off",
  () => {
    for (const [name, data, expected] of [
      ["multiply", { multiply: 3 }, 21],
      ["divide with a non-exact quotient", { divide: 2 }, 3],
      ["divide with an exact quotient", { divide: 7 }, 1],
    ] as const) {
      it(`names an int key under ${name} exactly as the shipped engine does`, async () => {
        const table = `r3f_pg_${randomUUID().replaceAll("-", "")}`;
        const row = s.model({ id: s.int().id(), label: s.string() }).map(table);
        const schema = { row };
        const driver = new PgDriver({
          options: {
            host: "127.0.0.1",
            port,
            database: "raptor3_g2",
            user: "postgres",
            password: "",
            ssl: false,
            max: 1,
            connectionTimeoutMillis: 10_000,
          },
        });
        driver.adapter.capabilities.supportsReturning = false;
        const client = createClient({ schema, driver });
        try {
          await driver._executeRaw(
            `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`
          );
          await driver._executeRaw(
            `INSERT INTO ${table} (id, label) VALUES (7, 'a')`
          );
          const shipped = await client.row.update({
            where: { id: 7 },
            data: { id: data },
          });
          const shippedRows = await driver._executeRaw(
            `SELECT id, label FROM ${table}`
          );
          await driver._executeRaw(`DELETE FROM ${table}`);
          await driver._executeRaw(
            `INSERT INTO ${table} (id, label) VALUES (7, 'a')`
          );
          const candidate = await createCommandEngine({
            schema,
            driver,
          }).execute("row", "update", { where: { id: 7 }, data: { id: data } });
          const candidateRows = await driver._executeRaw(
            `SELECT id, label FROM ${table}`
          );
          assert.deepEqual(candidate, shipped);
          assert.deepEqual(shipped, { id: expected, label: "a" });
          assert.deepEqual(candidateRows.rows, shippedRows.rows);
        } finally {
          await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
          await client.$disconnect();
        }
      });
    }
  }
);
