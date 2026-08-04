import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { describe } from "vitest";
import { runJunctionSkipAdoptBehavior } from "./e68-junction-skip-adopt-behavior";

/**
 * E6.8 on the live servers.
 *
 * MySQL is the load-bearing leg. It is the dialect whose `skipDuplicates` is NOT a SQL leaf
 * (`recoverableUniqueError`), so it is the one whose old answer was the savepoint effect —
 * and it is also the non-returning driver, so the adopt's fresh INSERT publishes its
 * identity through the driver `insertId` rather than `RETURNING`. Both halves of the
 * absorption therefore run on their least forgiving substrate here. PostgreSQL is the
 * control: the same state through a `RETURNING` capture.
 *
 * Requires the Docker test databases:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;

runJunctionSkipAdoptBehavior({
  name: "Docker MySQL",
  createDriver: () => new MySQL2Driver({ databaseUrl: MYSQL as string }),
  dropTablesFirst: true,
  register: MYSQL ? describe : describe.skip,
});

runJunctionSkipAdoptBehavior({
  name: "Docker PostgreSQL",
  createDriver: () => new PgDriver({ databaseUrl: PG as string }),
  dropTablesFirst: true,
  register: PG ? describe : describe.skip,
});
