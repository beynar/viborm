/** Unit F — the transaction enforcer's statement sequence. */
import { NotFoundError } from "@errors";
import { execute } from "@src/query-engine/pattern/execute";
import {
  CAPABILITY_PRESETS,
  mentions,
  rows,
  SimulatedDriver,
  written,
} from "@tests/pattern/sim/simulated-driver";
import { describe, expect, test } from "vitest";
import {
  connectProgram,
  mergeOutcomeProgram,
  singleStatementProgram,
} from "./fixtures";

const authorFound = {
  respond: (statement: { sql: string }) =>
    mentions(statement, "sim_users") && mentions(statement, "SELECT")
      ? rows({ id: "u1" })
      : undefined,
};

describe("transaction enforcer", () => {
  test("matches first (locked), then writes, inside one transaction", async () => {
    const driver = new SimulatedDriver({ script: authorFound });
    const outputs = await execute(connectProgram(), driver);
    expect(outputs).toEqual({ result: 1 });
    expect(driver.trace()).toEqual([
      "-- begin",
      'match#0 SELECT "id" FROM "sim_users" WHERE "id" = $1 FOR UPDATE ["u1"] @user',
      'assert#0 UPDATE "sim_posts" SET "author_id" = $1 WHERE "id" = $2 ["u1","p1"] @post',
      "-- commit",
    ]);
  });

  test("SQLite has no row lock: the decision match runs unlocked", async () => {
    const driver = new SimulatedDriver({
      dialect: "sqlite",
      script: authorFound,
    });
    await execute(connectProgram(), driver);
    expect(driver.statements.map((entry) => entry.sql)).toEqual([
      'SELECT "id" FROM "sim_users" WHERE "id" = ?',
      'UPDATE "sim_posts" SET "author_id" = ? WHERE "id" = ?',
    ]);
  });

  test("a match postcondition fails before any write and rolls back", async () => {
    const driver = new SimulatedDriver();
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "NestedWriteError",
      message: "connect target 'author' was not found",
      meta: { relation: "author" },
    });
    expect(driver.trace()).toEqual([
      "-- begin",
      'match#0 SELECT "id" FROM "sim_users" WHERE "id" = $1 FOR UPDATE ["u1"] @user',
      "-- rollback",
    ]);
  });

  test("a write postcondition is checked before commit", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          statement.kind === "read" ? rows({ id: "u1" }) : written(0),
      },
    });
    await expect(execute(connectProgram(), driver)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(driver.log.at(-1)).toEqual({ entry: "lifecycle", kind: "rollback" });
  });

  test("a statement-atomic program runs with no envelope", async () => {
    const driver = new SimulatedDriver();
    await expect(execute(singleStatementProgram(), driver)).resolves.toEqual({
      result: 1,
    });
    expect(driver.trace()).toEqual([
      'assert#0 UPDATE "sim_posts" SET "title" = $1 WHERE "id" = $2 ["t","p1"] @post',
    ]);
  });

  test("a merge root that made no row rolls its savepoint back and skips its dependents", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          mentions(statement, "ON CONFLICT DO NOTHING")
            ? written(0)
            : undefined,
      },
    });
    // A skipped group binds nothing, and a K3 program cannot say "skipped" in
    // its outputs (today's series returns `{ kind: "skipped" }` per member);
    // the report lists this as a contract gap.
    await expect(execute(mergeOutcomeProgram(), driver)).rejects.toMatchObject({
      name: "QueryEngineError",
      message: "Operation reference 'user.create.count' is unresolved.",
    });
    expect(driver.trace()).toEqual([
      "-- begin",
      "-- savepoint sp0",
      'assert#0 INSERT INTO "sim_users" ("id") VALUES ($1) ON CONFLICT DO NOTHING ["u9"] @user',
      "-- rollbackTo sp0",
      "-- release sp0",
      "-- rollback",
    ]);
  });

  test("a merge root that made a row releases its savepoint and runs its dependents", async () => {
    const driver = new SimulatedDriver();
    await expect(execute(mergeOutcomeProgram(), driver)).resolves.toEqual({
      root: 1,
      child: 1,
      tail: 1,
    });
    expect(
      driver.log.map((entry) =>
        entry.entry === "lifecycle" ? entry.kind : entry.kind
      )
    ).toEqual([
      "begin",
      "savepoint",
      "write",
      "write",
      "write",
      "release",
      "commit",
    ]);
  });

  test("a driver with neither substrate is refused before any statement", async () => {
    const driver = new SimulatedDriver({
      capabilities: { supportsTransactions: false, supportsBatch: false },
    });
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "TransactionError",
    });
    expect(driver.log).toEqual([]);
  });

  test("an open scope runs linearly without a second envelope", async () => {
    const outer = new SimulatedDriver({ script: authorFound });
    await outer.withTransaction(async (transaction) => {
      await execute(connectProgram(), transaction, { scope: "open" });
    });
    expect(outer.trace()[0]).toBe("-- begin");
    expect(outer.trace().filter((line) => line === "-- begin")).toHaveLength(1);
  });

  test("the preset table names today's drivers", () => {
    expect(Object.keys(CAPABILITY_PRESETS)).toEqual([
      "postgres",
      "neonHttp",
      "d1",
      "mysql",
      "planetscale",
      "sqlite",
    ]);
  });
});
