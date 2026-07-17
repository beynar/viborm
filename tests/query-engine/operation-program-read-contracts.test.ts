import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { type Dialect, Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import type { InstrumentationContext } from "@instrumentation/context";
import {
  SPAN_BUILD,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_PARSE,
  SPAN_VALIDATE,
} from "@instrumentation/spans";
import type { TracerWrapper, VibORMSpanOptions } from "@instrumentation/tracer";
import { createQueryScope } from "@query-engine/context";
import type { ProgramReadOperation } from "@query-engine/operation-program";
import {
  buildAggregate,
  buildCount,
  buildFind,
  buildFindUnique,
  buildGroupBy,
} from "@query-engine/operations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { getAggregateResultKey } from "@query-engine/result-aliases";
import { hydrateSchemaNames, s } from "@schema";
import type { Sql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it } from "vitest";

class RecordingTracer implements TracerWrapper {
  readonly names: string[] = [];

  startActiveSpan<T>(
    options: VibORMSpanOptions,
    execute: () => T | Promise<T>
  ): Promise<T> {
    this.names.push(options.name);
    return Promise.resolve(execute());
  }

  startActiveSpanSync<T>(options: VibORMSpanOptions, execute: () => T): T {
    this.names.push(options.name);
    return execute();
  }

  isEnabled(): boolean {
    return true;
  }
}

class ReadContractDriver extends Driver<
  { ready: true },
  { transaction: true }
> {
  readonly adapter: DatabaseAdapter;
  rows: unknown[] = [];
  executionCount = 0;
  transactionCount = 0;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `read-contract-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient(): Promise<{ ready: true }> {
    return { ready: true };
  }

  protected async closeClient(): Promise<void> {
    // No provider resource is opened by this in-memory test driver.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.executionCount += 1;
    return {
      rows: this.rows as T[],
      rowCount: this.rows.length,
    };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute();
  }

  protected async transaction<T>(
    _client: { ready: true },
    execute: (transaction: { transaction: true }) => Promise<T>
  ): Promise<T> {
    this.transactionCount += 1;
    return execute({ transaction: true });
  }
}

const user = s.model({ id: s.string().id(), name: s.string() });
const schema = { user };
hydrateSchemaNames(schema);
const registry = createModelRegistry(schema, createSchemaRegistry(schema));

const cases: readonly [ProgramReadOperation, Record<string, unknown>][] = [
  ["findUnique", { where: { id: "user-1" } }],
  ["findFirst", { where: { name: "Arnaud" }, orderBy: { id: "asc" } }],
  ["findMany", { where: { name: "Arnaud" }, take: 5 }],
  ["count", {}],
  ["exist", { where: { name: "Arnaud" } }],
  ["aggregate", { _count: true }],
  ["groupBy", { by: "name", _count: true }],
];

function buildLegacy(
  driver: ReadContractDriver,
  operation: ProgramReadOperation,
  args: Record<string, unknown>
): Sql {
  const ctx = createQueryScope(driver.adapter, user);
  if (operation === "findUnique") {
    return buildFindUnique(ctx, args as { where: Record<string, unknown> });
  }
  if (operation === "findFirst") return buildFind(ctx, args, { limit: 1 });
  if (operation === "findMany") {
    return buildFind(ctx, args, { limit: args.take as number | undefined });
  }
  if (operation === "count" || operation === "exist") {
    return buildCount(ctx, args);
  }
  if (operation === "aggregate") return buildAggregate(ctx, args);
  return buildGroupBy(ctx, args as { by: string | string[] });
}

describe("OperationProgram read contracts", () => {
  it.each([
    [new PostgresAdapter(), "postgresql"],
    [new MySQLAdapter(), "mysql"],
    [new SQLiteAdapter(), "sqlite"],
  ] as const)("preserves byte-for-byte SQL and parameters on %s", (adapter, dialect) => {
    const driver = new ReadContractDriver(adapter, dialect);
    const engine = new QueryEngine(driver, registry);

    for (const [operation, args] of cases) {
      const program = engine.prepare(user, operation, args).compile();
      const prepared = engine.prepare(user, operation, args).prepare();
      if (!prepared) throw new Error("read program was not preparable");
      const compiled = { sql: prepared.sql, params: prepared.params };
      const legacy = driver._prepare(
        buildLegacy(driver, operation, program.result.args)
      );

      expect(compiled).toEqual(legacy);
      expect(program).toMatchObject({
        atomicity: "statement",
        steps: [{ id: "read:0", kind: "read" }],
        result: {
          source: {
            kind: "rows",
            results: [{ step: "read:0", result: "read:0:result" }],
          },
          operation,
        },
      });
      expect(program.steps).toHaveLength(1);
      if (!("shape" in program.result && program.result.shape)) {
        throw new Error("read program omitted its result shape");
      }
      expect(program.result.shape.carrier).toBe(
        operation === "exist"
          ? "existence"
          : operation === "count"
            ? "count"
            : "rows"
      );
      expect(engine.prepare(user, operation, args).prepare(driver)).toEqual({
        ...compiled,
        params: compiled.params ?? [],
        context: expect.objectContaining({ operation }),
      });
    }
  });

  it("preserves public result shapes on the direct runtime path", async () => {
    const driver = new ReadContractDriver(new SQLiteAdapter(), "sqlite");
    const engine = new QueryEngine(driver, registry);
    driver.rows = [
      { id: "user-1", name: "Arnaud" },
      { id: "user-2", name: "Albert" },
    ];

    await expect(
      engine.prepare(user, "findMany", { take: -2 }).execute()
    ).resolves.toEqual([...driver.rows].reverse());
    driver.rows = [{ id: "user-1", name: "Arnaud" }];
    await expect(
      engine.prepare(user, "findFirst", {}).execute()
    ).resolves.toEqual(driver.rows[0]);
    driver.rows = [];
    await expect(
      engine.prepare(user, "findUnique", { where: { id: "missing" } }).execute()
    ).resolves.toBeNull();
    driver.rows = [{ [COUNT_RESULT_KEY]: 2 }];
    await expect(engine.prepare(user, "count", {}).execute()).resolves.toBe(2);
    driver.rows = [{ [COUNT_RESULT_KEY]: 0 }];
    await expect(engine.prepare(user, "exist", {}).execute()).resolves.toBe(
      false
    );
    driver.rows = [{ [COUNT_RESULT_KEY]: 1 }];
    await expect(engine.prepare(user, "exist", {}).execute()).resolves.toBe(
      true
    );
    const countKey = getAggregateResultKey("_count");
    driver.rows = [{ [countKey]: 2 }];
    await expect(
      engine.prepare(user, "aggregate", { _count: true }).execute()
    ).resolves.toEqual({ _count: 2 });
    driver.rows = [{ name: "Arnaud", [countKey]: 1 }];
    await expect(
      engine.prepare(user, "groupBy", { by: "name", _count: true }).execute()
    ).resolves.toEqual([{ name: "Arnaud", _count: 1 }]);

    expect(driver.executionCount).toBe(8);
    expect(driver.transactionCount).toBe(0);
  });

  it("preserves lifecycle span order and fails validation before execution", async () => {
    const tracer = new RecordingTracer();
    const instrumentation: InstrumentationContext = {
      config: { tracing: true },
      tracer,
    };
    const driver = new ReadContractDriver(new SQLiteAdapter(), "sqlite");
    const engine = new QueryEngine(driver, registry, instrumentation);
    driver.rows = [{ id: "user-1", name: "Arnaud" }];

    await expect(
      engine.prepare(user, "findMany", {}).execute()
    ).resolves.toEqual(driver.rows);
    expect(
      tracer.names.filter((name) =>
        [
          SPAN_OPERATION,
          SPAN_VALIDATE,
          SPAN_BUILD,
          SPAN_EXECUTE,
          SPAN_PARSE,
        ].includes(name)
      )
    ).toEqual([
      SPAN_OPERATION,
      SPAN_VALIDATE,
      SPAN_BUILD,
      SPAN_EXECUTE,
      SPAN_PARSE,
    ]);

    const executions = driver.executionCount;
    await expect(
      engine.prepare(user, "findUnique", {}).execute()
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(driver.executionCount).toBe(executions);
  });
});
