import { VibORMErrorCode } from "@src/errors";
import {
  evaluateAllChecks,
  evaluateCheck,
  executeDispatch,
  executeOperations,
} from "@src/migrations/execute-dispatch";
import {
  composeSqlBlob,
  sliceDispatch,
  validateSqlRanges,
} from "@src/migrations/sql-blob";
import {
  encodeDispatchIdentity,
  encodeSqlBlob,
} from "@src/migrations/v1-parse";
import type {
  MigrationBooleanCheckV1,
  MigrationDispatchV1,
  MigrationOperationV1,
  MigrationParameterV1,
} from "@src/migrations/v1-types";
import { describe, expect, test, vi } from "vitest";
import { sqliteEstateDriver } from "./_estate";

function dispatch(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number,
  parameters: readonly MigrationParameterV1[] = []
): MigrationDispatchV1 {
  const range = blob.ranges[index];
  if (!range) throw new Error(`Missing range ${index}`);
  return {
    sqlHash: blob.sqlHash,
    offset: range.offset,
    length: range.length,
    parameters,
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      parameters
    ),
  };
}

function check(
  id: string,
  query: MigrationDispatchV1,
  equals = true
): MigrationBooleanCheckV1 {
  return { kind: "driver", id, query, equals };
}

describe("migration exact execution contracts", () => {
  test.each([
    [true, true],
    [1, true],
    [1n, true],
    ["1", true],
    ["t", true],
    ["true", true],
    [false, false],
    [0, false],
    [0n, false],
    ["0", false],
    ["f", false],
    ["false", false],
  ])("coerces the provider boolean spelling %s", async (value, expected) => {
    const blob = composeSqlBlob(["SELECT boolean"]);
    const driver = sqliteEstateDriver();
    driver.respond = () => [{ value }];
    await expect(
      evaluateCheck(
        driver,
        blob.bytes,
        check("boolean", dispatch(blob, 0), expected)
      )
    ).resolves.toBe(true);
  });

  test("dispatch decodes the target namespace and detaches parameters", async () => {
    const parameters = [
      { kind: "target-namespace" as const },
      { kind: "number" as const, value: 2 },
    ];
    const blob = composeSqlBlob(["SELECT namespace"]);
    const driver = sqliteEstateDriver();

    await executeDispatch(
      driver,
      blob.bytes,
      dispatch(blob, 0, parameters),
      "tenant"
    );

    expect(driver.statements).toContain("SELECT namespace");
    expect(driver.parameters).toContainEqual(["tenant", 2]);
  });

  test("a proven step skips an already-confirmed destination", async () => {
    const blob = composeSqlBlob(["POST", "PRE", "EXEC"]);
    const operation = {
      id: "create-account",
      label: "create account",
      origin: "generated",
      risk: "safe",
      steps: [
        {
          retry: "proven",
          postcheck: check("post", dispatch(blob, 0)),
          precheck: check("pre", dispatch(blob, 1)),
          execute: dispatch(blob, 2),
        },
      ],
    } satisfies MigrationOperationV1;
    const driver = sqliteEstateDriver();
    driver.respond = () => [{ value: 1 }];
    const progress = vi.fn(async () => undefined);

    await executeOperations(
      driver,
      blob.bytes,
      [operation],
      "stepwise",
      progress
    );

    expect(driver.statements).not.toContain("PRE");
    expect(driver.statements).not.toContain("EXEC");
    expect(progress).toHaveBeenCalledWith(
      {
        operationId: "create-account",
        dispatchId: operation.steps[0].execute.dispatchId,
        skipped: true,
      },
      "none"
    );
  });

  test("a proven step executes only between a proven origin and destination", async () => {
    const blob = composeSqlBlob(["POST", "PRE", "EXEC"]);
    const operation = {
      id: "create-account",
      label: "create account",
      origin: "generated",
      risk: "safe",
      steps: [
        {
          retry: "proven",
          postcheck: check("post", dispatch(blob, 0)),
          precheck: check("pre", dispatch(blob, 1)),
          execute: dispatch(blob, 2),
        },
      ],
    } satisfies MigrationOperationV1;
    const driver = sqliteEstateDriver();
    let postchecks = 0;
    driver.respond = (sql) => {
      if (sql === "POST") return [{ value: postchecks++ === 0 ? 0 : 1 }];
      return [{ value: 1 }];
    };
    const progress = vi.fn(async () => undefined);

    await executeOperations(
      driver,
      blob.bytes,
      [operation],
      "transactional",
      progress
    );

    expect(driver.statements).toEqual([
      "<connect>",
      "POST",
      "PRE",
      "EXEC",
      "POST",
    ]);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: false }),
      "committed"
    );
  });

  test("stepwise opaque work records uncertainty before and after dispatch", async () => {
    const blob = composeSqlBlob(["OPAQUE"]);
    const operation = {
      id: "manual",
      label: "manual",
      origin: "manual",
      risk: "opaque",
      steps: [{ retry: "opaque", execute: dispatch(blob, 0) }],
    } satisfies MigrationOperationV1;
    const driver = sqliteEstateDriver();
    const progress = vi.fn(async () => undefined);

    await executeOperations(
      driver,
      blob.bytes,
      [operation],
      "stepwise",
      progress
    );

    expect(progress.mock.calls.map((call) => call[1])).toEqual([
      "none",
      "committed",
    ]);
  });

  test("all checks stop at the first mismatch", async () => {
    const blob = composeSqlBlob(["FIRST", "SECOND"]);
    const driver = sqliteEstateDriver();
    driver.respond = (sql) => [{ value: sql === "FIRST" ? 0 : 1 }];

    await expect(
      evaluateAllChecks(driver, blob.bytes, [
        check("first", dispatch(blob, 0)),
        check("second", dispatch(blob, 1)),
      ])
    ).resolves.toBe(false);
    expect(driver.statements).not.toContain("SECOND");
  });
});

