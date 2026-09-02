/** Unit F — premise invalidation between match and assert; malformed rows; a closed connection. */
import { execute } from "@src/query-engine/pattern/execute";
import { ref } from "@src/query-engine/write-engine/OperationFragment";
import {
  CAPABILITY_PRESETS,
  fault,
  rows,
  type ScriptedStatement,
  SimulatedDriver,
} from "@tests/pattern/sim/simulated-driver";
import { describe, expect, test } from "vitest";
import { connectProgram, memberedProgram } from "./fixtures";

/**
 * A store-backed script: the author read and the guard both consult the cell
 * store, so a mutation between the phases is observable by the guard.
 */
const storeBacked = {
  respond: (
    statement: ScriptedStatement,
    store: { has: (t: string, k: unknown) => boolean }
  ) => {
    const present = store.has("sim_users", "u1");
    if (statement.kind === "read") return present ? rows({ id: "u1" }) : rows();
    if (statement.kind === "guard")
      return present ? undefined : fault("assertion");
    return undefined;
  },
};

describe("premise invalidation between the match and assert phases", () => {
  test("batch: the guard catches the invalidated premise inside the unit", async () => {
    const driver = new SimulatedDriver({
      capabilities: CAPABILITY_PRESETS.neonHttp,
      script: storeBacked,
    });
    driver.store.seed("sim_users", "u1", { id: "u1" });
    driver.between(0, (store) => {
      store.delete("sim_users", "u1");
    });
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "NestedWriteError",
      message: "connect target 'author' no longer exists",
    });
    expect(driver.trace()).toEqual([
      'match#0 SELECT "id" FROM "sim_users" WHERE "id" = $1 ["u1"] @user',
      "-- invalidation fragment 0",
      "-- batchBegin #1 (2)",
      '[batch] assert#0 SELECT 1 / CASE WHEN EXISTS (SELECT "id" FROM "sim_users" WHERE "id" = $1) THEN 1 ELSE 0 END AS "__viborm_assert__" ["u1"] @post !fault',
      "-- batchAbort #1",
    ]);
  });

  test("transaction: the locked match is the premise, so the hook lands after the lock", async () => {
    const driver = new SimulatedDriver({ script: storeBacked });
    driver.store.seed("sim_users", "u1", { id: "u1" });
    driver.between(0, (store) => {
      store.delete("sim_users", "u1");
    });
    // Under a real provider the FOR UPDATE lock blocks the concurrent delete
    // until commit; the simulation cannot block, so it records that the
    // invalidation happened only after the locked read had already bound the
    // row, and the write proceeds against the binding it holds.
    await expect(execute(connectProgram(), driver)).resolves.toEqual({
      result: 1,
    });
    expect(driver.trace()).toEqual([
      "-- begin",
      'match#0 SELECT "id" FROM "sim_users" WHERE "id" = $1 FOR UPDATE ["u1"] @user',
      "-- invalidation fragment 0",
      'assert#0 UPDATE "sim_posts" SET "author_id" = $1 WHERE "id" = $2 ["u1","p1"] @post',
      "-- commit",
    ]);
  });

  test("segments: the invalidation before member 2 fails the inherited premise there", async () => {
    const driver = new SimulatedDriver({
      dialect: "sqlite",
      capabilities: CAPABILITY_PRESETS.d1,
      script: storeBacked,
    });
    driver.store.seed("sim_users", "u1", { id: "u1" });
    driver.between(2, (store) => {
      store.delete("sim_users", "u1");
    });
    await expect(execute(memberedProgram(3), driver)).rejects.toMatchObject({
      name: "NestedWriteError",
      message: "parent 'user' no longer exists",
      meta: {
        recordSeriesProgress: {
          phase: "member",
          committedSegments: 2,
          completedMembers: 2,
          memberPath: [2],
          totalMembers: 3,
        },
      },
    });
  });
});

describe("malformed provider rows", () => {
  test("a row missing a requested column is the parser contract's refusal", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          statement.kind === "read" ? rows({ id: "u1", name: "n" }) : undefined,
        malformedRow: { atRow: 0, shape: "missingColumn" },
      },
    });
    const program = connectProgram();
    await expect(
      execute(
        { ...program, outputs: { author: ref("author.find", "id") } },
        driver,
        {
          expectedRows: { "author.find": ["id", "name"] },
        }
      )
    ).rejects.toMatchObject({
      name: "TransactionError",
      message: "Step 'author.find' did not produce row field 'id'.",
    });
  });

  test("a row with a stray column reaches the parser contract's key check", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          statement.kind === "read" ? rows({ id: "u1", name: "n" }) : undefined,
        malformedRow: { atRow: 0, shape: "extraColumn" },
      },
    });
    const author = {
      ...connectProgram().fragments[0]!.matches[0]![0]!,
      outputs: { rows: { kind: "rows" as const } },
      expects: undefined,
    };
    const program = {
      ...connectProgram(),
      fragments: [
        {
          matches: [[author]],
          writes: [],
          premises: [],
          inherited: [],
          boundary: { kind: "end" as const },
        },
      ],
      outputs: { author: ref("author.find", "rows") },
    };
    await expect(
      execute(program, driver, {
        expectedRows: { "author.find": ["id", "name"] },
      })
    ).rejects.toMatchObject({
      name: "QueryEngineError",
      message:
        'Driver "simulated-postgresql" returned a malformed result for operation "update": a returned row does not match the requested result columns.',
      meta: { driver: "simulated-postgresql", operation: "update" },
    });
  });

  test("a non-object row never passes the driver layer's own floor", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          statement.kind === "read" ? rows({ id: "u1" }) : undefined,
        malformedRow: { atRow: 0, shape: "nonObject" },
      },
    });
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "QueryError",
      message: expect.stringContaining("malformed normalized result"),
    });
  });
});

describe("a connection closed mid-transaction", () => {
  test("the failing statement and every later one are refused until reopened", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          statement.kind === "read" ? rows({ id: "u1" }) : undefined,
        faults: [{ at: 1, error: "closed" }],
      },
    });
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "QueryError",
    });
    expect(driver.statements.map((entry) => entry.outcome)).toEqual([
      "ok",
      "fault",
    ]);
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "QueryError",
    });
    expect(driver.statements.at(-1)?.outcome).toBe("closed");
    driver.reopen();
    await expect(execute(connectProgram(), driver)).resolves.toEqual({
      result: 1,
    });
  });
});
