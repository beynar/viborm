/**
 * SQLite3 — issues #42, #45, #46 and #47 on one schema (combined falsifiers
 * 2-4, live half). Each cell gets a fresh in-memory database with foreign-key
 * enforcement on; the cells are `tests/fixtures/issue-combination-cells.ts`.
 */

import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  issueCombinationCells,
  sqliteTables,
} from "@tests/fixtures/issue-combination-cells";
import { describe } from "vitest";

describe("SQLite3 issue combination", () => {
  issueCombinationCells({
    dialect: "sqlite",
    openDatabase: async () => {
      const driver = createInMemorySQLite3Driver();
      return {
        driver,
        tables: () => sqliteTables(driver),
        dispose: () => driver.disconnect(),
      };
    },
  });
});
