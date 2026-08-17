import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "@tests/contracts/engine/write/compound-relation-adoption-behavior";
import { afterAll, describe } from "vitest";

/**
 * E4-U2 on the live servers.
 *
 * MySQL is the leg that matters most for the MIXED source: `crew.id` is a generated key,
 * so its member of the per-field source is a backward `Ref`, and mysql2 has no
 * `RETURNING` — the value reaches the child INSERT through `LAST_INSERT_ID`. The second
 * crew is what makes that a measurement rather than a shape: two generated keys in one
 * suite, each member pointing at the crew that produced it.
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
  // ONE push per suite. A second `push(force)` over this schema raises MySQL 1553
  // ("cannot drop an index a foreign key needs") on the nullable-component pair, which
  // is a DDL-ordering fact about the migration path and not about the write engine — so
  // the suite drops its own tables, migrates once, and each test resets by DELETE.
  let shared: any;
  registerCompoundAdoptBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: compoundAdoptSchema,
          driver: makeDriver(),
        }) as any;
        for (const table of [
          "e4u2_seats",
          "e4u2_orgs",
          "e4u2_members",
          "e4u2_crews",
          "e4u2_zone_spots",
          "e4u2_zones",
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
