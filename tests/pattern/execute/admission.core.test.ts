/** Unit F — substrate admission: today's "public result parsing cannot be rolled back" refusal. */
import {
  execute,
  refuseUnsupportedSubstrate,
} from "@src/query-engine/pattern/execute";
import {
  CAPABILITY_PRESETS,
  rows,
  SimulatedDriver,
} from "@tests/pattern/sim/simulated-driver";
import { describe, expect, test } from "vitest";
import {
  BATCH,
  bulkProgram,
  connectProgram,
  mergeProgram,
  singleStatementProgram,
} from "./fixtures";

function planetscale() {
  return new SimulatedDriver({
    dialect: "mysql",
    capabilities: CAPABILITY_PRESETS.planetscale,
    script: {
      respond: (statement) =>
        statement.kind === "read" ? rows({ id: "u1" }) : undefined,
    },
  });
}

describe("substrate admission on a batch-only, non-returning driver", () => {
  test("a single-row refetch operation is refused before any statement", async () => {
    const driver = planetscale();
    await expect(
      execute(connectProgram({ ...BATCH, dialect: "mysql" }), driver)
    ).rejects.toMatchObject({
      name: "TransactionError",
      message:
        "Driver 'simulated-mysql' cannot execute 'update' because public result parsing cannot be rolled back.",
      meta: { driver: "simulated-mysql", operation: "update" },
    });
    expect(driver.log).toEqual([]);
  });

  test("upsert has its own sentence", async () => {
    const driver = planetscale();
    await expect(
      execute(mergeProgram("found", { ...BATCH, dialect: "mysql" }), driver)
    ).rejects.toMatchObject({
      name: "TransactionError",
      message:
        "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits",
    });
  });

  test("a bulk write is refused only when it asks for rows", async () => {
    await expect(
      execute(bulkProgram(true), planetscale())
    ).rejects.toMatchObject({
      name: "TransactionError",
      message:
        "Driver 'simulated-mysql' cannot execute 'createMany' with 'select' because public result parsing cannot be rolled back.",
    });
    await expect(execute(bulkProgram(false), planetscale())).resolves.toEqual({
      result: 1,
    });
  });

  test("a returning dialect or an interactive transaction admits the same programs", async () => {
    const neon = new SimulatedDriver({
      capabilities: CAPABILITY_PRESETS.neonHttp,
      script: {
        respond: (statement) =>
          statement.kind === "read" ? rows({ id: "u1" }) : undefined,
      },
    });
    await expect(execute(connectProgram(BATCH), neon)).resolves.toEqual({
      result: 1,
    });
    const mysql = new SimulatedDriver({ dialect: "mysql" });
    await expect(execute(singleStatementProgram(), mysql)).resolves.toEqual({
      result: 1,
    });
  });

  test("the chain can ask before parsing, with the payload's own `select` fact", () => {
    const driver = planetscale();
    expect(() =>
      refuseUnsupportedSubstrate(driver, "updateMany", true)
    ).toThrow("cannot execute 'updateMany' with 'select'");
    expect(() =>
      refuseUnsupportedSubstrate(driver, "updateMany", false)
    ).not.toThrow();
    expect(() => refuseUnsupportedSubstrate(driver, "delete", false)).toThrow(
      "cannot execute 'delete' because public result parsing cannot be rolled back"
    );
    expect(() =>
      refuseUnsupportedSubstrate(driver, "create", true)
    ).not.toThrow();
  });
});
