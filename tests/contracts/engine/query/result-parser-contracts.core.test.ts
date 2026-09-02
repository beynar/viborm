import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { D1Driver } from "@drivers/d1";
import type { DriverResultParser } from "@drivers/driver";
import { QueryEngineError } from "@errors";
import {
  parseResult,
  prepareResultRows,
} from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import {
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import Decimal from "decimal.js";
import { describe, expect, test, vi } from "vitest";

const MALFORMED_RESULT_PATTERN = /result|payload|rows/i;
const RELATION_COUNT_PATTERN = /relation count/i;
const REQUIRED_RELATION_NULL_PATTERN =
  /a required included relation returned null/;
const RESERVED_COUNT_FIELD_PATTERN =
  /relation counts.*model field named '_count'/i;
const INSPECTION_FAILED_PATTERN = /inspection failed/i;
const LOST_PRIVATE_COLUMN_ROW_PATTERN = /lost its private-column row/i;
const MALFORMED_DECIMAL_SUM_PATTERN =
  /malformed decimal scalar.*sum is not an exact decimal/i;

class RelationMiddlewareDriver extends D1Driver {
  override readonly result: DriverResultParser = {
    parseRelation: (_value, next) => next(undefined),
  };
}

class DuplicatingResultDriver extends D1Driver {
  override readonly result: DriverResultParser = {
    parseResult: (raw, operation, next) => {
      if (!Array.isArray(raw) || raw[0] === undefined) {
        return next(raw, operation);
      }
      return next([raw[0], raw[0]], operation);
    },
  };
}

class ReplacingResultDriver extends D1Driver {
  override readonly result: DriverResultParser;

  constructor(replacement: unknown) {
    super({ database: Object.create(null) });
    this.result = {
      parseResult: (_raw, operation, next) => next(replacement, operation),
    };
  }
}

const recursiveRelationModels = (() => {
  const root = s.model({
    id: s.string().id(),
    children: s.toMany(() => branch),
  });

  const branch = s.model({
    id: s.string().id(),
    rootId: s.string(),
    recordedAt: s.dateTime(),
    payload: s.json(),
    parent: s
      .toOne(() => root)
      .fields("rootId")
      .references("id"),
    children: s.toMany(() => leaf),
  });

  const leaf = s.model({
    id: s.string().id(),
    branchId: s.string(),
    amount: s.bigInt(),
    payload: s.blob(),
    parent: s
      .toOne(() => branch)
      .fields("branchId")
      .references("id"),
  });

  return { root, branch, leaf };
})();

prepareSchema(recursiveRelationModels);

const aggregateModels = {
  metric: s.model({
    id: s.string().id(),
    quantity: s.int(),
    ratio: s.number(),
    exact: s.decimal({ precision: 10, scale: 2 }),
    observedAt: s.dateTime(),
    label: s.string().nullable(),
  }),
};

prepareSchema(aggregateModels);

const capturedProjectionModels = {
  entry: s.model({
    id: s.string().id(),
    position: s.int(),
  }),
};

prepareSchema(capturedProjectionModels);

const relationCountAliasModels = (() => {
  const root = s.model({
    id: s.string().id(),
    _count: s.int(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    rootId: s.string(),
    root: s
      .toOne(() => root)
      .fields("rootId")
      .references("id"),
  });
  return { root, child };
})();

prepareSchema(relationCountAliasModels);

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
  return parserFor(new PostgresAdapter(), recursiveRelationModels.root);
}

function createSQLiteRecursiveRelationContext() {
  const driver = new D1Driver({ database: Object.create(null) });

  return parserFor(new SQLiteAdapter(), recursiveRelationModels.root, driver);
}

function createBranchRelationContext() {
  return parserFor(new PostgresAdapter(), recursiveRelationModels.branch);
}

/**
 * ONE relation terminal, TWO source models (plan §11.4.7).
 *
 * `.extends()` spreads the base shape, so `image.owner` and `video.owner` are
 * the SAME immutable relation object. `video` overrides only the foreign-key
 * SCALAR, which is a fact of the resolved EDGE rather than of the declaration:
 * `image.owner` cannot be empty and `video.owner` can. A parser chain cached
 * against the shared declaration would hand the second source model the first
 * one's chain and lose that difference.
 */
const sharedTerminalModels = (() => {
  const media = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  });
  const image = media.extends({ width: s.int() });
  const video = media.extends({ ownerId: s.string().nullable() });
  const owner = s.model({
    id: s.string().id(),
    images: s.toMany(() => image),
    videos: s.toMany(() => video),
  });

  return { owner, image, video };
})();

