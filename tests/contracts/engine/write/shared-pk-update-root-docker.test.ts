import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import {
  registerSharedPkUpdateRootBehavior,
  sharedPkUpdateRootSchema,
} from "@tests/contracts/engine/write/shared-pk-update-root-behavior";
import { afterAll, describe } from "vitest";

/**
 * Package E on the live servers, where the foreign keys are real.
 *
 * Two facts only a server can settle. A shared-primary-key fold MOVES a live child row's
 * key while another table references it, so PostgreSQL and MySQL are the legs that
 * decide whether the plan's ORDER is right — the target INSERT before the root UPDATE,
 * the fresh child INSERT after it — rather than merely plausible. And MySQL has no
 * `RETURNING`, so the produced-key row rides `insertId` there: the record's final
 * primary key is a value the engine never sees until the driver reports it, and the
 * terminal read still has to address the right row.
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
        schema: sharedPkUpdateRootSchema,
        driver: makeDriver(),
      }) as any;
      // Children before parents, so a re-run never asks `push(force)` to re-shape an
      // index a live foreign key still needs.
      for (const table of [
        "e1u_chits",
        "e1u_notes",
        "e1u_cards",
        "e1u_stubs",
        "e1u_tickets",
        "e1u_desks",
        "e1u_accounts",
      ]) {
        await shared.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
      }
      await push(shared, { force: true });
    }
    return shared;
  };
  registerSharedPkUpdateRootBehavior(
    name,
    connect,
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
