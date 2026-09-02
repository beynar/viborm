/** Unit F — retry: once, from a fresh construction, on a classified race only. */
import { execute } from "@src/query-engine/pattern/execute";
import {
  fault,
  rows,
  SimulatedDriver,
} from "@tests/pattern/sim/simulated-driver";
import { describe, expect, test } from "vitest";
import { AUTHOR_PIN, mergeProgram, packedMergeProgram } from "./fixtures";

/**
 * The world: the probe finds nothing on the first attempt (the missing arm
 * inserts under the pin and loses the race), and finds the row on the second
 * (the found arm updates). The program thunk is what a fresh construction
 * observes; see the report on why the arm is not decided inside K3.
 */
function racingWorld(dialect: "postgresql" | "mysql" | "sqlite") {
  let attempt = 0;
  const driver = new SimulatedDriver({
    dialect,
    script: {
      respond: (statement) => {
        if (statement.kind === "read") {
          return attempt === 0 ? rows() : rows({ id: "u1" });
        }
        if (statement.sql.startsWith("INSERT")) {
          return fault("unique", {
            table: AUTHOR_PIN.table,
            constraint: AUTHOR_PIN.constraints[0],
            columns: AUTHOR_PIN.columns,
          });
        }
        return undefined;
      },
    },
  });
  const construct = () => {
    const program = mergeProgram(attempt === 0 ? "missing" : "found", {
      dialect,
    });
    attempt += 1;
    return program;
  };
  return { driver, construct };
}

describe("race retry", () => {
  test.each([
    "postgresql",
    "mysql",
    "sqlite",
  ] as const)("a pinned unique violation on %s converges after one re-run", async (dialect) => {
    const { driver, construct } = racingWorld(dialect);
    await expect(execute(construct, driver)).resolves.toEqual({ result: 1 });
    expect(
      driver.log.map((entry) =>
        entry.entry === "lifecycle"
          ? entry.kind
          : `${entry.kind}:${entry.outcome}`
      )
    ).toEqual([
      "begin",
      "read:ok",
      "write:fault",
      "rollback",
      "begin",
      "read:ok",
      "write:ok",
      "commit",
    ]);
  });

  test("a packed merge needs no thunk: the re-run's match phase selects the found arm", async () => {
    const { driver } = racingWorld("postgresql");
    let probes = 0;
    driver.useScript({
      respond: (statement) => {
        if (statement.kind === "read") {
          probes += 1;
          return probes === 1 ? rows() : rows({ id: "u1" });
        }
        return statement.sql.startsWith("INSERT")
          ? fault("unique", {
              table: AUTHOR_PIN.table,
              constraint: AUTHOR_PIN.constraints[0],
            })
          : undefined;
      },
    });
    await expect(
      execute(packedMergeProgram({ dialect: "postgresql" }), driver)
    ).resolves.toEqual({
      result: 1,
    });
    expect(
      driver.statements
        .filter((entry) => entry.kind === "write")
        .map((entry) => `${entry.sql.split(" ")[0]}:${entry.outcome}`)
    ).toEqual(["INSERT:fault", "UPDATE:ok"]);
  });

  test("a unique violation on another constraint is not a race and is not retried", async () => {
    const { driver, construct } = racingWorld("postgresql");
    driver.useScript({
      respond: (statement) =>
        statement.kind === "read"
          ? rows()
          : fault("unique", {
              table: "sim_users",
              constraint: "sim_users_pkey",
            }),
    });
    await expect(execute(construct, driver)).rejects.toMatchObject({
      name: "UniqueConstraintError",
      meta: { constraint: "sim_users_pkey" },
    });
    expect(
      driver.log.filter(
        (entry) => entry.entry === "lifecycle" && entry.kind === "begin"
      )
    ).toHaveLength(1);
  });

  test("a race with the retry disabled surfaces the classified error", async () => {
    const { driver, construct } = racingWorld("postgresql");
    await expect(
      execute(construct, driver, { retry: false })
    ).rejects.toMatchObject({
      name: "UniqueConstraintError",
    });
  });

  test("a deadlock while a pinned write is in flight is a race", async () => {
    const { driver, construct } = racingWorld("postgresql");
    let first = true;
    driver.useScript({
      respond: (statement) => {
        if (statement.kind === "read")
          return first ? rows() : rows({ id: "u1" });
        if (first) {
          first = false;
          return fault("deadlock");
        }
        return undefined;
      },
    });
    await expect(execute(construct, driver)).resolves.toEqual({ result: 1 });
  });

  test("a second race is not retried again", async () => {
    const driver = new SimulatedDriver({
      script: {
        respond: (statement) =>
          statement.kind === "read"
            ? rows()
            : fault("unique", {
                table: AUTHOR_PIN.table,
                constraint: AUTHOR_PIN.constraints[0],
              }),
      },
    });
    await expect(
      execute(() => mergeProgram("missing"), driver)
    ).rejects.toMatchObject({
      name: "UniqueConstraintError",
    });
    expect(
      driver.statements.filter((entry) => entry.kind === "write")
    ).toHaveLength(2);
  });
});
