import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";

import { afterAll, describe } from "vitest";
import {
  producedCompoundSchema,
  registerProducedCompoundBehavior,
} from "@tests/contracts/engine/write/produced-compound-identity-behavior";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
/**
 * E6.2 on the live servers.
 *
 * MySQL is the load-bearing leg: mysql2 has no `RETURNING`, so the create arm's
 * generated member always travels as `insertId` — the same wire the atomic batch
 * uses. If the union of the captured member and the spelled literal were wrong,
 * this is the leg that would answer with a decoy rather than fail loudly.
 *
 * SQLite is out of reach by DDL, not by engine behavior: SQLite generates a key
 * only for a single `INTEGER PRIMARY KEY`, so a compound key with a generated
 * member has no table to live in there.
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
  registerProducedCompoundBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: producedCompoundSchema,
          driver: makeDriver(),
        }) as any;
        await shared.$executeRawUnsafe("DROP TABLE IF EXISTS e62_tickets");
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
