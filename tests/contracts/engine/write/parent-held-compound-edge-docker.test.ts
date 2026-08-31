import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import {
  parentHeldCompoundEdgeSchema,
  registerParentHeldCompoundEdgeBehavior,
} from "@tests/contracts/engine/write/parent-held-compound-edge-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, describe } from "vitest";

/**
 * E6.4 on the live servers.
 *
 * MySQL is the leg that matters: the absent-arm `upsert` mints the target BEFORE the
 * root UPDATE and rebinds both parent columns from it, and mysql2 has no `RETURNING`,
 * so the two referenced values travel as spelled literals rather than a read-back —
 * a different path through the same per-field correlation than either PGlite leg takes.
 * The half-null case is the other reason to run both: NULL comparison semantics are the
 * whole mechanism there, and they are per-dialect until measured otherwise.
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
  // ONE push per suite (the E4 precedent): re-pushing over a nullable compound foreign
  // key raises MySQL 1553 on the index the constraint needs, which is a migration-path
  // fact and not a write-engine one. Each test reseeds by DELETE.
  let shared: any;
  registerParentHeldCompoundEdgeBehavior(
    name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: parentHeldCompoundEdgeSchema,
          driver: makeDriver(),
        }) as any;
        for (const table of [
          "e64_stations",
          "e64_depots",
          "e64_docks",
          "e64_berths",
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
