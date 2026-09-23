import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { SPAN_EXECUTE, SPAN_OPERATION } from "@instrumentation/spans";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { appendResolvedExtension } from "@src/extensions/chain";
import { instrumentation } from "@src/instrumentation/exports";
import { withOtelRecorder } from "@tests/unit/instrumentation/_capture";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it } from "vitest";

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

describe("read result and lifecycle contracts", () => {
  it("preserves public result shapes on the direct runtime path, for the arms that carry no private result key", async () => {
    // The four arms whose oracle was a SHIPPED private carrier
    // (COUNT_RESULT_KEY / getAggregateResultKey: count, exist, aggregate,
    // groupBy) went with that engine, and with them the `executionCount` of
    // eight this cell also pinned. The three arms below touch no carrier: they
    // are the base's assertions, unchanged, and they still hold.
    const driver = new ReadContractDriver(new SQLiteAdapter(), "sqlite");
    const engine = new QueryEngine(driver, registry);
    driver.rows = [
      { id: "user-1", name: "Arnaud" },
      { id: "user-2", name: "Albert" },
    ];

    await expect(
      engine.prepare(user, "findMany", { take: -2 })
    ).resolves.toEqual([...driver.rows].reverse());
    driver.rows = [{ id: "user-1", name: "Arnaud" }];
    await expect(engine.prepare(user, "findFirst", {})).resolves.toEqual(
      driver.rows[0]
    );
    driver.rows = [];
    await expect(
      engine.prepare(user, "findUnique", { where: { id: "missing" } })
    ).resolves.toBeNull();

    expect(driver.transactionCount).toBe(0);
  });

  it("wraps execution in the operation span and fails validation before execution", async () => {
    const recorder = withOtelRecorder();
    const driver = new ReadContractDriver(new SQLiteAdapter(), "sqlite");
    const extensionChain = appendResolvedExtension(
      undefined,
      instrumentation({ tracing: true }),
      schema
    );
    const engine = new QueryEngine(
      driver,
      registry,
      undefined,
      undefined,
      extensionChain
    );

    try {
      driver.rows = [{ id: "user-1", name: "Arnaud" }];
      await expect(engine.prepare(user, "findMany", {})).resolves.toEqual(
        driver.rows
      );
      // The single engine emits the user-facing operation span wrapping the
      // execute span (it validates and builds SQL at construction, without the
      // separate validate/build/parse spans V1's staged runtime used).
      expect(
        recorder
          .spans()
          .map(({ name }) => name)
          .filter((name) => [SPAN_OPERATION, SPAN_EXECUTE].includes(name))
      ).toEqual([SPAN_EXECUTE, SPAN_OPERATION]);

      const executions = driver.executionCount;
      await expect(
        engine.prepare(user, "findUnique", {})
      ).rejects.toMatchObject({ name: "ValidationError" });
      expect(driver.executionCount).toBe(executions);
    } finally {
      await recorder.dispose();
    }
  });
});
