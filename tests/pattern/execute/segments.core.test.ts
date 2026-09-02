/** Unit F — committed segments: progress, inherited premises, retry, acknowledgement. */
import { execute } from "@src/query-engine/pattern/execute";
import {
  CAPABILITY_PRESETS,
  fault,
  mentions,
  rows,
  type ScriptedStatement,
  SimulatedDriver,
  type SimulatedScript,
  type StatementResponse,
} from "@tests/pattern/sim/simulated-driver";
import { describe, expect, test } from "vitest";
import { AUTHOR_PIN, memberedProgram, pinnedMemberProgram } from "./fixtures";

const parentFound = (statement: ScriptedStatement): StatementResponse =>
  statement.kind === "read" ? rows({ id: "u1" }) : undefined;

function d1(respond: NonNullable<SimulatedScript["respond"]> = parentFound) {
  return new SimulatedDriver({
    dialect: "sqlite",
    capabilities: CAPABILITY_PRESETS.d1,
    script: { respond },
  });
}

describe("segments enforcer", () => {
  test("every member re-asserts the inherited premise and commits its own segment", async () => {
    const driver = d1();
    await expect(execute(memberedProgram(3), driver)).resolves.toEqual({
      result: 3,
    });
    const sequence = driver.log.map((entry) =>
      entry.entry === "lifecycle"
        ? entry.kind
        : `${entry.kind}#${entry.fragment}`
    );
    expect(sequence).toEqual([
      "read#0",
      "batchBegin",
      "guard#0",
      "write#0",
      "batchCommit",
      "batchBegin",
      "guard#1",
      "write#1",
      "batchCommit",
      "batchBegin",
      "guard#2",
      "write#2",
      "batchCommit",
    ]);
    // The SQLite adapter's assertion spelling (json_extract aborts the batch).
    expect(driver.statements[1]?.sql).toBe(
      `SELECT CASE WHEN EXISTS (SELECT "id" FROM "sim_users" WHERE "id" = ?) THEN 1 ELSE json_extract('x', '$') END AS "__viborm_assert__"`
    );
    expect(driver.statements[1]?.params).toEqual(["u1"]);
  });

  test("a failure at member N reports the committed prefix in today's shape", async () => {
    const driver = d1((statement) =>
      mentions(statement, '"p1"') || statement.params.includes("p1")
        ? fault("foreignKey")
        : parentFound(statement)
    );
    await expect(execute(memberedProgram(3), driver)).rejects.toMatchObject({
      name: "ForeignKeyError",
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
          completedMembers: 1,
          committedWriteMembers: 1,
          memberPath: [1],
          totalMembers: 3,
        },
      },
    });
  });

  test("a capture failure reports the capture phase with nothing committed", async () => {
    const driver = d1(() => undefined);
    await expect(execute(memberedProgram(2), driver)).rejects.toMatchObject({
      name: "NotFoundError",
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "capture",
          committedSegments: 0,
          completedMembers: 0,
          committedWriteMembers: 0,
          totalMembers: 2,
        },
      },
    });
  });

  test("an unordered batch driver marks a non-rolled-back failure as possibly committed", async () => {
    const driver = new SimulatedDriver({
      capabilities: CAPABILITY_PRESETS.neonHttp,
      script: {
        respond: (statement) =>
          statement.params.includes("p1")
            ? fault("timeout")
            : parentFound(statement),
      },
    });
    await expect(execute(memberedProgram(2), driver)).rejects.toMatchObject({
      name: "QueryError",
      meta: {
        recordSeriesProgress: {
          phase: "member",
          committedSegments: 1,
          mayHaveCommittedSegment: true,
          memberPath: [1],
        },
      },
    });
  });

  test("a pinned race in the current member is retried once after a committed prefix", async () => {
    let raced = false;
    const driver = d1((statement) => {
      if (statement.params.includes("p1") && !raced) {
        raced = true;
        return fault("unique", {
          table: AUTHOR_PIN.table,
          columns: AUTHOR_PIN.columns,
        });
      }
      return parentFound(statement);
    });
    await expect(execute(pinnedMemberProgram(1), driver)).resolves.toEqual({
      result: 2,
    });
    const writes = driver.statements.filter((entry) => entry.kind === "write");
    expect(
      writes.map((entry) => `${entry.params[0]}:${entry.outcome}`)
    ).toEqual(["p0:ok", "p1:fault", "p1:ok"]);
  });

  test("a pinned race in member 0 (nothing committed) is the whole-operation retry", async () => {
    let raced = false;
    const driver = d1((statement) => {
      if (statement.params.includes("p0") && !raced) {
        raced = true;
        return fault("unique", {
          table: AUTHOR_PIN.table,
          columns: AUTHOR_PIN.columns,
        });
      }
      return parentFound(statement);
    });
    await expect(execute(pinnedMemberProgram(0), driver)).resolves.toEqual({
      result: 2,
    });
    // The capture ran twice: the whole program re-ran from the start.
    expect(
      driver.statements.filter((entry) => entry.kind === "read")
    ).toHaveLength(2);
  });

  test("the committed-segment notification fires per acknowledged write segment", async () => {
    const driver = d1();
    const notifications: string[] = [];
    await execute(memberedProgram(2), driver, {
      committedWriteSegment: async () => {
        notifications.push("committed");
      },
    });
    expect(notifications).toEqual(["committed", "committed"]);
  });
});
