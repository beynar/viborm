import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";

import { afterAll, describe } from "vitest";
import {
  registerSqlOperandWallBehavior,
  sqlOperandWallSchema,
} from "@tests/contracts/engine/write/sql-operand-boundary-behavior";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
/**
 * E6.6 on the live servers.
 *
 * mysql2 is the leg the plan singled out to STAY refused — no `RETURNING`, and an
 * `insertId` that is increment-only, so nothing there could ever capture a once-evaluated
 * expression. It does stay refused, and this file records that it does so for the SAME
 * reason as every other leg rather than for that one: the parse boundary declines the
 * `Sql` operand before a driver is consulted, so the refusal is driver-independent and
 * the plan's per-driver split never becomes observable. PostgreSQL — a returning driver,
 * where the plan's transaction-substrate absorption WOULD have landed — is here to make
 * that the same measurement rather than an argument.
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
  registerSqlOperandWallBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: sqlOperandWallSchema,
          driver: makeDriver(),
        }) as any;
        for (const table of ["e66_tags", "e66_slots", "e66_counters"]) {
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
