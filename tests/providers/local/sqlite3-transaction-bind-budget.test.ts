/**
 * One statement, one outcome, inside a transaction or not. better-sqlite3
 * reads `?NNN` as a name, so its driver never numbers placeholders: a
 * statement over the bind budget is refused, never sent with equal values
 * merged. A transaction's view is another driver object, and it read the
 * base default (numbering) instead of its driver's: inside
 * `withTransaction` the same statement failed as a raw QueryError.
 */

import { UnsupportedOperationError } from "@errors";
import { sql } from "@sql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { expect, test } from "vitest";

test("a statement over the bind budget is refused the same way inside a transaction", async () => {
  const driver = createInMemorySQLite3Driver();
  // 40,000 bound values, 3 distinct: over 32,766, under it once merged.
  const values = Array.from({ length: 40_000 }, (_, n) => (n % 3) + 1);
  const query = sql`SELECT COUNT(*) AS n FROM (SELECT 1 AS x) AS t WHERE 2 IN (${sql.join(
    values.map((value) => sql`${value}`),
    ", "
  )})`;
  try {
    await expect(driver._execute(query)).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
    await expect(
      driver.withTransaction((tx) => tx._execute(query))
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  } finally {
    await driver.disconnect();
  }
});
