import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import {
  createJunctionUpsertSchema,
  registerCreateJunctionUpsertBehavior,
} from "@tests/contracts/engine/write/create-junction-upsert-behavior";
import { afterAll, describe } from "vitest";

/**
 * E5-U1 on the live servers.
 *
 * MySQL is the leg that makes the produced identities a measurement rather than a
 * shape. Two of them are in flight at once here: the create root's OWN key (the join
 * row's parent value) and, on the absent arm, the adopted target's key (the join row's
 * target value and its grandchildren's foreign key). mysql2 has no `RETURNING`, so both
 * travel as `insertId` through the adapter's per-step scratch store — one identity per
 * producing statement, and a join row that read the wrong one would link the decoy.
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
  registerCreateJunctionUpsertBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: createJunctionUpsertSchema,
          driver: makeDriver(),
        }) as any;
        // Children before parents, so a re-run never asks `push(force)` to re-shape an
        // index a live foreign key still needs.
        for (const table of [
          "article_topic",
          "page_topic",
          "e5u1_notes",
          "e5u1_articles",
          "e5u1_pages",
          "e5u1_topics",
          "e5u1_authors",
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