prepareSchema(sharedTerminalModels);

const SHARED_TERMINAL_ARGS = {
  include: {
    images: { include: { owner: true } },
    videos: { include: { owner: true } },
  },
};

describe("result parser contracts", () => {
  test("does not compile a row parser for a count carrier", () => {
    const parser = createRecursiveRelationContext();
    const shape = buildExpectedResultShape(
      recursiveRelationModels.root,
      "count",
      {},
      parser.relations
    );
    if (!shape) throw new Error("Expected count to define a result shape.");

    expect(prepareResultRows(parser, "count", shape)).toBeUndefined();
  });

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

  test("decodes a fixed relation JSON carrier without provider middleware", () => {
    const carrier = [
      {
        id: "branch-1",
        rootId: "root-1",
        recordedAt: "2026-07-09 10:00:00.000",
        payload: { source: "mysql-json" },
      },
    ];
    const jsonParse = vi.spyOn(JSON, "parse").mockReturnValue(carrier);
    const result = parseResult<Array<{ children: Array<{ id: string }> }>>(
      parserFor(new MySQLAdapter(), recursiveRelationModels.root),
      "findMany",
      [
        {
          id: "root-1",
          children: "[]",
        },
      ],
      { include: { children: true } }
    );

    expect(result[0]?.children[0]?.id).toBe("branch-1");
    expect(result[0]?.children[0]).toBe(carrier[0]);
    expect(carrier[0]?.recordedAt).toEqual(
      new Date("2026-07-09T10:00:00.000Z")
    );
    jsonParse.mockRestore();
  });

  test("copies a borrowed fixed relation carrier before scalar decoding", () => {
    const child = {
      id: "branch-1",
      rootId: "root-1",
      recordedAt: "2026-07-09T10:00:00.000Z",
      payload: { source: "postgres-object" },
    };
    const result = parseResult<Array<{ children: Record<string, unknown>[] }>>(
      createRecursiveRelationContext(),
      "findMany",
      [{ id: "root-1", children: [child] }],
      { include: { children: true } }
    );

    expect(result[0]?.children[0]).not.toBe(child);
    expect(result[0]?.children[0]?.recordedAt).toEqual(
      new Date("2026-07-09T10:00:00.000Z")
    );
    expect(child.recordedAt).toBe("2026-07-09T10:00:00.000Z");
  });

  test("validates every fixed JSON row before decoding the first one", () => {
    const first = {
      id: "branch-1",
      rootId: "root-1",
      recordedAt: "2026-07-09 10:00:00.000",
      payload: { source: "mysql-json" },
    };
    const carrier = [first, { id: "branch-2" }];
    const jsonParse = vi.spyOn(JSON, "parse").mockReturnValue(carrier);

    expect(() =>
      parseResult(
        parserFor(new MySQLAdapter(), recursiveRelationModels.root),
        "findMany",
        [{ id: "root-1", children: "[]" }],
        { include: { children: true } }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
    expect(first.recordedAt).toBe("2026-07-09 10:00:00.000");
    jsonParse.mockRestore();
  });

  test("keys a shared relation terminal by its contextual slot, not the declaration", () => {
    // The premise, stated rather than assumed: it really is one object.
    expect(sharedTerminalModels.image["~"].state.relations.owner).toBe(
      sharedTerminalModels.video["~"].state.relations.owner
    );

    const context = parserFor(
      new PostgresAdapter(),
      sharedTerminalModels.owner
    );
    const parsed = parseResult<
      Array<{
        images: Array<{ owner: { id: string } }>;
        videos: Array<{ owner: null }>;
      }>
    >(
      context,
      "findMany",
      [
        {
          id: "owner-1",
          images: [
            {
              id: "image-1",
              ownerId: "owner-1",
              width: 4,
              owner: { id: "owner-1" },
            },
          ],
          videos: [{ id: "video-1", ownerId: null, owner: null }],
        },
      ],
      SHARED_TERMINAL_ARGS
    );

    expect(parsed[0]?.images[0]?.owner).toEqual({ id: "owner-1" });
    expect(parsed[0]?.videos[0]?.owner).toBeNull();

    // Same parser, both chains now warm: the required slot still refuses null.
    expect(() =>
      parseResult(
        context,
        "findMany",
        [
          {
            id: "owner-1",
            images: [
              { id: "image-1", ownerId: "owner-1", width: 4, owner: null },
            ],
            videos: [],
          },
        ],
        SHARED_TERMINAL_ARGS
      )
    ).toThrow(REQUIRED_RELATION_NULL_PATTERN);
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
    ["an absent own to-many value", undefined],
    ["a non-array to-many carrier", { id: "branch-1" }],
  ])("rejects %s before parsing nested rows", (_label, children) => {
    expect(() =>
      parseResult(
        createRecursiveRelationContext(),
        "findMany",
        [{ id: "root-1", children }],
        { include: { children: true } }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("rejects a non-object to-one carrier", () => {
    expect(() =>
      parseResult(
        createBranchRelationContext(),
        "findMany",
        [
          {
            id: "branch-1",
            rootId: "root-1",
            recordedAt: "2026-07-09T10:00:00.000Z",
            payload: {},
            parent: ["root-1"],
          },
        ],
        { include: { parent: true } }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("restores a nested negative-take window to logical order", () => {
    const parsed = parseResult<Array<{ children: Array<{ id: string }> }>>(
      createRecursiveRelationContext(),
      "findMany",
      [
        {
          id: "root-1",
          children: [
            {
              id: "branch-2",
              rootId: "root-1",
              recordedAt: "2026-07-09T11:00:00.000Z",
              payload: {},
            },
            {
              id: "branch-1",
              rootId: "root-1",
              recordedAt: "2026-07-09T10:00:00.000Z",
              payload: {},
            },
          ],
        },
      ],
      { include: { children: { take: -2 } } }
    );

    expect(parsed[0]?.children.map((child) => child.id)).toEqual([
      "branch-1",
      "branch-2",
    ]);
  });

  test("decodes a parser-owned to-one JSON carrier in place", () => {
    const carrier = { id: "root-1" };
    const jsonParse = vi.spyOn(JSON, "parse").mockReturnValue(carrier);
    const parsed = parseResult<Array<{ parent: { id: string } }>>(
      parserFor(new MySQLAdapter(), recursiveRelationModels.branch),
      "findMany",
      [
        {
          id: "branch-1",
          rootId: "root-1",
          recordedAt: "2026-07-09 10:00:00.000",
          payload: {},
          parent: "{}",
        },
      ],
      { include: { parent: true } }
    );

    expect(parsed[0]?.parent).toBe(carrier);
    expect(parsed[0]?.parent.id).toBe("root-1");
    jsonParse.mockRestore();
  });

  test("keeps the original relation carrier when driver middleware calls next without a value", () => {
    const driver = new RelationMiddlewareDriver({
      database: Object.create(null),
    });
    expect(
      parseResult(
        parserFor(driver.adapter, recursiveRelationModels.root, driver),
        "findMany",
        [{ id: "root-1", children: [] }],
        { include: { children: true } }
      )
    ).toEqual([{ id: "root-1", children: [] }]);
  });

  test("revalidates driver result replacements at the operation carrier boundary", () => {
    const rowDriver = new ReplacingResultDriver({ row: true });
    expect(() =>
      parseResult(
        parserFor(rowDriver.adapter, recursiveRelationModels.root, rowDriver),
        "findMany",
        [],
        {}
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);

    const batchDriver = new ReplacingResultDriver([]);
    expect(() =>
      parseResult(
        parserFor(
          batchDriver.adapter,
          recursiveRelationModels.root,
          batchDriver
        ),
        "createMany",
        { rowCount: 1 },
        {}
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test.each([
    ["a row array", []],
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

  test("decodes a relation-count JSON carrier", () => {
    expect(
      parseResult(
        createRecursiveRelationContext(),
        "findMany",
        [
          {
            id: "root-1",
            [RELATION_COUNTS_RESULT_KEY]: '{"children":"2"}',
          },
        ],
        RELATION_COUNT_ARGS
      )
    ).toEqual([{ id: "root-1", _count: { children: 2 } }]);
  });

  test("refuses relation counts that collide with a real _count scalar", () => {
    expect(() =>
      parseResult(
        parserFor(new PostgresAdapter(), relationCountAliasModels.root),
        "findMany",
        [],
        { include: { _count: { select: { children: true } } } }
      )
    ).toThrow(RESERVED_COUNT_FIELD_PATTERN);
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

  test("validates and decodes captured provider projections before reuse", () => {
    const parser = parserFor(
      new PostgresAdapter(),
      capturedProjectionModels.entry
    );

    expect(
      parser.parseCapturedProjection(
        "findMany",
        [{ database_id: "entry-1", database_position: "3" }],
        { select: { id: true, position: true } },
        { id: "database_id", position: "database_position" }
      )
    ).toEqual([{ id: "entry-1", position: 3 }]);
  });

  test.each([
    ["a non-array result", { database_id: "entry-1" }],
    ["a non-row member", [null]],
    ["a missing source column", [{}]],
  ])("rejects captured projections with %s", (_label, raw) => {
    const parser = parserFor(
      new PostgresAdapter(),
      capturedProjectionModels.entry
    );

    expect(() =>
      parser.parseCapturedProjection(
        "findMany",
        raw,
        { select: { id: true } },
        { id: "database_id" }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("does not invoke captured projection accessors", () => {
    const parser = parserFor(
      new PostgresAdapter(),
      capturedProjectionModels.entry
    );
    const getter = vi.fn(() => "entry-1");
    const row = Object.defineProperty({}, "database_id", {
      enumerable: true,
      get: getter,
    });

    expect(() =>
      parser.parseCapturedProjection(
        "findMany",
        [row],
        { select: { id: true } },
        { id: "database_id" }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
    expect(getter).not.toHaveBeenCalled();
  });

  test("translates hostile captured-row reflection into its result error", () => {
    const parser = parserFor(
      new PostgresAdapter(),
      capturedProjectionModels.entry
    );
    const row = new Proxy(
      { database_id: "entry-1" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("private reflection detail");
        },
      }
    );

    expect(() =>
      parser.parseCapturedProjection(
        "findMany",
        [row],
        { select: { id: true } },
        { id: "database_id" }
      )
    ).toThrow(INSPECTION_FAILED_PATTERN);
  });

  test("rejects captured projection middleware that changes row cardinality", () => {
    const driver = new DuplicatingResultDriver({
      database: Object.create(null),
    });
    const parser = parserFor(
      driver.adapter,
      capturedProjectionModels.entry,
      driver
    );

    expect(() =>
      parser.parseCapturedProjection(
        "findMany",
        [{ database_id: "entry-1" }],
        { select: { id: true } },
        { id: "database_id" }
      )
    ).toThrow(LOST_PRIVATE_COLUMN_ROW_PATTERN);
  });

  test("parses each aggregate leaf in its declared result domain", () => {
    const parsed = parseResult<{
      _count: { _all: number; id: number };
      _avg: { ratio: number };
      _sum: { exact: Decimal; quantity: number };
      _min: { observedAt: Date };
      _max: { label: string | null };
    }>(
      parserFor(new PostgresAdapter(), aggregateModels.metric),
      "aggregate",
      [
        {
          [getAggregateResultKey("_count")]: { _all: "4", id: 4n },
          [getAggregateResultKey("_avg")]: { ratio: "1.25" },
          [getAggregateResultKey("_sum")]: {
            exact: "123456789012345.67",
            quantity: 9,
          },
          [getAggregateResultKey("_min")]: {
            observedAt: "2026-08-30T12:00:00.000Z",
          },
          [getAggregateResultKey("_max")]: { label: null },
        },
      ],
      {
        _count: { _all: true, id: true },
        _avg: { ratio: true },
        _sum: { exact: true, quantity: true },
        _min: { observedAt: true },
        _max: { label: true },
      }
    );

    expect(parsed).toEqual({
      _count: { _all: 4, id: 4 },
      _avg: { ratio: 1.25 },
      _sum: { exact: expect.any(Decimal), quantity: 9 },
      _min: { observedAt: new Date("2026-08-30T12:00:00.000Z") },
      _max: { label: null },
    });
    expect(parsed._sum.exact.toFixed(2)).toBe("123456789012345.67");
  });

  test("parses a provider JSON aggregate carrier", () => {
    const parsed = parseResult<{ _count: { id: number } }>(
      parserFor(new MySQLAdapter(), aggregateModels.metric),
      "aggregate",
      [{ [getAggregateResultKey("_count")]: '{"id":"3"}' }],
      { _count: { id: true } }
    );

    expect(parsed).toEqual({ _count: { id: 3 } });
  });

  test("parses a scalar aggregate count and a selected COUNT object", () => {
    const parser = parserFor(new PostgresAdapter(), aggregateModels.metric);

    expect(
      parseResult(
        parser,
        "aggregate",
        [{ [getAggregateResultKey("_count")]: "3" }],
        { _count: true }
      )
    ).toEqual({ _count: 3 });
    expect(
      parseResult(parser, "count", [{ _all: "4", id: 3n }], {
        select: { _all: true, id: true },
      })
    ).toEqual({ _all: 4, id: 3 });
  });

  test.each([
    ["an absent carrier", {}],
    [
      "an explicitly absent carrier",
      { [getAggregateResultKey("_avg")]: undefined },
    ],
    ["a null carrier", { [getAggregateResultKey("_avg")]: null }],
    ["a primitive carrier", { [getAggregateResultKey("_avg")]: 1 }],
    ["an empty carrier", { [getAggregateResultKey("_avg")]: {} }],
    [
      "an unrequested field",
      { [getAggregateResultKey("_avg")]: { quantity: 1 } },
    ],
    [
      "a non-finite numeric leaf",
      { [getAggregateResultKey("_avg")]: { ratio: "Infinity" } },
    ],
    [
      "an absent requested leaf",
      { [getAggregateResultKey("_avg")]: { ratio: undefined } },
    ],
    ["a null count leaf", { [getAggregateResultKey("_count")]: { id: null } }],
  ])("rejects aggregate output with %s", (_label, row) => {
    const args = Object.hasOwn(row, getAggregateResultKey("_count"))
      ? { _count: { id: true } }
      : { _avg: { ratio: true } };
    expect(() =>
      parseResult(
        parserFor(new PostgresAdapter(), aggregateModels.metric),
        "aggregate",
        [row],
        args
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });

  test("rejects an inexact widened decimal sum at the scalar boundary", () => {
    expect(() =>
      parseResult(
        parserFor(new PostgresAdapter(), aggregateModels.metric),
        "aggregate",
        [
          {
            [getAggregateResultKey("_sum")]: { exact: "not-decimal" },
          },
        ],
        { _sum: { exact: true } }
      )
    ).toThrow(MALFORMED_DECIMAL_SUM_PATTERN);
  });
});

describe("coverage low value", () => {
  test("refuses an aggregate field outside the active model even under a corrupted request shape", () => {
    expect(() =>
      parseResult(
        parserFor(new PostgresAdapter(), aggregateModels.metric),
        "aggregate",
        [{ [getAggregateResultKey("_avg")]: { missing: 1 } }],
        { _avg: { missing: true } }
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });
});
