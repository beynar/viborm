import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import {
  compileTransitionSchema,
  registerCompileTransitionBehavior,
} from "@tests/contracts/engine/write/compiled-key-transition-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, describe } from "vitest";

/**
 * E6.7 on the live servers.
 *
 * This is where the JS==SQL claim stops being an assertion about arithmetic and becomes
 * one about a database. The root SET runs `id = id + 5` IN SQL while the child INSERT
 * binds a number JS computed at compile, and a real foreign key is watching: if the two
 * derivations ever disagreed the INSERT raises a constraint violation rather than landing
 * quietly on a wrong row. MySQL matters twice over — its own integer semantics, and a
 * `NO ACTION` foreign key it enforces itself.
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
  // ONE push per suite; each test resets by DELETE (`resetCompileTransition`).
  let shared: any;
  registerCompileTransitionBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: compileTransitionSchema,
          driver: makeDriver(),
        }) as any;
        for (const table of [
          "e67_seats",
          "e67_orgs",
          "e67_spots",
          "e67_zones",
          "e67_ticks",
          "e67_counters",
          "e67_pads",
          "e67_bays",
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
