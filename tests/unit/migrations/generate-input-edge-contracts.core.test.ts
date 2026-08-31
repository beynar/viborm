import { Sql, sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { normalizeGenerateOptions } from "@src/migrations/generate-input";
import { describe, expect, test } from "vitest";

function transition(overrides: Record<string, unknown> = {}) {
  return {
    from: null,
    execution: "transactional",
    up: [sql.raw("SELECT 1")],
    rollback: { kind: "irreversible", reason: "source unavailable" },
    ...overrides,
  };
}

function manualTransition(overrides: Record<string, unknown> = {}) {
  return {
    ...transition(),
    rollback: {
      kind: "manual",
      execution: "stepwise",
      sql: [sql.raw("SELECT 2")],
    },
    ...overrides,
  };
}

describe("generate input edge contracts", () => {
  test("normalizes every optional generation option into a frozen snapshot", () => {
    const resolve = () => undefined;
    const normalized = normalizeGenerateOptions({
      name: "release",
      from: null,
      dryRun: true,
      resolve,
      skipValidation: false,
      manualMigration: {
        transitions: [
          {
            ...manualTransition(),
            originChecks: [
              {
                kind: "trusted-read",
                query: sql.raw("SELECT 1"),
                equals: true,
              },
            ],
          },
        ],
        destinationChecks: [
          { kind: "trusted-read", query: sql.raw("SELECT 1"), equals: true },
        ],
      },
    });

    expect(normalized).toMatchObject({
      name: "release",
      from: null,
      dryRun: true,
      resolve,
      skipValidation: false,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(
      Object.isFrozen(normalized.manualMigration?.transitions[0]?.up)
    ).toBe(true);
  });

  test.each([
    [{ name: 1 }, "generate name must be a string"],
    [{ from: 1 }, "generate from must be a state id or null"],
    [{ dryRun: 1 }, "generate dryRun must be a boolean"],
    [{ skipValidation: "yes" }, "generate skipValidation must be a boolean"],
    [{ resolve: "later" }, "generate resolve must be a function"],
  ])("refuses invalid public options %#", (options, message) => {
    expect(() => normalizeGenerateOptions(options)).toThrow(message);
  });

  test.each([
    [
      { transitions: [] },
      "A manual migration must define at least one parent transition",
    ],
    [
      { transitions: [transition({ from: 1 })] },
      ".from must be a state id or null",
    ],
    [
      { transitions: [transition({ execution: "eventual" })] },
      ".execution must be transactional or stepwise",
    ],
    [
      { transitions: [transition({ rollback: { kind: "unknown" } })] },
      ".kind is invalid",
    ],
    [
      {
        transitions: [
          transition({
            rollback: {
              kind: "irreversible",
              execution: "stepwise",
              reason: "no",
            },
          }),
        ],
      },
      "invalid irreversible shape",
    ],
    [
      {
        transitions: [
          manualTransition({
            rollback: {
              kind: "manual",
              execution: "eventual",
              sql: [],
            },
          }),
        ],
      },
      "invalid manual shape",
    ],
    [
      {
        transitions: [
          transition({
            originChecks: [
              { kind: "driver", query: sql.raw("SELECT 1"), equals: true },
            ],
          }),
        ],
      },
      "invalid check shape",
    ],
    [
      {
        transitions: [transition()],
        destinationChecks: [
          { kind: "trusted-read", query: sql.raw("SELECT 1"), equals: 1 },
        ],
      },
      "invalid check shape",
    ],
    [{ transitions: [transition({ up: ["SELECT 1"] })] }, "could not be read"],
  ])("refuses malformed manual definitions %#", (manualMigration, message) => {
    expect(() => normalizeGenerateOptions({ manualMigration })).toThrow(
      message
    );
  });

  test("copies Sql strings and values before the caller can mutate them", () => {
    const strings = ["SELECT ", ""];
    const values = [1];
    const fragment = new Sql(strings, values);
    const normalized = normalizeGenerateOptions({
      manualMigration: { transitions: [transition({ up: [fragment] })] },
    });
    strings[0] = "DELETE ";
    values[0] = 2;

    expect(normalized.manualMigration?.transitions[0]?.up[0]).toMatchObject({
      strings: ["SELECT ", ""],
      values: [1],
    });
  });
});

describe("coverage low value", () => {
  test("malformed Sql internals are translated at the hostile boundary", () => {
    const wrongStrings = new Sql([""], []);
    Object.defineProperty(wrongStrings, "strings", { value: [1] });
    const wrongLength = new Sql(["SELECT ", ""], [1]);
    Object.defineProperties(wrongLength, {
      strings: { value: ["SELECT ", " extra", ""] },
      values: { value: [1] },
    });
    const missingArrays = Object.create(Sql.prototype);
    const unreadable = Object.create(Sql.prototype);
    Object.defineProperty(unreadable, "strings", {
      get() {
        throw new Error("unreadable strings");
      },
    });

    for (const fragment of [
      wrongStrings,
      wrongLength,
      missingArrays,
      unreadable,
    ]) {
      expect(() =>
        normalizeGenerateOptions({
          manualMigration: { transitions: [transition({ up: [fragment] })] },
        })
      ).toThrowError(
        expect.objectContaining({
          code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        })
      );
    }
  });
});
