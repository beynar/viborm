/**
 * PGlite — issues #42, #45, #46 and #47 on one schema (combined falsifiers
 * 2-4, live half). One PGlite for the file; each cell gets its own private
 * schema, dropped when the cell ends. PostgreSQL removes every junction key
 * before its tables, so the drop cell proves the same consented program
 * applies here too. The cells are `tests/fixtures/issue-combination-cells.ts`.
 */

import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { issueCombinationCells } from "@tests/fixtures/issue-combination-cells";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe } from "vitest";

describe("PGlite issue combination", () => {
  let database: PGlite;
  let cell = 0;

  beforeAll(() => {
    database = openTestPGlite();
  });

  issueCombinationCells({
    dialect: "pg",
    openDatabase: async () => {
      cell += 1;
      const namespace = `issue_combination_${cell}`;
      await database.query(`CREATE SCHEMA "${namespace}"`);
      const driver = new PGliteDriver({ client: database, namespace });
      return {
        driver,
        tables: async () =>
          (
            await database.query<{ tablename: string }>(
              "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
              [namespace]
            )
          ).rows.map((row) => row.tablename),
        dispose: async () => {
          await driver.disconnect();
          await database.query(`DROP SCHEMA "${namespace}" CASCADE`);
        },
      };
    },
  });
});
