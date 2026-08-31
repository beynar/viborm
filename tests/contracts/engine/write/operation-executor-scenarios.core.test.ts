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

/**
 * The THREE routes `OperationExecutor.execute` chooses between
 * (`OperationExecutor.ts:326-374`), driven by a recording driver rather than a
 * provider: statement-atomic (no envelope), interactive transaction, and native
 * atomic batch. Nothing else in the provider-free estate observes the route a
 * whole operation takes — the fold suites that pin round-trip counts
 * (`upsert-on-conflict-fold.test.ts`, `batch-round-trip-baseline.test.ts`) all
 * boot PGlite, and `generated-output-segment-contract.core.test.ts` drives
 * hand-built fragments through the batch seam only.
 *
 * `batch-attribution-hazard-signature.core.test.ts` owns the CLIENT array-batch
 * attributor (`attributeOperationBatchError`). The last test here covers the
 * executor's own `attributeGuardFailure` instead: its guard lowering is a SQL
 * division-by-zero assertion, so only a provider that RAISES can fail a batch
 * premise — a fake that merely answers "no rows" to the assertion proves nothing.
 */

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
  /**
   * A concurrent delete lands between the planning read and the atomic batch.
   * The batch's `exists` assertion then divides by zero exactly as PostgreSQL
   * does (`postgres-adapter.ts:521`), which is the only signal the executor's
   * guard attribution reacts to.
   */
  readonly rowVanishesBeforeBatch?: boolean;
}

/** PostgreSQL's own division-by-zero, the shape `error-mapping.ts:102` reads. */
function divisionByZero(): Error {
  return Object.assign(new Error("division by zero"), { code: "22012" });
}

class ScenarioDriver extends Driver<null, null> {
  readonly adapter = new PostgresAdapter();
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;
  readonly statements: string[] = [];
  readonly batches: string[][] = [];
  transactions = 0;
  private readonly scenario: DriverScenario;
  private rowGone = false;

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
    return Promise.resolve(this.response<T>(statement));
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
    if (this.scenario.rowVanishesBeforeBatch) {
      this.rowGone = true;
      const assertion = queries.find((query) =>
        query.sql.includes("__viborm_assert__")
      );
      if (assertion) throw divisionByZero();
    }
    const results = queries.map((query) => this.response<T>(query.sql));
    await committed?.();
    return results;
  }

  private response<T>(statement: string): QueryResult<T> {
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
      statement.includes('"executor_scenario_accounts"') &&
      statement.startsWith("SELECT")
    ) {
      // The locked planning probe still sees the pre-update row; every later read
      // sees the applied `score`. A vanished row answers nothing at all, which is
      // what the post-abort guard re-probe must observe.
      const rows = this.rowGone
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

  test("a raised batch assertion is re-attributed to the guard whose premise broke", async () => {
    const { driver, engine, executor } = setup({
      mode: "batch",
      rowVanishesBeforeBatch: true,
    });

    // The provider aborts the whole unit with an untyped division-by-zero; only
    // the re-probe of the guard's own premise turns that into this guard's typed
    // not-found (`OperationExecutor.ts:3281`).
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
