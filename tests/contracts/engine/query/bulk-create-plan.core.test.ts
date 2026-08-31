import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { planInsertRowShapes } from "@query-engine/builders/insert-row-shapes";
import {
  buildInsert,
  buildScalarSqlValue,
  buildValueGroups,
  buildValues,
  decimalListMember,
  decimalListMembers,
  decimalLiteral,
  getScalarCastType,
  getScalarCastTypeForScalar,
  getScalarType,
  getScalarTypeForScalar,
  scalarValueLiteral,
} from "@query-engine/builders/values-builder";
import {
  buildCreate,
  buildCreateMany,
  buildCreateManyPlan,
  buildInsertStatement,
} from "@query-engine/operations/create";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import { s } from "@schema";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

class PlanDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();

  constructor() {
    super("postgresql", "bulk-plan");
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute();
  }

  protected async transaction<T>(
    _client: null,
    run: (transaction: null) => Promise<T>
  ): Promise<T> {
    return run(null);
  }
}

const item = s.model({
  id: s.int().id().increment(),
  label: s.string(),
});
const valueModel = s.model({
  id: s.int().id().increment(),
  count: s.int(),
  large: s.bigInt(),
  ratio: s.number(),
  active: s.boolean(),
  label: s.string(),
  payload: s.json().nullable(),
  location: s.point(),
  occurredAt: s.dateTime(),
  amount: s.decimal({ precision: 12, scale: 2 }),
  scores: s.int().array(),
  statuses: s.enum(["ACTIVE", "DONE"]).array(),
  amounts: s.decimal({ precision: 12, scale: 2 }).array(),
});
const generatedBigInt = s.model({
  id: s.bigInt().id().increment(),
  label: s.string(),
});
const generatedText = s.model({
  id: s.string().id().ulid(),
  label: s.string(),
});
const defaultOnly = s.model({
  id: s.int().id().increment(),
});
const schema = { item };
prepareSchema({ item, valueModel, generatedBigInt, generatedText, defaultOnly });
const engine = new QueryEngine(
  new PlanDriver(),
  createModelRegistry(schema, createSchemaRegistry(schema))
);

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

