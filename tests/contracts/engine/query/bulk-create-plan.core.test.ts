import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { planInsertRowShapes } from "@query-engine/builders/insert-row-shapes";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
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
const schema = { item };
hydrateSchemaNames(schema);
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
});
