import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import { afterAll, describe } from "vitest";
import {
  junctionUpsertArmSchema,
  registerJunctionUpsertArmProbeBehavior,
} from "./junction-upsert-arm-probe-behavior";

/**
 * U-E6.1 on the live servers.
 *
 * The wiring is dialect-blind — a `planned` source is a step reference, not SQL — so
 * these legs are not here to catch a spelling. They are here because the arm's key is an
 * AUTO-INCREMENT `int`, and the two servers produce and return that key differently
 * (`RETURNING` on PostgreSQL, `insertId` on MySQL). A witness that only ever ran on
 * PGlite would not have exercised the MySQL capture at all.
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
  registerJunctionUpsertArmProbeBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: junctionUpsertArmSchema,
          driver: makeDriver(),
        }) as any;
        // Children before parents, so a re-run never asks `push(force)` to re-shape an
        // index a live foreign key still needs.
        for (const table of [
          "tag_user",
          "e61_notes",
          "e61_tags",
          "e61_users",
          "e61_owners",
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