describe("bulk create planning", () => {
  test("groups only contiguous equal shapes and retains input indexes", () => {
    const groups = planInsertRowShapes(
      ["id", "label"],
      [
        { id: undefined, label: "a" },
        { id: undefined, label: "b" },
        { id: 10, label: "c" },
        { id: undefined, label: "d" },
      ],
      (_field, value) => value === undefined
    );

    expect(groups.map((group) => group.fields)).toEqual([
      ["label"],
      ["id", "label"],
      ["label"],
    ]);
    expect(groups.map((group) => group.inputIndexes)).toEqual([
      [0, 1],
      [2],
      [3],
    ]);
  });

  test("groups independently executable rows by contiguous physical shape", () => {
    const scope = scopeFor(new PostgresAdapter(), item);

    expect(buildValueGroups(scope, [])).toEqual([]);
    expect(
      buildValueGroups(scope, [
        { label: "generated-a" },
        { label: "generated-b" },
        { id: 7, label: "manual" },
        { label: "generated-c" },
      ]).map(({ columns, inputIndexes }) => ({ columns, inputIndexes }))
    ).toEqual([
      { columns: ["label"], inputIndexes: [0, 1] },
      { columns: ["id", "label"], inputIndexes: [2] },
      { columns: ["label"], inputIndexes: [3] },
    ]);
    expect(() =>
      buildValues(scope, [
        { label: "generated" },
        { id: 7, label: "manual" },
      ])
    ).toThrow(/Heterogeneous insert rows require grouped execution/);
  });

  test("refuses non-portable explicit and missing generated values", () => {
    expect(() =>
      buildValues(scopeFor(new PostgresAdapter(), item), {
        id: 0,
        label: "zero",
      })
    ).toThrow(/Explicit zero is not portable.*'id'/);
    expect(() =>
      buildValues(scopeFor(new PostgresAdapter(), generatedBigInt), {
        id: 0n,
        label: "zero",
      })
    ).toThrow(/Explicit zero is not portable.*'id'/);
    expect(() =>
      buildValues(scopeFor(new PostgresAdapter(), generatedText), {
        label: "missing",
      })
    ).toThrow(/Auto-generated value 'ulid'.*must be provided explicitly/);
    expect(
      buildValues(scopeFor(new PostgresAdapter(), generatedText), {
        id: "01JTESTVALUE",
        label: "provided",
      }).columns
    ).toEqual(["id", "label"]);
  });

  test("routes scalar values through their destination physical vocabulary", () => {
    const scope = scopeFor(new PostgresAdapter("public", true), valueModel);
    const passthrough = sql`NOW()`;

    expect(buildScalarSqlValue(scope, valueModel, "count", undefined).values).toEqual(
      []
    );
    expect(buildScalarSqlValue(scope, valueModel, "count", null).values).toEqual(
      []
    );
    expect(buildScalarSqlValue(scope, valueModel, "count", passthrough)).toBe(
      passthrough
    );
    expect(
      buildScalarSqlValue(scope, valueModel, "payload", { ready: true }).values.map(
        (value) => JSON.stringify(value)
      )
    ).toEqual(['{"ready":true}']);
    expect(
      buildScalarSqlValue(scope, valueModel, "location", {
        longitude: 2.3522,
        latitude: 48.8566,
      }).values
    ).toEqual([2.3522, 48.8566]);
    expect(
      buildScalarSqlValue(
        scope,
        valueModel,
        "occurredAt",
        "2026-08-30T12:34:56.789Z"
      ).values
    ).toEqual(["2026-08-30T12:34:56.789Z"]);
    expect(
      buildScalarSqlValue(scope, valueModel, "amount", "12.30").values
    ).toEqual(["12.3"]);
    expect(
      buildScalarSqlValue(scope, valueModel, "scores", [1, 2]).values
    ).toEqual([[1, 2]]);
    expect(
      buildScalarSqlValue(scope, valueModel, "statuses", ["ACTIVE", "DONE"])
        .values
    ).toEqual(['{"ACTIVE","DONE"}']);
    expect(
      buildScalarSqlValue(scope, valueModel, "amounts", ["1.20", "3.40"])
        .values
    ).toEqual([["1.2", "3.4"]]);
    expect(buildScalarSqlValue(scope, valueModel, "payload", DbNull).values).toEqual(
      []
    );
    expect(
      buildScalarSqlValue(scope, valueModel, "payload", JsonNull).values.map(
        (value) => JSON.stringify(value)
      )
    ).toEqual(["null"]);
    expect(() =>
      buildScalarSqlValue(scope, valueModel, "payload", AnyNull)
    ).toThrow(/AnyNull matches both nulls/);
  });

  test("keeps scalar comparison literals consistent with insert literals", () => {
    for (const adapter of [
      new PostgresAdapter("public", true),
      new MySQLAdapter(),
      new SQLiteAdapter(),
    ]) {
      const scope = scopeFor(adapter, valueModel);
      expect(scalarValueLiteral(scope, "scores", [1, 2]).values).toHaveLength(1);
      expect(scalarValueLiteral(scope, "payload", { ready: true }).values).toHaveLength(
        1
      );
      expect(
        scalarValueLiteral(scope, "location", {
          longitude: 2.3522,
          latitude: 48.8566,
        }).values
      ).toHaveLength(2);
      expect(
        scalarValueLiteral(
          scope,
          "occurredAt",
          "2026-08-30T12:34:56.789Z"
        ).values
      ).toHaveLength(1);
      expect(scalarValueLiteral(scope, "amount", "12.30").values).toHaveLength(
        1
      );
      expect(scalarValueLiteral(scope, "payload", DbNull).values).toEqual([]);
    }
  });

  test("decimal scalar and list boundaries fail closed without exact meaning", () => {
    const descriptor = { precision: 12, scale: 2 };

    expect(() =>
      decimalLiteral(new PostgresAdapter(), "amount", "1.20", undefined)
    ).toThrow(/has no declared precision and scale/);
    expect(() =>
      decimalLiteral(new PostgresAdapter(), "amount", {}, descriptor)
    ).toThrow(/not an exact decimal/);
    expect(() =>
      decimalListMember(new SQLiteAdapter(), "amounts", {}, descriptor)
    ).toThrow(/received a member that is not an exact decimal/);
    expect(() =>
      decimalListMembers(new SQLiteAdapter(), "amounts", ["1.20", {}], descriptor)
    ).toThrow(/received a member that is not an exact decimal/);
    expect(
      decimalListMember(new SQLiteAdapter(), "amounts", "1.20", descriptor)
        .values
    ).toEqual(["120"]);
    expect(
      decimalListMembers(
        new SQLiteAdapter(),
        "amounts",
        ["1.20", "3.40"],
        descriptor
      )
    ).toEqual(["120", "340"]);
  });

  test("reports scalar type and deferred relation cast from one destination owner", () => {
    expect(getScalarType(valueModel, "count")).toBe("int");
    expect(getScalarType(valueModel, "missing")).toBeUndefined();
    expect(getScalarTypeForScalar(valueModel["~"].state.scalars.large)).toBe(
      "bigint"
    );
    expect(getScalarTypeForScalar(undefined)).toBeUndefined();

    expect(getScalarCastType(valueModel, "count")).toBe("integer");
    expect(getScalarCastType(valueModel, "large")).toBe("integer");
    expect(getScalarCastType(valueModel, "ratio")).toBe("numeric");
    expect(getScalarCastType(valueModel, "active")).toBe("boolean");
    expect(getScalarCastType(valueModel, "label")).toBe("text");
    expect(getScalarCastType(valueModel, "occurredAt")).toBeUndefined();
    expect(
      getScalarCastTypeForScalar(valueModel["~"].state.scalars.count)
    ).toBe("integer");
    expect(
      getScalarCastTypeForScalar(valueModel["~"].state.scalars.ratio)
    ).toBe("numeric");
    expect(
      getScalarCastTypeForScalar(valueModel["~"].state.scalars.active)
    ).toBe("boolean");
    expect(
      getScalarCastTypeForScalar(valueModel["~"].state.scalars.label)
    ).toBe("text");
    expect(
      getScalarCastTypeForScalar(valueModel["~"].state.scalars.occurredAt)
    ).toBeUndefined();
  });

  test("builds default-row and explicit-row inserts through the adapter", () => {
    const scope = scopeFor(new PostgresAdapter(), item);
    expect(buildInsert(scope, "item", {}).toStatement("$n")).toContain(
      "DEFAULT VALUES"
    );
    expect(
      buildInsert(scope, "item", { id: 7, label: "manual" }).toStatement("$n")
    ).toContain('("id", "label") VALUES ($1, $2)');
  });

  test("assembles returning, non-returning, and default-only create statements", () => {
    const postgresScope = scopeFor(new PostgresAdapter(), item);
    const mysqlScope = scopeFor(new MySQLAdapter(), item);

    expect(
      buildCreate(postgresScope, {
        data: { label: "created" },
        select: { id: true },
      }).toStatement("$n")
    ).toContain("RETURNING");
    expect(
      buildCreate(mysqlScope, {
        data: { label: "created" },
        select: { id: true },
      }).toStatement("?")
    ).not.toContain("RETURNING");
    expect(
      buildInsertStatement(scopeFor(new PostgresAdapter(), defaultOnly), {})
        .toStatement("$n")
    ).toContain("DEFAULT VALUES");
  });

  test("keeps default-only and non-returning bulk rows independently addressable", () => {
    const defaults = buildCreateManyPlan(
      scopeFor(new PostgresAdapter(), defaultOnly),
      { data: [{}, {}] },
      false
    );
    const mysqlReturning = buildCreateManyPlan(
      scopeFor(new MySQLAdapter(), item),
      { data: [{ label: "first" }, { label: "second" }] },
      true
    );

    expect(defaults.statements).toHaveLength(2);
    expect(defaults.statements.map((statement) => statement.inputIndexes)).toEqual([
      [0],
      [1],
    ]);
    expect(mysqlReturning.statements).toHaveLength(2);
    expect(
      mysqlReturning.statements.map((statement) => statement.inputIndexes)
    ).toEqual([[0], [1]]);
  });

  test("fails closed on a short provider result window", async () => {
    const prepared = await transactionOperation(
      engine.prepare<{ count: number }>(item, "createMany", {
        data: [{ label: "first" }, { id: 10, label: "second" }],
      })
    ).prepareBatch();
    if (!prepared) throw new Error("bulk program was not batch-lowerable");

    // A short provider result window fails closed: the missing statement's output
    // leaves a batch reference unresolved rather than silently reporting a wrong
    // count.
    expect(() => prepared.parseResult([{ rows: [], rowCount: 1 }])).toThrow(
      "is unresolved"
    );
  });

  describe("coverage low value: validated create payload boundaries", () => {
    test("fails closed below operation-schema validation", () => {
      const scope = scopeFor(new PostgresAdapter(), item);

      expect(() => buildCreateManyPlan(scope, { data: [] }, false)).toThrow(
        "No data to insert for createMany"
      );
      expect(() =>
        buildCreateManyPlan(scope, { data: "not-an-array" }, false)
      ).toThrow("missing a data array");
      expect(() =>
        buildCreateMany(scope, [
          { label: "generated" },
          { id: 7, label: "manual" },
        ])
      ).toThrow("Cannot build createMany as one SQL statement");
    });
  });
});
