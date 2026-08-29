import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { QueryEngineError, ValidationError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { parseResult } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import { type Model, s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const DUPLICATE_GROUP_BY_PATTERN = /duplicate/i;
const EMPTY_SELECT_PATTERN = /at least one truthy value/i;
const INVALID_IDENTIFIER_PATTERN = /invalid identifier/i;
const NULLABLE_VECTOR_PATTERN = /nullable vector/i;
const PROTOTYPE_COLLISION_IDENTIFIERS = [
  "__proto__",
  "constructor",
  "toString",
] as const;

class ShapeContractDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  private readonly rows: unknown[];

  constructor(adapter: DatabaseAdapter, rows: unknown[] = []) {
    super("postgresql", "shape-contract");
    this.adapter = adapter;
    this.rows = rows;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // No provider resource to release.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (tx: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const LONG_RELATION_NAME =
  "archivedItemRelationNameFortyOneCharsLongBoundaryTwentyTwoChars";

const models = (() => {
  const parent = s.model({
    id: s.string().id(),
    secret: s.string(),
    _count_children: s.string(),
    children: s.toMany(() => child),
    [LONG_RELATION_NAME]: s.toMany(() => longChild),
  });

  const child = s.model({
    id: s.string().id(),
    parentId: s.string(),
    secret: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });

  const omitted = s
    .model({
      id: s.string().id(),
      secret: s.string(),
    })
    .omit({ secret: true });

  const grouped = s.model({
    _count: s.string(),
    _avg: s.string(),
    category: s.string().map("db_category"),
    score: s.int(),
  });

  const longChild = s.model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });

  const emptyParent = s
    .model({
      id: s.string().id(),
      children: s.toMany(() => emptyChild),
    })
    .omit({ id: true });

  const emptyChild = s
    .model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => emptyParent)
        .fields("parentId")
        .references("id"),
    })
    .omit({ id: true, parentId: true });

  const vectorCollision = s.model({
    id: s.string().id(),
    _distance: s.string(),
    embedding: s.vector().dimension(2),
  });

  const nullableVector = s.model({
    id: s.string().id(),
    embedding: s.vector().dimension(2).nullable(),
  });

  return {
    parent,
    child,
    longChild,
    omitted,
    grouped,
    vectorCollision,
    nullableVector,
    emptyParent,
    emptyChild,
  };
})();

prepareSchema(models);
const schemaRegistry = createSchemaRegistry(models);
const registry = createModelRegistry(models, schemaRegistry);

