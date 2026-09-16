/**
 * G4-02 native probe — the updated key, named on the real non-RETURNING
 * provider.
 *
 * `key-arithmetic.test.ts` runs the same comparison on a SQLite driver with
 * `supportsReturning` forced off, which is MySQL's capability but not MySQL's
 * arithmetic: MySQL `/` yields a DECIMAL quotient even for two integers, so it
 * is the one provider where the readback's name and the `SET` clause could
 * disagree about `7 / 2`. That is the provider fact
 * `expressions.integerDivide` was added for, and this is the cell that
 * measures it end to end.
 *
 * Skipped unless `VIBORM_RAPTOR3_PROVIDER=mysql` names a live provider; the
 * container and port used for a run are recorded in the receipt beside it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 native MySQL key arithmetic",
  () => {
    for (const [name, data, expected] of [
      ["multiply", { multiply: 3 }, 21],
      ["divide with a non-exact quotient", { divide: 2 }, 3],
      ["divide with an exact quotient", { divide: 7 }, 1],
      ["increment", { increment: 5 }, 12],
      ["decrement", { decrement: 5 }, 2],
    ] as const) {
      it(`names an int key under ${name} identically on the client route seam and the command engine`, async () => {
        const table = `g4u2_keys_${randomUUID().replaceAll("-", "")}`;
        const row = s.model({ id: s.int().id(), label: s.string() }).map(table);
        const schema = { row };
        const driver = new MySQL2Driver({
          options: {
            host: "127.0.0.1",
            port,
            database: "raptor3_g2",
            user: "root",
            password: "",
            connectionLimit: 1,
            connectTimeout: 10_000,
          },
        });
        const client = createClient({ schema, driver });
        try {
          assert.equal(driver.adapter.capabilities.supportsReturning, false);
          await driver._executeRaw(
            `CREATE TABLE ${table} (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)`
          );
          const seed = `INSERT INTO ${table} (id, label) VALUES (7, 'a')`;
          await driver._executeRaw(seed);
          const shipped = await client.row.update({
            where: { id: 7 },
            data: { id: data },
          });
          await driver._executeRaw(`DELETE FROM ${table}`);
          await driver._executeRaw(seed);
          const candidate = await createCommandEngine({
            schema,
            driver,
          }).execute("row", "update", { where: { id: 7 }, data: { id: data } });
          assert.deepEqual(candidate, shipped);
          assert.deepEqual(shipped, { id: expected, label: "a" });
          const rows = await driver._executeRaw<{ id: number }>(
            `SELECT id FROM ${table}`
          );
          assert.deepEqual(
            rows.rows.map((entry) => Number(entry.id)),
            [expected]
          );
        } finally {
          await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
          await client.$disconnect();
        }
      });
    }
  }
);
