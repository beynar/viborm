import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";

import {
  producedFieldSchema,
  registerProducedFieldBehavior,
  registerTwoSequenceBehavior,
  twoSequenceSchema,
} from "@tests/contracts/engine/write/fresh-produced-field-behavior";
import { afterAll, describe } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * Package F on the live servers, and MySQL is the leg that matters: mysql2 has no
 * `RETURNING`, so every produced non-primary column here travels the F3 path — the
 * INSERT, then ONE focused read of that column by the created-row selector, inside the
 * same transaction. PGlite proves the F2 shape compiles and executes; only a real MySQL
 * connection proves the focused read finds the row the INSERT just made.
 *
 * SCHEMA PER PROVIDER, not one schema for both. `twoSequenceSchema` needs two
 * auto-increment columns in one table and MySQL rejects that DDL outright
 * (`ER_WRONG_AUTO_KEY`), so it is pushed on PostgreSQL alone. Its consequence is worth
 * stating because it bounds what this file can prove: the created-row selector of F3's
 * focused read is always the record's own primary key on a live MySQL server, never the
 * `insertId` — a record with a generated key AND another produced column is the table
 * MySQL will not create. The `insertId` arm is pinned structurally in
 * `fresh-produced-field.test.ts` and is unreachable on every provider this repo ships.
 *
 * Requires the Docker test databases:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;

// Children before parents, so a re-run never asks `syncLiveSchema(force)` to re-shape an index a
// live foreign key still needs.
const PRODUCED_TABLES = [
  "pkgf_crates",
  "pkgf_bins",
  "pkgf_latches",
  "pkgf_seals",
  "pkgf_depots",
];
const TWO_SEQUENCE_TABLES = [
  "pkgf_spans",
  "pkgf_marks",
  "pkgf_tabs",
  "pkgf_cogs",
  "pkgf_hubs",
  "pkgf_knobs",
];

function connector(
  schema: Record<string, unknown>,
  tables: readonly string[],
  makeDriver: () => any
): { connect: () => Promise<any>; close: () => Promise<void> } {
  let shared: any;
  return {
    connect: async () => {
      if (!shared) {
        shared = createClient({ schema, driver: makeDriver() } as any) as any;
        for (const table of tables) {
          await shared.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
        }
        await syncLiveSchema(shared);
      }
      return shared;
    },
    close: async () => {
      await shared?.$disconnect();
    },
  };
}

const mysql = connector(
  producedFieldSchema,
  PRODUCED_TABLES,
  () => new MySQL2Driver({ databaseUrl: MYSQL as string })
);
registerProducedFieldBehavior(
  "Docker MySQL",
  mysql.connect,
  MYSQL ? describe : describe.skip
);

// ONE PostgreSQL client for BOTH registrations, over the union of the two schemas.
// `push` drops what the pushed schema does not declare, so two clients against one
// database would leave whichever pushed last holding the tables — passing only by the
// order the suites happen to run in. MySQL needs no union: it never sees the
// two-sequence half.
const pg = connector(
  { ...producedFieldSchema, ...twoSequenceSchema },
  [...PRODUCED_TABLES, ...TWO_SEQUENCE_TABLES],
  () => new PgDriver({ databaseUrl: PG as string })
);
registerProducedFieldBehavior(
  "Docker PostgreSQL",
  pg.connect,
  PG ? describe : describe.skip
);
registerTwoSequenceBehavior(
  "Docker PostgreSQL",
  pg.connect,
  PG ? describe : describe.skip
);

afterAll(async () => {
  await mysql.close();
  await pg.close();
});
