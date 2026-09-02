import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";

import {
  producedIdentitySchema,
  registerProducedIdentityBehavior,
} from "@tests/contracts/engine/write/junction-produced-identity-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, describe } from "vitest";

/**
 * E4-U3 on the live servers.
 *
 * MySQL is the leg the produced identity has to survive: mysql2 has no `RETURNING`, so
 * the subtree's root INSERT publishes its key as `insertId` and the join row reads it
 * from the adapter's per-step scratch store — `LAST_INSERT_ID` threading, once per
 * producing statement. The multi-entry array is what makes that a measurement rather
 * than a shape: two generated keys in one operation, each join row and each grandchild
 * addressing the INSERT that made its own row.
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
  registerProducedIdentityBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: producedIdentitySchema,
          driver: makeDriver(),
        }) as any;
        // Children before parents, so a re-run never asks `syncLiveSchema(force)` to re-shape an
        // index a live foreign key still needs.
        for (const table of ["e4u3_notes", "e4u3_posts", "e4u3_stamps"]) {
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
