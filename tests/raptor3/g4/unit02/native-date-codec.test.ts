/**
 * G4-02 native probe — the PostgreSQL `date` codec, on a driver-owned pool.
 *
 * The first native run of the witness suite `g4-read-envelope-pg-contracts`
 * reported `Driver "pg" returned a malformed date scalar … the Date is invalid
 * or not UTC midnight`. This probe separates the two candidate explanations:
 *
 *  - the candidate's `date` leaf is wrong on PostgreSQL, or
 *  - the fixture's own `pg.Pool` (built at
 *    `tests/raptor3/transitions/live-world.ts:363`) bypasses the driver's
 *    `utcSafeTypes` parser override (`src/drivers/pg/index.ts:46-60`), so DATE
 *    arrives as a process-local `Date` for BOTH engines.
 *
 * It reads the same column through the SHIPPED client and the candidate on a
 * driver-owned pool, and asserts they agree.
 *
 * Registered as `g4-unit02-native-date` and skipped unless
 * `VIBORM_RAPTOR3_PROVIDER=pg` names a live provider.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

describe.runIf(provider === "pg" && port > 0)(
  "G4-02 native PostgreSQL date codec",
  () => {
    it("decodes a DATE column identically on the shipped and candidate engines", async () => {
      const table = `g4u2_dates_${randomUUID().replaceAll("-", "")}`;
      const day = s.model({ id: s.int().id(), at: s.date() }).map(table);
      const schema = { day };
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
      const client = createClient({ schema, driver });
      try {
        await driver._executeRaw(
          `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, at DATE NOT NULL)`
        );
        await driver._executeRaw(
          `INSERT INTO ${table} (id, at) VALUES (1, DATE '2026-03-05')`
        );
        const shipped = await client.day.findMany({ orderBy: { id: "asc" } });
        const candidate = await createCommandEngine({ schema, driver }).execute(
          "day",
          "findMany",
          { orderBy: { id: "asc" } }
        );
        assert.deepEqual(candidate, shipped);
        assert.deepEqual(shipped, [
          { id: 1, at: new Date("2026-03-05T00:00:00.000Z") },
        ]);
      } finally {
        await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
        await client.$disconnect();
      }
    });
  }
);