function createEngine(
  rows: unknown[] = [],
  adapter: DatabaseAdapter = new PostgresAdapter()
): QueryEngine {
  adapter.capabilities.supportsVector = true;
  return new QueryEngine(new ShapeContractDriver(adapter, rows), registry);
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

function parsePrepared(
  model: Model<any>,
  operation: "findMany" | "aggregate" | "groupBy",
  args: Record<string, unknown>,
  rows: unknown[],
  adapter?: DatabaseAdapter
): unknown {
  const prepared = createEngine([], adapter).prepare(model, operation, args);
  return transactionOperation(prepared).parseResult({
    rows,
    rowCount: rows.length,
  });
}

describe("request-aware result shapes", () => {
  test("rejects known but unrequested and uniformly missing scalar columns", () => {
    expect(() =>
      parsePrepared(models.parent, "findMany", { select: { id: true } }, [
        { id: "parent-1", secret: "leaked" },
      ])
    ).toThrow(QueryEngineError);

    expect(() =>
      parsePrepared(
        models.parent,
        "findMany",
        { select: { id: true, secret: true } },
        [{ id: "parent-1" }]
      )
    ).toThrow(QueryEngineError);
  });

  test("enforces the requested projection on direct execution", async () => {
    const engine = createEngine([{ id: "parent-1", secret: "leaked" }]);

    await expect(
      engine.execute(models.parent, "findMany", {
        select: { id: true },
      })
    ).rejects.toBeInstanceOf(QueryEngineError);
  });

  test("enforces requested nested include shapes and preserves empty relations", () => {
    const args = {
      include: { children: { select: { id: true } } },
    };
    const base = {
      id: "parent-1",
      secret: "parent-secret",
      _count_children: "ordinary scalar",
    };

    expect(() =>
      parsePrepared(models.parent, "findMany", args, [base])
    ).toThrow(QueryEngineError);
    expect(() =>
      parsePrepared(models.parent, "findMany", args, [
        {
          ...base,
          children: [{ id: "child-1", secret: "leaked" }],
        },
      ])
    ).toThrow(QueryEngineError);
    expect(() =>
      parsePrepared(models.parent, "findMany", args, [
        { ...base, children: [{}] },
      ])
    ).toThrow(QueryEngineError);

    expect(
      parsePrepared(models.parent, "findMany", args, [
        { ...base, children: [] },
      ])
    ).toEqual([{ ...base, children: [] }]);
  });

  test("honors model-level omit in default SQL and result parsing", () => {
    const engine = createEngine();
    const statement = engine
      .build(models.omitted, "findMany", {})
      .toStatement("$n");

    expect(statement).toContain('"t0"."id" AS "id"');
    expect(statement).not.toContain('"t0"."secret" AS "secret"');
    expect(
      transactionOperation(
        engine.prepare(models.omitted, "findMany", {})
      ).parseResult({ rows: [{ id: "visible" }], rowCount: 1 })
    ).toEqual([{ id: "visible" }]);
    expect(() =>
      transactionOperation(
        engine.prepare(models.omitted, "findMany", {})
      ).parseResult({
        rows: [{ id: "visible", secret: "leaked" }],
        rowCount: 1,
      })
    ).toThrow(QueryEngineError);
  });

  /**
   * PLAN 10.1 — the row-key check is SET semantics, and the two owners' orders
   * already disagree.
   *
   * The SQL builder emits scalar columns in the model's DECLARATION order: it
   * walks `getScalarFieldNames` and takes the ones the select names, so the
   * request's own key order never reaches the statement. The expected shape
   * records `rawKeys` in REQUEST order instead — it walks `Object.entries` of the
   * parsed select, and a fully-partial object schema materializes input keys
   * first. Nothing observes the difference, because `assertExpectedRowKeys`
   * compares LENGTH plus MEMBERSHIP and never position.
   *
   * Pinned before those two orders can become one fact: a consumer that started
   * reading `rawKeys` positionally would be depending on an order neither owner
   * promises, and the failure would be a silently mis-parsed row rather than a
   * refusal.
   */
  test("row keys are checked as a set, not as an order", () => {
    const select = { _count_children: true, secret: true, id: true };
    const statement = createEngine()
      .build(models.parent, "findMany", { select })
      .toStatement("$n");

    // The SQL list is schema order, though the request asked in the reverse.
    expect(statement).toContain(
      '"t0"."id" AS "id", "t0"."secret" AS "secret", "t0"."_count_children" AS "_count_children"'
    );

    // A row whose keys arrive in a THIRD order parses, and keeps its values.
    expect(
      parsePrepared(models.parent, "findMany", { select }, [
        { secret: "s", _count_children: "c", id: "parent-1" },
      ])
    ).toEqual([{ id: "parent-1", secret: "s", _count_children: "c" }]);

    // Both halves of the check are load-bearing: a short row and a long row
    // fail on LENGTH, and a right-sized row with a wrong key fails on
    // MEMBERSHIP — which is what makes the order-freedom above non-vacuous.
    for (const row of [
      { id: "parent-1", secret: "s" },
      { id: "parent-1", secret: "s", _count_children: "c", extra: "x" },
      { id: "parent-1", secret: "s", unexpected: "x" },
    ]) {
      expect(() =>
        parsePrepared(models.parent, "findMany", { select }, [row])
      ).toThrow(QueryEngineError);
    }
  });

  test("keeps relation-count carriers distinct from same-named scalars", () => {
    const args = {
      select: {
        id: true,
        _count_children: true,
        _count: { select: { children: true } },
      },
    };
    const statement = createEngine()
      .build(models.parent, "findMany", args)
      .toStatement("$n");

    expect(statement).toContain('AS "_count_children"');
    expect(statement).toContain(`AS "${RELATION_COUNTS_RESULT_KEY}"`);
    expect(
      parsePrepared(models.parent, "findMany", args, [
        {
          id: "parent-1",
          _count_children: "ordinary scalar",
          [RELATION_COUNTS_RESULT_KEY]: { children: "2" },
        },
      ])
    ).toEqual([
      {
        id: "parent-1",
        _count_children: "ordinary scalar",
        _count: { children: 2 },
      },
    ]);
  });

  test("uses one short exact relation-count carrier across dialects", () => {
    const args = {
      select: {
        id: true,
        _count: {
          select: { children: true, [LONG_RELATION_NAME]: true },
        },
      },
    };
    const statement = createEngine()
      .build(models.parent, "findMany", args)
      .toStatement("$n");
    const carrierAlias = `AS "${RELATION_COUNTS_RESULT_KEY}"`;

    expect(statement.split(carrierAlias)).toHaveLength(2);
    expect(LONG_RELATION_NAME).toHaveLength(63);
    expect(
      new TextEncoder().encode(RELATION_COUNTS_RESULT_KEY).length
    ).toBeLessThan(63);
    expect(statement).not.toContain(
      `AS "0viborm_relation_count:${LONG_RELATION_NAME}"`
    );

    const expected = [
      {
        id: "parent-1",
        _count: { children: 2, [LONG_RELATION_NAME]: 1 },
      },
    ];
    const counts = { children: "2", [LONG_RELATION_NAME]: "1" };
    expect(
      parsePrepared(models.parent, "findMany", args, [
        { id: "parent-1", [RELATION_COUNTS_RESULT_KEY]: counts },
      ])
    ).toEqual(expected);

    for (const adapter of [new SQLiteAdapter(), new MySQLAdapter()]) {
      expect(
        parsePrepared(
          models.parent,
          "findMany",
          args,
          [
            {
              id: "parent-1",
              [RELATION_COUNTS_RESULT_KEY]: JSON.stringify(counts),
            },
          ],
          adapter
        )
      ).toEqual(expected);
    }
  });

  test.each([
    ["missing carrier", { id: "parent-1" }],
    [
      "missing inner relation",
      {
        id: "parent-1",
        [RELATION_COUNTS_RESULT_KEY]: { children: 2 },
      },
    ],
    [
      "extra inner relation",
      {
        id: "parent-1",
        [RELATION_COUNTS_RESULT_KEY]: {
          children: 2,
          [LONG_RELATION_NAME]: 1,
          unexpected: 3,
        },
      },
    ],
    ["primitive carrier", { id: "parent-1", [RELATION_COUNTS_RESULT_KEY]: 2 }],
  ])("rejects a relation-count row with %s", (_label, row) => {
    expect(() =>
      parsePrepared(
        models.parent,
        "findMany",
        {
          select: {
            id: true,
            _count: {
              select: { children: true, [LONG_RELATION_NAME]: true },
            },
          },
        },
        [row]
      )
    ).toThrow(QueryEngineError);
  });

  test("maps private aggregate carriers and rejects missing aggregate fields", () => {
    const args = {
      _count: true,
      _sum: { score: true },
    };
    const countKey = getAggregateResultKey("_count");
    const sumKey = getAggregateResultKey("_sum");

    expect(
      parsePrepared(models.grouped, "aggregate", args, [
        { [countKey]: "3", [sumKey]: { score: "7" } },
      ])
    ).toEqual({ _count: 3, _sum: { score: 7 } });
    expect(() =>
      parsePrepared(models.grouped, "aggregate", args, [{ [countKey]: "3" }])
    ).toThrow(QueryEngineError);
    expect(() =>
      parsePrepared(models.grouped, "aggregate", args, [
        {
          [countKey]: "3",
          [sumKey]: { score: "7", category: "8" },
        },
      ])
    ).toThrow(QueryEngineError);
  });

  test("fails closed when grouped scalars collide with public aggregates", () => {
    const engine = createEngine();

    expect(() =>
      engine.build(models.grouped, "groupBy", {
        by: "_count",
        _count: true,
      })
    ).toThrow("both grouped scalar '_count' and aggregate '_count'");
    expect(() =>
      engine.build(models.grouped, "groupBy", {
        by: "_avg",
        _avg: { score: true },
      })
    ).toThrow("both grouped scalar '_avg' and aggregate '_avg'");

    const countKey = getAggregateResultKey("_count");
    const statement = engine
      .build(models.grouped, "groupBy", {
        by: "category",
        _count: true,
      })
      .toStatement("$n");
    expect(statement).toContain('"t0"."db_category" AS "category"');
    expect(
      parsePrepared(
        models.grouped,
        "groupBy",
        { by: "category", _count: true },
        [{ category: "a", [countKey]: "2" }]
      )
    ).toEqual([{ category: "a", _count: 2 }]);
  });

  test.each([
    ["empty", []],
    ["non-empty", [{ category: "a" }]],
  ])("rejects duplicate groupBy fields for a %s result", (_label, rows) => {
    expect(() =>
      parsePrepared(
        models.grouped,
        "groupBy",
        { by: ["category", "category"] },
        rows
      )
    ).toThrow(DUPLICATE_GROUP_BY_PATTERN);
  });

  test("rejects private carriers that were not requested", () => {
    const rows = [
      { [getAggregateResultKey("_count")]: 1 },
      { [DISTANCE_RESULT_KEY]: 1 },
      { [RELATION_COUNTS_RESULT_KEY]: { children: 1 } },
    ];
    for (const row of rows) {
      expect(() =>
        parsePrepared(models.parent, "findMany", { select: { id: true } }, [
          row,
        ])
      ).toThrow(QueryEngineError);
    }
  });

  test("rejects private carrier names during client hydration", () => {
    const invalidParent = s.model({
      id: s.string().id(),
      [DISTANCE_RESULT_KEY]: s.toMany(() => invalidChild),
    });
    const invalidChild = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => invalidParent)
        .fields("parentId")
        .references("id"),
    });

    expect(() =>
      createClient({
        schema: { invalidParent, invalidChild },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);

    const invalidScalar = s.model({
      id: s.string().id(),
      [RELATION_COUNTS_RESULT_KEY]: s.string(),
    });
    expect(() =>
      createClient({
        schema: { invalidScalar },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);

    const tooLongRelationName = `r${"x".repeat(63)}`;
    const longParent = s.model({
      id: s.string().id(),
      [tooLongRelationName]: s.toMany(() => longChild),
    });
    const longChild = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => longParent)
        .fields("parentId")
        .references("id"),
    });
    expect(() =>
      createClient({
        schema: { longParent, longChild },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);
  });

  test("rejects empty mapped identifiers during client hydration", () => {
    const emptyTable = s.model({ id: s.string().id() }).map("");
    expect(() =>
      createClient({
        schema: { emptyTable },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);

    const emptyColumn = s.model({
      id: s.string().id(),
      value: s.string().map(""),
    });
    expect(() =>
      createClient({
        schema: { emptyColumn },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);
  });

  test.each(
    PROTOTYPE_COLLISION_IDENTIFIERS
  )("rejects scalar and relation key %j during client hydration", (identifier) => {
    const invalidScalar = s.model({
      id: s.string().id(),
      [identifier]: s.string(),
    });
    expect(() =>
      createClient({
        schema: { invalidScalar },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);

    const invalidParent = s.model({
      id: s.string().id(),
      [identifier]: s.toMany(() => invalidChild),
    });
    const invalidChild = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => invalidParent)
        .fields("parentId")
        .references("id"),
    });
    expect(() =>
      createClient({
        schema: { invalidParent, invalidChild },
        driver: new ShapeContractDriver(new PostgresAdapter()),
      })
    ).toThrow(INVALID_IDENTIFIER_PATTERN);
  });

  test.each(
    PROTOTYPE_COLLISION_IDENTIFIERS
  )("rejects inherited request key %j without a raw TypeError", (identifier) => {
    const select = Object.fromEntries([[identifier, true]]);
    const findMany = createEngine().prepare(models.parent, "findMany", {
      select,
    });

    // An inherited request key is rejected with a typed ValidationError — never a
    // raw TypeError from a prototype-chain collision. The engine validates the
    // request at construction, so both the prepare and the parse seams surface the
    // same typed rejection.
    expect(() => transactionOperation(findMany).prepare()).toThrow(
      ValidationError
    );
    expect(() =>
      transactionOperation(findMany).parseResult({ rows: [], rowCount: 0 })
    ).toThrow(ValidationError);

    const count = createEngine().prepare(models.parent, "count", { select });
    const row = Object.fromEntries([[identifier, "1"]]);
    expect(() =>
      transactionOperation(count).parseResult({ rows: [row], rowCount: 1 })
    ).toThrow(ValidationError);
  });

  test("preserves cardinality for models with no public default scalars", () => {
    for (const adapter of [
      new PostgresAdapter(),
      new SQLiteAdapter(),
      new MySQLAdapter(),
    ]) {
      const statement = createEngine([], adapter)
        .build(models.emptyParent, "findMany", {})
        .toStatement();
      expect(statement).toContain(EMPTY_ROW_RESULT_KEY);
    }

    expect(
      parsePrepared(models.emptyParent, "findMany", {}, [
        { [EMPTY_ROW_RESULT_KEY]: 1 },
        { [EMPTY_ROW_RESULT_KEY]: "1" },
      ])
    ).toEqual([{}, {}]);

    expect(
      parsePrepared(
        models.emptyParent,
        "findMany",
        { include: { children: true } },
        [
          {
            children: [
              { [EMPTY_ROW_RESULT_KEY]: 1 },
              { [EMPTY_ROW_RESULT_KEY]: 1 },
            ],
          },
        ]
      )
    ).toEqual([{ children: [{}, {}] }]);

    expect(() =>
      createEngine().build(models.emptyParent, "findMany", { select: {} })
    ).toThrow(EMPTY_SELECT_PATTERN);
    expect(() =>
      parsePrepared(models.emptyParent, "findMany", { select: {} }, [])
    ).toThrow(EMPTY_SELECT_PATTERN);
  });

  test("carries and strips all-omitted held records", () => {
    const context = parserFor(new PostgresAdapter(), models.emptyParent);
    const heldRecord = { [EMPTY_ROW_RESULT_KEY]: 1 };

    expect(heldRecord).toEqual({ [EMPTY_ROW_RESULT_KEY]: 1 });
    expect(parseResult(context, "findUnique", [heldRecord], {})).toEqual({});

    const parseWithoutArgs = () =>
      // @ts-expect-error request-aware findUnique parsing requires explicit args
      parseResult(context, "findUnique", [heldRecord]);
    expect(parseWithoutArgs).toBeTypeOf("function");
  });

  test("fails closed on simultaneous scalar and computed _distance output", () => {
    expect(() =>
      createEngine().build(models.vectorCollision, "findMany", {
        select: {
          _distance: true,
          embedding: {
            _distance: { to: [1, 2], metric: "l2" },
          },
        },
      })
    ).toThrow("cannot be selected together");
  });

  test("retains the scalar that owns a computed distance", () => {
    const shape = buildExpectedResultShape(
      models.vectorCollision,
      "findMany",
      {
        select: {
          embedding: {
            _distance: { to: [1, 2], metric: "l2" },
          },
        },
      },
      registry.relations
    );

    expect(shape?.distanceScalar).toBe(
      models.vectorCollision["~"].state.scalars.embedding
    );
  });

  test("rejects only nullable-vector distance selection", () => {
    const engine = createEngine();

    expect(() =>
      engine.build(models.nullableVector, "findMany", {
        select: {
          embedding: {
            _distance: { to: [1, 2], metric: "l2" },
          },
        },
      })
    ).toThrow(NULLABLE_VECTOR_PATTERN);

    expect(
      engine
        .build(models.nullableVector, "findMany", {
          select: { embedding: true },
        })
        .toStatement("$n")
    ).toContain('AS "embedding"');

    expect(
      engine
        .build(models.nullableVector, "findMany", {
          select: { id: true },
          orderBy: {
            embedding: {
              _distance: { to: [1, 2], metric: "l2" },
            },
          },
        })
        .toStatement("$n")
    ).toContain("ORDER BY");
  });
});
