import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { D1Driver } from "@drivers/d1";
import { QueryEngineError } from "@errors";
import { parseResult, ResultParser } from "@query-engine/result/ResultParser";
import {
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const MALFORMED_RESULT_PATTERN = /result|payload|rows/i;
const RELATION_COUNT_PATTERN = /relation count/i;

const recursiveRelationModels = (() => {
  const root = s.model({
    id: s.string().id(),
    children: s.oneToMany(() => branch),
  });

  const branch = s.model({
    id: s.string().id(),
    rootId: s.string(),
    recordedAt: s.dateTime(),
    payload: s.json(),
    parent: s
      .manyToOne(() => root)
      .fields("rootId")
      .references("id"),
    children: s.oneToMany(() => leaf),
  });

  const leaf = s.model({
    id: s.string().id(),
    branchId: s.string(),
    amount: s.bigInt(),
    payload: s.blob(),
    parent: s
      .manyToOne(() => branch)
      .fields("branchId")
      .references("id"),
  });

  return { root, branch, leaf };
})();

const RECURSIVE_CHILDREN_ARGS = {
  include: { children: { include: { children: true } } },
};
const BRANCH_RELATIONS_ARGS = {
  include: {
    children: { include: { parent: true, children: true } },
  },
};
const RELATION_COUNT_ARGS = {
  select: { id: true, _count: { select: { children: true } } },
};

function createRecursiveRelationContext() {
  return new ResultParser(new PostgresAdapter(), recursiveRelationModels.root);
}

function createSQLiteRecursiveRelationContext() {
  const driver = new D1Driver({ database: Object.create(null) });

  return new ResultParser(
    new SQLiteAdapter(),
    recursiveRelationModels.root,
    driver
  );
}

function createBranchRelationContext() {
  return new ResultParser(
    new PostgresAdapter(),
    recursiveRelationModels.branch
  );
}

describe("result parser contracts", () => {
  test("parses recursive relations with repeated names by relation identity", () => {
    const result = parseResult<
      Array<{
        children: Array<{
          recordedAt: Date;
          payload: { source: string };
          children: Array<{ amount: bigint; payload: Uint8Array }>;
        }>;
      }>
    >(
      createRecursiveRelationContext(),
      "findMany",
      [
        {
          id: "root-1",
          children: [
            {
              id: "branch-1",
              rootId: "root-1",
              recordedAt: "2026-07-09T10:00:00.000Z",
              payload: { source: "branch-json" },
              children: [
                {
                  id: "leaf-1",
                  branchId: "branch-1",
                  amount: "9007199254740993",
                  payload: [0, 128, 255],
                },
              ],
            },
          ],
        },
      ],
      RECURSIVE_CHILDREN_ARGS
    );

    const leafPayload = result[0]?.children[0]?.children[0]?.payload;
    expect(leafPayload).toBeInstanceOf(Uint8Array);
    expect({
      branchDate: result[0]?.children[0]?.recordedAt,
      branchJson: result[0]?.children[0]?.payload,
      leafAmount: result[0]?.children[0]?.children[0]?.amount,
      leafBlob: leafPayload ? Array.from(leafPayload) : undefined,
    }).toEqual({
      branchDate: new Date("2026-07-09T10:00:00.000Z"),
      branchJson: { source: "branch-json" },
      leafAmount: 9007199254740993n,
      leafBlob: [0, 128, 255],
    });
  });

  test.each([
    ["object", { unexpected: true }],
    ["primitive", 1n],
    ["absent", undefined],
    ["exotic row", [new Date("2026-07-09T10:00:00.000Z")]],
  ])("rejects a malformed generic findMany %s payload", (_label, raw) => {
    expect(() =>
      parseResult(createRecursiveRelationContext(), "findMany", raw, {})
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("rejects an unknown top-level row column", () => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        "findMany",
        [{ id: "root-1", unexpected: true }],
        {}
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("ignores inherited enumerable properties when checking row columns", () => {
    const row: Record<string, unknown> = Object.create({ inherited: true });
    row.id = "root-1";

    expect(
      parseResult(createRecursiveRelationContext(), "findMany", [row], {})
    ).toEqual([{ id: "root-1" }]);
  });

  test("checks every repeated to-one relation row after parser reuse", () => {
    expect(() =>
      parseResult(
        createBranchRelationContext(),
        "findMany",
        [
          {
            id: "branch-1",
            rootId: "root-1",
            recordedAt: "2026-07-09T10:00:00.000Z",
            payload: { source: "first" },
            parent: { id: "root-1" },
          },
          {
            id: "branch-2",
            rootId: "root-1",
            recordedAt: "2026-07-09T11:00:00.000Z",
            payload: { source: "second" },
            parent: { id: "root-1", unexpected: true },
          },
        ],
        { include: { parent: true } }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("wraps corrupted SQLite JSON transport without exposing the raw value", () => {
    const privateValue = "phase6-private-invalid-json";
    let error: unknown;

    try {
      parseResult(
        createSQLiteRecursiveRelationContext(),
        "findMany",
        [
          {
            id: "root-1",
            children: [
              {
                id: "branch-1",
                rootId: "root-1",
                recordedAt: "2026-07-09T10:00:00.000Z",
                payload: privateValue,
              },
            ],
          },
        ],
        { include: { children: true } }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(QueryEngineError);
    if (!(error instanceof QueryEngineError)) {
      throw new Error("Expected a contextual QueryEngineError.");
    }
    expect(error.meta).toMatchObject({
      driver: "d1",
      operation: "findMany",
      scalarType: "json",
    });
    expect(error.message).not.toContain(privateValue);
  });

  test("preserves operation-valid empty results", () => {
    const ctx = createRecursiveRelationContext();

    expect(parseResult(ctx, "findMany", [], {})).toEqual([]);
    expect(parseResult(ctx, "findUnique", [], {})).toBeNull();
    expect(parseResult(ctx, "createMany", { rowCount: 0 }, {})).toEqual({
      count: 0,
    });
    expect(parseResult(ctx, "count", [{ [COUNT_RESULT_KEY]: 0 }], {})).toBe(0);
  });

  test.each([
    ["required create row", "create", []],
    ["COUNT row", "count", []],
    ["aggregate row", "aggregate", [{}]],
    ["to-many relation array", "findMany", [{ id: "root-1", children: null }]],
    [
      "uniform row columns",
      "findMany",
      [{ id: "root-1", children: [] }, { id: "root-2" }],
    ],
  ] as const)("rejects a missing %s", (_label, operation, raw) => {
    const args =
      operation === "findMany" ? { include: { children: true } } : {};
    expect(() =>
      parseResult(createRecursiveRelationContext(), operation, raw, args)
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("rejects multiple rows for findUnique", () => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        "findUnique",
        [
          { id: "root-1", children: [] },
          { id: "root-2", children: [] },
        ],
        { include: { children: true } }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test.each([
    [
      "required to-one null",
      [
        {
          id: "root-1",
          children: [
            {
              id: "branch-1",
              rootId: "root-1",
              recordedAt: "2026-07-09T10:00:00.000Z",
              payload: {},
              parent: null,
              children: [],
            },
          ],
        },
      ],
    ],
    ["primitive to-many member", [{ id: "root-1", children: [1] }]],
    [
      "unknown nested column",
      [
        {
          id: "root-1",
          children: [
            {
              id: "branch-1",
              rootId: "root-1",
              recordedAt: "2026-07-09T10:00:00.000Z",
              payload: { unconstrained: true },
              unexpected: true,
            },
          ],
        },
      ],
    ],
  ])("rejects a malformed nested relation: %s", (_label, raw) => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        "findMany",
        raw,
        BRANCH_RELATIONS_ARGS
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test.each([
    ["missing rowCount", {}],
    ["negative rowCount", { rowCount: -1 }],
    ["fractional rowCount", { rowCount: 0.5 }],
  ])("rejects a batch mutation with %s", (_label, raw) => {
    expect(() =>
      parseResult(createRecursiveRelationContext(), "createMany", raw, {})
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test.each([
    -1,
    0.5,
    "01",
    "0x10",
    "1e2",
    " 1 ",
    "9007199254740993",
    9_007_199_254_740_993n,
  ])("rejects malformed relation count %s", (count) => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        "findMany",
        [
          {
            id: "root-1",
            [RELATION_COUNTS_RESULT_KEY]: { children: count },
          },
        ],
        RELATION_COUNT_ARGS
      )
    ).toThrow(RELATION_COUNT_PATTERN);
  });

  test("rejects an unknown relation-count carrier key", () => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        "findMany",
        [
          {
            id: "root-1",
            [RELATION_COUNTS_RESULT_KEY]: { missing: 1 },
          },
        ],
        RELATION_COUNT_ARGS
      )
    ).toThrow(RELATION_COUNT_PATTERN);
  });

  test.each([
    "count",
    "exist",
  ] as const)("rejects unknown %s result keys", (operation) => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        operation,
        [{ unexpected: 1 }],
        {}
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test.each([
    "01",
    "0x10",
    "1e2",
    " 1 ",
  ])("rejects non-canonical count value %s", (count) => {
    const ctx = createRecursiveRelationContext();

    expect(() =>
      parseResult(ctx, "count", [{ [COUNT_RESULT_KEY]: count }], {})
    ).toThrow(MALFORMED_RESULT_PATTERN);
    expect(() =>
      parseResult(ctx, "exist", [{ [COUNT_RESULT_KEY]: count }], {})
    ).toThrow(MALFORMED_RESULT_PATTERN);
    expect(() =>
      parseResult(
        ctx,
        "aggregate",
        [{ [getAggregateResultKey("_count")]: count }],
        { _count: true }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("SQLite count middleware does not collapse duplicate COUNT rows", () => {
    expect(() =>
      parseResult(
        createSQLiteRecursiveRelationContext(),
        "count",
        [{ "COUNT(*)": 1 }, { "COUNT(*)": 2 }],
        {}
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });
});
