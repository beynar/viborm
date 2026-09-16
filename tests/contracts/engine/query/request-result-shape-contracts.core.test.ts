import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { ValidationError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { parseResult } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

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

describe("request-aware result shapes", () => {
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
