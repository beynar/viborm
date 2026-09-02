/**
 * Boundaries of the ONE pinned migration session.
 *
 * The session owns three refusals a command cannot recover from on its own: a
 * MySQL producer that will not answer for its exact-value mode, a sequential
 * program running outside the locked command that scoped it, and a lock
 * statement whose provider rejects with something that is not an `Error`.
 */

import type { QueryResult } from "@drivers/types";
import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import {
  runSequentialProgram,
  withLockedMigrationProducer,
} from "@src/migrations/pinned-session";
import { describe, expect, test } from "vitest";
import { mysqlEstateDriver, pgEstateDriver, RecordingDriver } from "./_estate";

const TABLE_CONSTRAINTS = "information_schema.TABLE_CONSTRAINTS";

/** A MySQL estate whose session answers the mode probe with `rows`. */
function mysqlEstate(rows: readonly unknown[]): RecordingDriver {
  const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
  driver.respond = (sql) => {
    if (sql.includes("SCHEMATA")) return [{ SCHEMA_NAME: "alpha" }];
    if (sql.includes("@@SESSION.sql_mode")) return [...rows];
    return [];
  };
  return driver;
}

/** A driver whose provider rejects one statement with a non-`Error` value. */
class NonErrorRejectingDriver extends RecordingDriver {
  rejects: (sql: string) => boolean = () => false;

  protected override executeRaw<T>(
    client: unknown,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.rejects(sql)) {
      return Promise.reject("the provider closed the connection");
    }
    return super.executeRaw<T>(client, sql, params);
  }
}

function rejectingPostgres(rejects: (sql: string) => boolean) {
  const driver = new NonErrorRejectingDriver(
    "postgresql",
    "pg",
    pgEstateDriver("public").adapter
  );
  driver.rejects = rejects;
  driver.respond = (sql) =>
    sql.includes("pg_namespace") ? [{ present: 1 }] : [];
  return driver;
}

const unprovableModeRows: readonly {
  readonly name: string;
  readonly rows: readonly unknown[];
}[] = [
  { name: "no mode row at all", rows: [] },
  { name: "a row carrying neither column", rows: [{ unrelated: 1 }] },
];

describe("MySQL exact-value session proof", () => {
  test.each(unprovableModeRows)("refuses a session that reports $name", async ({
    rows,
  }) => {
    const driver = mysqlEstate(rows);
    let ran = false;

    await expect(
      withLockedMigrationProducer(driver, getMigrationDriver(driver), () => {
        ran = true;
        return Promise.resolve("ran");
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      message: expect.stringContaining('reports version "<unreported>"'),
      meta: {
        type: "unenforced-check-constraints",
        target: 'database "alpha"',
      },
    });
    expect(ran).toBe(false);
  });
});

describe("sequential program scoping", () => {
  test("refuses a MySQL program that no locked command scoped", async () => {
    const driver = mysqlEstate([
      { server_version: "8.4.0", sql_mode: "STRICT_TRANS_TABLES" },
    ]);

    await expect(
      runSequentialProgram(driver, getMigrationDriver(driver), () =>
        Promise.resolve("ran")
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unbound-migration-command" },
    });
  });

  test("a second program started under one lock reuses the first recovery plan", async () => {
    const driver = mysqlEstate([
      { server_version: "8.4.0", sql_mode: "STRICT_TRANS_TABLES" },
    ]);

    const ran = await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      (pinned, command) =>
        Promise.all([
          runSequentialProgram(pinned, command, () => Promise.resolve("first")),
          runSequentialProgram(pinned, command, () =>
            Promise.resolve("second")
          ),
        ])
    );

    expect(ran).toEqual(["first", "second"]);
    expect(
      driver.statements.filter((sql) => sql.includes(TABLE_CONSTRAINTS))
    ).toHaveLength(1);
  });
});

describe("coverage low value", () => {
  test("a non-Error rejection of the lock statement still fails the command", async () => {
    const driver = rejectingPostgres((sql) => sql.includes("pg_advisory_lock"));

    await expect(
      withLockedMigrationProducer(driver, getMigrationDriver(driver), () =>
        Promise.resolve("ran")
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
      message: expect.stringContaining("the lock statement itself failed"),
      // The driver contract normalizes a non-`Error` rejection into a typed
      // QUERY_FAILED before the lock path sees it, so the chain is preserved.
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
  });

  test("a non-Error rejection of the release statement still fails the command", async () => {
    const driver = rejectingPostgres((sql) =>
      sql.includes("pg_advisory_unlock")
    );

    await expect(
      withLockedMigrationProducer(driver, getMigrationDriver(driver), () =>
        Promise.resolve("ran")
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
      message: expect.stringContaining("discarded rather than returned"),
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
  });
});
