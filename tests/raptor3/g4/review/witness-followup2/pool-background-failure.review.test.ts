/**
 * Independent review probe, repair round 2 — does `watchPgPool` have a falsifier?
 *
 * `note.md` §15.6 repairs review note 6 by subscribing the FIXTURE to the
 * PostgreSQL pool it borrows (`tests/raptor3/transitions/live-world.ts`,
 * `watchPgPool`), filing a background failure where a body failure is filed so
 * `assertHealthy()` surfaces it, and rethrowing it at teardown when nothing
 * else failed. §15.11 claim 3 labels as UNVERIFIED that the listener "would
 * actually surface a real background pool failure": no background failure was
 * provoked.
 *
 * This cell provokes one. It uses the same pool construction the fixture uses
 * (a `PgDriver` subclass that returns its own built pool) and the same
 * subscription shape (`pool.on("error", …)`), then terminates the idle backend
 * from a second connection. If the mechanism the repair relies on did not
 * deliver, this cell fails.
 *
 * Run with `VIBORM_RAPTOR3_PROVIDER=pg` and
 * `VIBORM_RAPTOR3_PROVIDER_PORT=<port>`.
 */
import assert from "node:assert/strict";
import { PgDriver } from "@drivers/pg";
import { Pool as PgPool } from "pg";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT);
const pgOptions = {
  host: "127.0.0.1",
  port,
  database: "raptor3_g2",
  password: "",
  user: "postgres",
  ssl: false as const,
  max: 1,
  connectionTimeoutMillis: 10_000,
};

class PgFactory extends PgDriver {
  own(): Promise<PgPool> {
    return this.getClient() as Promise<PgPool>;
  }
}

describe.skipIf(provider !== "pg")(
  "review probe: a provoked background pool failure",
  () => {
    it("reaches a fixture-shaped pool.on('error') subscriber", async () => {
      const pool = await new PgFactory({ options: pgOptions }).own();
      // Exactly the subscription `watchPgPool` installs.
      const filed: unknown[] = [];
      pool.on("error", (failure) => filed.push(failure));
      const killer = new PgPool({ ...pgOptions, max: 1 });
      try {
        const client = await pool.connect();
        const pid = (await client.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid as number;
        // Idle in the pool: node-postgres reports its death on the POOL.
        client.release();
        await killer.query("SELECT pg_terminate_backend($1)", [pid]);
        for (let waited = 0; waited < 50 && filed.length === 0; waited += 1)
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          filed.length >= 1,
          true,
          "a terminated idle backend never reached the pool's error listener"
        );
      } finally {
        await Promise.allSettled([pool.end(), killer.end()]);
      }
    }, 30_000);
  }
);
