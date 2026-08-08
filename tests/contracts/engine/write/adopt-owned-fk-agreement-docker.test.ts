import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import { afterAll, describe } from "vitest";
import {
  adoptOwnedFkSchema,
  registerAdoptOwnedFkBehavior,
} from "@tests/contracts/engine/write/adopt-owned-fk-agreement-behavior";

/**
 * E5-U2 on the live servers. The agreement decision is made at construction, so what the
 * live legs add is the WRITE it lets through: the reparent must land the parent's own
 * key in the child's foreign-key column on each dialect's own type, and the decoy owner
 * must end up holding nothing.
 *
 * Requires the Docker test databases:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;

const TABLES = [
  "e5u2_notes",
  "e5u2_things",
  "e5u2_owners",
  "e5u2_items",
  "e5u2_gen_owners",
  "e5u2_kids",
  "e5u2_pairs",
  "e5u2_int_rows",
  "e5u2_int_owners",
  "e5u2_big_rows",
  "e5u2_big_owners",
  "e5u2_time_rows",
  "e5u2_time_owners",
  "e5u2_money_rows",
  "e5u2_money_owners",
];

function suite(
  name: string,
  makeDriver: () => any,
  enabled: string | undefined
): void {
  let shared: any;
  registerAdoptOwnedFkBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: adoptOwnedFkSchema,
          driver: makeDriver(),
        }) as any;
        for (const table of TABLES) {
          await shared.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
        }
        await push(shared, { force: true });
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