describe("migration SQL range contracts", () => {
  test("deduplicates dispatch identities before validating ordered ranges", () => {
    const blob = composeSqlBlob(["FIRST", "SECOND"]);
    const first = dispatch(blob, 0);
    const second = dispatch(blob, 1);
    expect(() =>
      validateSqlRanges(blob.bytes, [second, first, first])
    ).not.toThrow();
    expect(sliceDispatch(blob.bytes, second)).toBe("SECOND");
  });

  test("accepts only an empty blob when there are no dispatches", () => {
    expect(() => validateSqlRanges(new Uint8Array(), [])).not.toThrow();
    expect(() => validateSqlRanges(Uint8Array.of(0x20), [])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
  });
});

describe("coverage low value", () => {
  test("malformed check result shapes remain visible", async () => {
    const blob = composeSqlBlob(["CHECK"]);
    const malformedRows = [[], [{ first: 1, second: 1 }], [{ value: "yes" }]];
    for (const rows of malformedRows) {
      const driver = sqliteEstateDriver();
      driver.respond = () => rows;
      await expect(
        evaluateCheck(driver, blob.bytes, check("malformed", dispatch(blob, 0)))
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
    }

    const twoRows = sqliteEstateDriver();
    twoRows.respond = () => [{ value: 1 }, { value: 1 }];
    await expect(
      evaluateCheck(twoRows, blob.bytes, check("two", dispatch(blob, 0)))
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_INVALID_STATE });
  });

  test("a proven step refuses unknown origin and failed destination", async () => {
    const blob = composeSqlBlob(["POST", "PRE", "EXEC"]);
    const operation = {
      id: "proven",
      label: "proven",
      origin: "generated",
      risk: "safe",
      steps: [
        {
          retry: "proven",
          postcheck: check("post", dispatch(blob, 0)),
          precheck: check("pre", dispatch(blob, 1)),
          execute: dispatch(blob, 2),
        },
      ],
    } satisfies MigrationOperationV1;
    const unknown = sqliteEstateDriver();
    unknown.respond = () => [{ value: 0 }];
    await expect(
      executeOperations(unknown, blob.bytes, [operation], "stepwise")
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });

    const partial = sqliteEstateDriver();
    partial.respond = (sql) => [{ value: sql === "PRE" ? 1 : 0 }];
    await expect(
      executeOperations(partial, blob.bytes, [operation], "stepwise")
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
  });

  test("an opaque stepwise provider failure is reported as an ambiguous commit", async () => {
    const blob = composeSqlBlob(["OPAQUE"]);
    const operation = {
      id: "opaque",
      label: "opaque",
      origin: "manual",
      risk: "opaque",
      steps: [{ retry: "opaque", execute: dispatch(blob, 0) }],
    } satisfies MigrationOperationV1;
    const driver = sqliteEstateDriver();
    driver.respond = () => new Error("provider failure");

    await expect(
      executeOperations(driver, blob.bytes, [operation], "stepwise")
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      message: expect.stringContaining("failed with an ambiguous outcome"),
    });
    expect(driver.statements).toContain("OPAQUE");
  });

  test("rejects malformed integer bounds, separators, and trailing bytes", () => {
    const blob = composeSqlBlob(["FIRST", "SECOND"]);
    const first = dispatch(blob, 0);
    const second = dispatch(blob, 1);
    const badRanges = [
      [{ ...first, offset: -1 }],
      [{ ...first, offset: 0.5 }],
      [{ ...first, length: blob.bytes.length + 1 }],
      [{ ...first, offset: 1 }],
    ];
    for (const ranges of badRanges) {
      expect(() => validateSqlRanges(blob.bytes, ranges)).toThrow();
    }

    const badSeparator = blob.bytes.slice();
    badSeparator[first.length] = 0x20;
    const separatorHash = encodeSqlBlob(badSeparator);
    expect(() =>
      validateSqlRanges(badSeparator, [
        {
          ...first,
          sqlHash: separatorHash,
          dispatchId: encodeDispatchIdentity(
            separatorHash,
            first.offset,
            first.length,
            []
          ),
        },
        {
          ...second,
          sqlHash: separatorHash,
          dispatchId: encodeDispatchIdentity(
            separatorHash,
            second.offset,
            second.length,
            []
          ),
        },
      ])
    ).toThrow();

    const trailing = new Uint8Array(blob.bytes.length + 2);
    trailing.set(blob.bytes);
    trailing.set([0x0a, 0x0a], blob.bytes.length);
    const trailingHash = encodeSqlBlob(trailing);
    expect(() =>
      validateSqlRanges(trailing, [
        {
          ...first,
          sqlHash: trailingHash,
          dispatchId: encodeDispatchIdentity(
            trailingHash,
            first.offset,
            first.length,
            []
          ),
        },
        {
          ...second,
          sqlHash: trailingHash,
          dispatchId: encodeDispatchIdentity(
            trailingHash,
            second.offset,
            second.length,
            []
          ),
        },
      ])
    ).toThrow();
  });
});
