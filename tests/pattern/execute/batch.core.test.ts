/** Unit F — the atomic-batch enforcer: guard ordering, stripping, levels, attribution. */

import { sql } from "@sql";
import { execute } from "@src/query-engine/pattern/execute";
import type { GuardStep } from "@src/query-engine/write-engine/OperationFragment";
import {
  CAPABILITY_PRESETS,
  fault,
  mentions,
  rows,
  SimulatedDriver,
  type SimulatedScript,
  written,
} from "@tests/pattern/sim/simulated-driver";
import { describe, expect, test } from "vitest";
import { connectProgram, levelledProgram } from "./fixtures";

function batchDriver(script?: SimulatedScript) {
  return new SimulatedDriver({
    capabilities: CAPABILITY_PRESETS.neonHttp,
    script: script ?? {
      respond: (statement) =>
        statement.kind === "read" ? rows({ id: "u1" }) : undefined,
    },
  });
}

describe("atomic-batch enforcer", () => {
  test("the match runs in a preceding round trip; the unit is [guard, write]", async () => {
    const driver = batchDriver();
    await expect(execute(connectProgram(), driver)).resolves.toEqual({
      result: 1,
    });
    expect(driver.trace()).toEqual([
      'match#0 SELECT "id" FROM "sim_users" WHERE "id" = $1 ["u1"] @user',
      "-- batchBegin #1 (2)",
      '[batch] assert#0 SELECT 1 / CASE WHEN EXISTS (SELECT "id" FROM "sim_users" WHERE "id" = $1) THEN 1 ELSE 0 END AS "__viborm_assert__" ["u1"] @post',
      '[batch] assert#0 UPDATE "sim_posts" SET "author_id" = $1 WHERE "id" = $2 ["u1","p1"] @post',
      "-- batchCommit #1",
    ]);
  });

  test("the write's postcondition is stripped inside the unit", async () => {
    const driver = batchDriver({
      respond: (statement) =>
        statement.kind === "read" ? rows({ id: "u1" }) : written(0),
    });
    // A zero-row UPDATE would fail the `affectedRows: 1` postcondition on the
    // transaction substrate; the batch cannot check it and does not pretend to.
    await expect(execute(connectProgram(), driver)).resolves.toEqual({
      result: 0,
    });
  });

  test("the match's postcondition is enforced before the unit is dispatched", async () => {
    const driver = batchDriver({});
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "NestedWriteError",
    });
    expect(driver.log.some((entry) => entry.entry === "lifecycle")).toBe(false);
  });

  test("an explicit guard from packing is used verbatim", async () => {
    const guard: GuardStep = {
      id: "author.premise",
      kind: "guard",
      premise: {
        kind: "exists",
        statement: sql`SELECT 1 FROM "sim_users" WHERE "id" = ${"u1"} AND "active" = ${true}`,
      },
      failure: { kind: "query", message: "author changed", raceable: false },
    };
    const driver = batchDriver();
    await execute(connectProgram({ explicitGuard: guard }), driver);
    expect(driver.statements[1]?.sql).toBe(
      'SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM "sim_users" WHERE "id" = $1 AND "active" = $2) THEN 1 ELSE 0 END AS "__viborm_assert__"'
    );
  });

  test("independent matches share one round trip per level; a dependent one waits", async () => {
    const driver = batchDriver({
      respond: (statement) =>
        statement.kind === "read"
          ? rows({ id: `${statement.index}` })
          : undefined,
    });
    await expect(execute(levelledProgram(), driver)).resolves.toEqual({
      result: 1,
      links: 1,
    });
    const lifecycle = driver.log.map((entry) =>
      entry.entry === "lifecycle"
        ? `${entry.kind}${entry.detail ?? ""}`
        : entry.sql
    );
    expect(lifecycle).toEqual([
      "batchBegin#1 (2)",
      'SELECT "id" FROM "sim_users" WHERE "id" = $1',
      'SELECT "id" FROM "sim_tags" WHERE "label" = $1',
      "batchCommit#1",
      'SELECT "id" FROM "sim_profiles" WHERE "user_id" = $1',
      "batchBegin#2 (4)",
      'SELECT 1 / CASE WHEN EXISTS (SELECT "id" FROM "sim_users" WHERE "id" = $1) THEN 1 ELSE 0 END AS "__viborm_assert__"',
      'SELECT 1 / CASE WHEN EXISTS (SELECT "id" FROM "sim_tags" WHERE "label" = $1) THEN 1 ELSE 0 END AS "__viborm_assert__"',
      'UPDATE "sim_posts" SET "author_id" = $1 WHERE "id" = $2',
      'INSERT INTO "sim_post_tags" ("post_id", "tag_id", "profile_id") VALUES ($1, $2, $3)',
      "batchCommit#2",
    ]);
    // The level-1 read consumed level 0's binding, the write consumed both.
    expect(driver.statements[2]?.params).toEqual(["0"]);
    expect(driver.statements.at(-1)?.params).toEqual(["p1", "1", "2"]);
  });

  test("a guard abort is attributed by statement index to the premise it enforces", async () => {
    const driver = batchDriver({
      respond: (statement) => {
        if (statement.kind === "read") return rows({ id: "u1" });
        if (statement.kind === "guard") return fault("assertion");
        return undefined;
      },
    });
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "TransactionError",
      message: "Premise 'exists' on match 'author.find' no longer holds.",
      meta: { model: "post", operation: "update" },
    });
    expect(driver.log.at(-1)).toEqual({
      entry: "lifecycle",
      kind: "batchAbort",
      detail: "#1",
    });
  });

  test("statements carry their own model; engine-owned failures keep the operation's", async () => {
    const driver = batchDriver();
    await execute(connectProgram(), driver);
    expect(driver.statements.map((entry) => entry.model)).toEqual([
      "user",
      "post",
      "post",
    ]);
  });

  test("a unique violation matching no pin propagates without retry", async () => {
    const driver = batchDriver({
      respond: (statement) =>
        statement.kind === "read"
          ? rows({ id: "u1" })
          : mentions(statement, "UPDATE")
            ? fault("unique", {
                constraint: "sim_posts_pkey",
                table: "sim_posts",
              })
            : undefined,
    });
    await expect(execute(connectProgram(), driver)).rejects.toMatchObject({
      name: "UniqueConstraintError",
      meta: { model: "post", constraint: "sim_posts_pkey" },
    });
    expect(
      driver.log.filter(
        (entry) => entry.entry === "lifecycle" && entry.kind === "batchBegin"
      )
    ).toHaveLength(1);
  });
});
