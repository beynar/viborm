import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import {
  registerVacateThenSupplyBehavior,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, describe } from "vitest";

/**
 * E6.5 on the live servers.
 *
 * The pair's whole mechanism is ORDER — the vacate's write must reach the database
 * before the supplier's — and the slot is a UNIQUE column, so a leg that reordered them
 * does not produce a subtly wrong state, it raises the child's unique violation. That
 * makes both servers a real test of the claim rather than a repetition of it: MySQL
 * enforces the unique index and has no `RETURNING`, so the `create` supplier's identity
 * travels differently there than on either PostgreSQL leg.
 *
 * Requires the Docker test databases:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;

function suite(
  name: string,
  makeDriver: () => any,
  enabled: string | undefined
): void {
  let shared: any;
  registerVacateThenSupplyBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: vacateThenSupplySchema,
          driver: makeDriver(),
        }) as any;
        for (const table of ["e65_badges", "e65_stations"]) {
          await shared.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
        }
        await syncLiveSchema(shared);
      }
      return shared;
    },
    enabled ? describe : describe.skip
  );
  afterAll(async () => {
    await shared?.$disconnect();
  });
}

suite(
  "Docker MySQL",
  () => new MySQL2Driver({ databaseUrl: MYSQL as string }),
  MYSQL
);
suite(
  "Docker PostgreSQL",
  () => new PgDriver({ databaseUrl: PG as string }),
  PG
);
