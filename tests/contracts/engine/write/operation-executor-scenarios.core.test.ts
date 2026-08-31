import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers/driver";
import { NotFoundError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import type { CommittedBatchNotification } from "@src/drivers/types";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      email: s.string().unique(),
      score: s.int(),
      notes: s.toMany(() => note),
    })
    .map("executor_scenario_accounts");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      accountId: s.int(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("executor_scenario_notes");
  return { account, note };
})();

hydrateSchemaNames(schema);
validateClientSchemaOrThrow(schema);

type ExecutionMode = "batch" | "transaction";

interface DriverScenario {
  readonly mode: ExecutionMode;
  readonly emptyDirectResult?: boolean;
  readonly emptyUpdateResult?: boolean;
  readonly failBatchGuard?: boolean;
}

class ScenarioDriver extends Driver<null, null> {
  readonly adapter = new PostgresAdapter();
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;
  readonly statements: string[] = [];
  readonly batches: string[][] = [];
  transactions = 0;
  private readonly scenario: DriverScenario;

  constructor(scenario: DriverScenario) {
    super("postgresql", `executor-${scenario.mode}`);
    this.scenario = scenario;
    this.supportsTransactions = scenario.mode === "transaction";
    this.supportsBatch = true;
  }

  protected initClient(): Promise<null> {
    return Promise.resolve(null);
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    _client: null,
    statement: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return Promise.resolve(this.response<T>(statement, false));
  }

  protected executeRaw<T>(
    client: null,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement, params ?? [], context);
  }

  protected transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    this.transactions += 1;
    return execute(null);
  }

  protected override async executeBatch<T>(
    _client: null,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    const results = queries.map((query) => this.response<T>(query.sql, true));
    await committed?.();
    return results;
  }

  private response<T>(statement: string, inBatch: boolean): QueryResult<T> {
    if (
      statement.startsWith("INSERT") &&
      statement.includes('"executor_scenario_accounts"')
    ) {
      const rows = this.scenario.emptyDirectResult
        ? []
        : [{ id: 1, email: "one@example.test", score: 1 }];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      statement.startsWith("UPDATE") &&
      statement.includes('"executor_scenario_accounts"')
    ) {
      const rows = this.scenario.emptyUpdateResult ? [] : [{ id: 1 }];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      statement.startsWith("SELECT") &&
      statement.includes('"executor_scenario_accounts"')
    ) {
      const isBatchGuard = inBatch && statement.includes("LIMIT 1");
      const rows =
        isBatchGuard && this.scenario.failBatchGuard
          ? []
          : [
              {
                id: 1,
                email: "one@example.test",
                score: statement.includes("FOR UPDATE") ? 1 : 2,
              },
            ];
      return { rows: rows as T[], rowCount: rows.length };
    }
    return { rows: [], rowCount: 1 };
  }
}

function setup(scenario: DriverScenario) {
  const driver = new ScenarioDriver(scenario);
  const schemas = createSchemaRegistry(schema);
  const engine = new QueryEngine(driver, createModelRegistry(schema, schemas));
  return { driver, engine, executor: new OperationExecutor(engine) };
}

function context(operation: "create" | "update") {
  return createOperationExecutionContext("account", operation);
}

function nestedUpdate(queryEngine: QueryEngine): UpdateOperation {
  return new UpdateOperation(queryEngine, schema.account, {
    where: { email: "one@example.test" },
    data: {
      score: 2,
      notes: { create: { id: 10, body: "created by update" } },
    },
    select: { id: true, email: true, score: true },
  });
}

describe("provider-free operation executor scenarios", () => {
  test("a folded create executes as one borrowed statement without an envelope", async () => {
    const { driver, engine, executor } = setup({ mode: "transaction" });
    const operation = new CreateOperation(engine, schema.account, {
      data: { id: 1, email: "one@example.test", score: 1 },
      select: { id: true, email: true, score: true },
    });

    await expect(
      executor.execute(operation, context("create"))
    ).resolves.toEqual({ id: 1, email: "one@example.test", score: 1 });
    expect(driver.statements).toHaveLength(1);
    expect(driver.transactions).toBe(0);
    expect(driver.batches).toEqual([]);
  });

  test("an interactive transaction executes planning, nested writes, and the result read", async () => {
    const { driver, engine, executor } = setup({ mode: "transaction" });

    await expect(
      executor.execute(nestedUpdate(engine), context("update"))
    ).resolves.toEqual({ id: 1, email: "one@example.test", score: 2 });
    expect(driver.transactions).toBe(1);
    expect(driver.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(
      true
    );
    expect(
      driver.statements.some(
        (sql) =>
          sql.startsWith("INSERT") && sql.includes('"executor_scenario_notes"')
      )
    ).toBe(true);
    expect(
      driver.statements.filter((sql) => sql.startsWith("SELECT")).length
    ).toBeGreaterThanOrEqual(2);
  });

  test("an atomic batch materializes the planning row before one guarded write unit", async () => {
    const { driver, engine, executor } = setup({ mode: "batch" });

    await expect(
      executor.execute(nestedUpdate(engine), context("update"))
    ).resolves.toEqual({ id: 1, email: "one@example.test", score: 2 });
    expect(driver.transactions).toBe(0);
    expect(driver.statements).toHaveLength(1);
    expect(driver.batches).toHaveLength(1);
    expect(driver.batches[0]?.some((sql) => sql.startsWith("UPDATE"))).toBe(
      true
    );
    expect(
      driver.batches[0]?.some(
        (sql) =>
          sql.startsWith("INSERT") && sql.includes('"executor_scenario_notes"')
      )
    ).toBe(true);
  });

  test("a transaction postcondition stops the relation subtree after a lost update", async () => {
    const { driver, engine, executor } = setup({
      mode: "transaction",
      emptyUpdateResult: true,
    });

    await expect(
      executor.execute(nestedUpdate(engine), context("update"))
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      driver.statements.some((sql) => sql.includes('"executor_scenario_notes"'))
    ).toBe(false);
  });

  test("a failed batch identity guard rejects the complete unit", async () => {
    const { driver, engine, executor } = setup({
      mode: "batch",
      failBatchGuard: true,
    });

    await expect(
      executor.execute(nestedUpdate(engine), context("update"))
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(driver.batches).toHaveLength(1);
  });
});

describe("coverage low value", () => {
  test("a direct statement postcondition rejects a provider success with no row", async () => {
    const { engine, executor } = setup({
      mode: "transaction",
      emptyDirectResult: true,
    });
    const operation = new CreateOperation(engine, schema.account, {
      data: { id: 1, email: "one@example.test", score: 1 },
      select: { id: true },
    });

    await expect(
      executor.execute(operation, context("create"))
    ).rejects.toThrow("create terminal read expected exactly one row");
  });
});
