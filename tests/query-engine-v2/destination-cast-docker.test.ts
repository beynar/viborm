import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import { afterAll, describe } from "vitest";
import {
  destinationCastSchema,
  registerDestinationCastBehavior,
} from "./destination-cast-behavior";

/**
 * U-E6.0 on the live servers — the two that answered, in their own words, the two
 * halves of the defect:
 *
 *   PostgreSQL  42804  column "atRef" is of type timestamp with time zone
 *                      but expression is of type text
 *   MySQL       ER_TRUNCATED_WRONG_VALUE
 *                      Incorrect datetime value: '2020-01-01T00:00:00.000Z'
 *
 * PGlite reproduces the cast half. Only MySQL reproduces the spelling half, so this
 * leg is not decoration: drop `literals.dateTime` from `referenceSql` and every local
 * substrate stays green while MySQL fails.
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
  registerDestinationCastBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: destinationCastSchema,
          driver: makeDriver(),
        }) as any;
        // Children before parents, so a re-run never asks `push(force)` to re-shape an
        // index a live foreign key still needs.
        for (const table of [
          "e60_entries",
          "e60_ticks",
          "e60_files",
          "e60_slots",
          "e60_counters",
          "e60_folders",
        ]) {
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
