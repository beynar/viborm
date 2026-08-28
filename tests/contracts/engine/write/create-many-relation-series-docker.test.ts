import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";

import {
  createManySeriesSchema,
  registerCreateManySeriesBehavior,
} from "@tests/contracts/engine/write/create-many-relation-series-behavior";
import { afterAll, describe } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * Package J on the live servers.
 *
 * MySQL is the leg that matters. Two of the things a series member leans on have no
 * RETURNING to ride there: the produced author key reaches its dependants through
 * `LAST_INSERT_ID`, and the member's read of its own final row key is a second
 * statement rather than a clause. The series' whole promise — that each member is an
 * ORDINARY create, so whatever a single `create` does on a substrate is what a bulk
 * ROW does — stays a claim until this leg runs it.
 *
 * PostgreSQL is the control: the same scenarios where every identity comes back in the
 * INSERT's own RETURNING.
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
  registerCreateManySeriesBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: createManySeriesSchema,
          driver: makeDriver(),
        }) as any;
        // Children before parents, so a re-run never asks `syncLiveSchema(force)` to re-shape an
        // index a live foreign key still needs. The m2m junction goes first of all.
        for (const table of [
          "jseries_post_tag",
          "jseries_kind_records",
          "jseries_kind_owners",
          "jseries_attachments",
          "jseries_posts",
          "jseries_tags",
          "jseries_authors",
          "jseries_images",
          "jseries_clips",
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
