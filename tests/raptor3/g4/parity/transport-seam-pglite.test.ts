/**
 * D-53 — the PostgreSQL half of the failure-attribution witness.
 *
 * The engine's attribution ladder consumes one driver fact: `statementIndex`,
 * the position of the statement a batch failed at
 * (`OperationContext.submit`). The fixtures the release units pin on assume the
 * shared seam produces it (`drivers/driver-transaction-base.ts`,
 * `executeBatch`, which runs a batch statement by statement and names the one
 * that raised), and the index-free fixture assumes the opposite for a
 * transport that rejects the whole request. PGlite establishes PostgreSQL SQL
 * behaviour, and this file is where it establishes the PostgreSQL side of that
 * transport fact too: the seam's index, and the atomicity the position rule
 * depends on, measured on a live PostgreSQL rather than assumed from SQLite.
 *
 * One PGlite for the file: a whole Postgres compiled to Wasm costs ~1.3 GiB.
 */

import assert from "node:assert/strict";
import { PGliteDriver } from "@drivers/pglite";
import { UniqueConstraintError } from "@errors";
import { afterAll, beforeAll, describe, it } from "vitest";

const TABLE = '"d53_seam"';

describe("D-53: the PostgreSQL batch seam", () => {
  const driver = new PGliteDriver();
  beforeAll(async () => {
    await driver._executeRaw(
      `CREATE TABLE ${TABLE} ("id" TEXT PRIMARY KEY, "label" TEXT)`
    );
  });
  afterAll(async () => {
    await driver._disconnect();
  });

  const failure = async (run: Promise<unknown>) =>
    await run.then(
      () => undefined,
      (error: unknown) => error
    );

  it("names the statement of the batch that failed", async () => {
    const error = await failure(
      driver._executeBatch([
        { sql: `INSERT INTO ${TABLE} ("id", "label") VALUES ('ok', 'first')` },
        { sql: `INSERT INTO ${TABLE} ("id", "label") VALUES ('dup', 'a')` },
        { sql: `INSERT INTO ${TABLE} ("id", "label") VALUES ('dup', 'b')` },
      ])
    );

    assert.ok(
      error instanceof UniqueConstraintError,
      `the duplicate key: ${String(error)}`
    );
    assert.equal(error.meta.statementIndex, 2);
  });

  it("leaves no writes behind the batch it aborted", async () => {
    const remaining = await driver._executeRaw<{ id: string }>(
      `SELECT "id" FROM ${TABLE}`
    );
    assert.deepEqual(remaining.rows, []);
  });
});
