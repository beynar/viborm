import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";

import {
  registerUpdateManySeriesBehavior,
  updateManySeriesSchema,
} from "@tests/contracts/engine/write/update-many-relation-series-behavior";
import { afterAll, describe } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * Package K on the live servers.
 *
 * MySQL is the leg that matters, for two reasons that are specific to `updateMany`.
 * First, the COUNT: mysql2 reports `affectedRows` as CHANGED rows (nothing sets
 * `CLIENT_FOUND_ROWS`), so an assignment that changes nothing answers zero there and
 * N everywhere else — the divergence §5.2 cites when it makes `count` the captured
 * root count, and the only substrate on which "captured, not provider" is a visible
 * claim rather than a restatement. Second, there is no RETURNING: a member's read of
 * its own final row key is a second statement, and the series' whole promise — that
 * each member is an ORDINARY update, so whatever a single `update` does on a
 * substrate is what a bulk ROOT does — stays a claim until this leg runs it.
 *
 * PostgreSQL is the control: the same scenarios with `FOR UPDATE` row locks on the
 * capture and RETURNING available to the members.
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
  registerUpdateManySeriesBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: updateManySeriesSchema,
          driver: makeDriver(),
        }) as any;
        // Children before parents, so a re-run never asks `syncLiveSchema(force)` to re-shape an
        // index a live foreign key still needs. The m2m junction goes first of all.
        for (const table of [
          "kseries_bin_zone",
          "kseries_nodes",
          "kseries_tickets",
          "kseries_gadgets",
          "kseries_bins",
          "kseries_zones",
          "kseries_shelves",
        ]) {
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
