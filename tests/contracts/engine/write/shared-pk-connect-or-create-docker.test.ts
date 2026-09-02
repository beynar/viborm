import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import {
  registerSharedPkConnectOrCreateBehavior,
  sharedPkConnectOrCreateSchema,
} from "@tests/contracts/engine/write/shared-pk-connect-or-create-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, describe } from "vitest";

/**
 * E6.3 on the live servers.
 *
 * MySQL matters twice. It has no `RETURNING`, so nothing about this absorption may
 * depend on one — and nothing does: the shared key is a COMPILE-KNOWN literal, which is
 * why the terminal read addresses the created row on a driver that publishes only
 * `insertId`. And its default collation is case-INSENSITIVE, which is the plan's
 * collation-divergence rule: the probe reads the target by the `where`, the record's
 * foreign key (and therefore its identity) is that same `where` literal, so probe and
 * constraint must agree about what "the same key" means. The test below measures that
 * agreement per dialect rather than assuming it.
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
  const connect = async () => {
    if (!shared) {
      shared = createClient({
        schema: sharedPkConnectOrCreateSchema,
        driver: makeDriver(),
      }) as any;
      // Children before parents, so a re-run never asks `syncLiveSchema(force)` to re-shape an
      // index a live foreign key still needs.
      for (const table of ["e63_profiles", "e63_users"]) {
        await shared.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
      }
      await syncLiveSchema(shared);
    }
    return shared;
  };
  registerSharedPkConnectOrCreateBehavior(
    name,
    connect,
    enabled ? describe : describe.skip
  );

  // The collation probe the plan's rule asks for lives in the BEHAVIOR module, so it
  // runs on every leg this fixture reaches — PGlite (both substrates), better-sqlite3,
  // and the two servers below — instead of only on the servers.
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
