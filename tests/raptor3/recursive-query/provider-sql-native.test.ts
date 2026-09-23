import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import {
  liveProvider,
  runLiveWorld,
  type LiveFixture,
  type LiveNames,
} from "../transitions/live-world";
import {
  type CaseEngine,
  caseOutcome,
  type ColumnType,
  columnDefinitions,
  GRAPH_WORLD,
  HIERARCHY_WORLD,
  ORDINARY_MUTATION_CONTROL,
  owedOutcome,
  PLACEMENT_MATRIX_TABLES,
  PROVIDER_CASES,
  type ProviderCase,
  providerSchema,
  type RecursiveWorld,
  type TableSpec,
} from "./provider-sql-fixture";

const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";

const NATIVE_TYPES: Readonly<Record<ColumnType, string>> = {
  text: textType,
  integer: "INTEGER",
  boolean: "BOOLEAN",
  json: liveProvider === "pg" ? "JSONB" : "JSON",
};

/** MySQL's `ER_CTE_MAX_RECURSION_DEPTH`: "Recursive query aborted after N iterations". */
const MYSQL_CTE_MAX_RECURSION_DEPTH = 3636;

/**
 * Whether one failure's cause chain is MySQL's recursion limit. The driver
 * redacts a provider message by design; the provider's error number survives
 * as `meta.providerErrno` on the mapped failure, so that is the identity.
 */
function isMySQLRecursionLimit(failure: unknown): boolean {
  for (
    let current: unknown = failure;
    current instanceof Error;
    current = current.cause
  ) {
    const meta = (current as { meta?: { providerErrno?: unknown } }).meta;
    if (meta?.providerErrno === MYSQL_CTE_MAX_RECURSION_DEPTH) return true;
  }
  return false;
}

/**
 * What one case owes on THIS provider. MySQL's default
 * `cte_max_recursion_depth` (1000) stops an exhaustive chain longer than that
 * with the provider's own failure: the answer is that failure, never a
 * truncated success, and neither the engine nor this test touches the limit.
 */
function owed(providerCase: ProviderCase): unknown {
  if (liveProvider === "mysql" && providerCase.exceedsMySQLRecursionLimit)
    return { providerLimit: true };
  return owedOutcome(providerCase);
}

async function observed(
  engine: CaseEngine,
  providerCase: ProviderCase,
): Promise<unknown> {
  try {
    return await caseOutcome(engine, providerCase);
  } catch (failure) {
    if (
      liveProvider === "mysql" &&
      providerCase.exceedsMySQLRecursionLimit &&
      isMySQLRecursionLimit(failure)
    )
      return { providerLimit: true };
    throw failure;
  }
}

/** A live world's own tables: their initial rows and their inspection order. */
function liveTables(
  tables: readonly TableSpec[],
): Pick<LiveFixture, "initial" | "tables"> {
  return {
    initial: Object.fromEntries(
      tables.map((table) => [
        table.name,
        table.rows.map((row) => ({ ...row })),
      ]),
    ),
    tables: Object.fromEntries(
      tables.map((table) => [
        table.name,
        { name: table.name, order: table.primaryKey },
      ]),
    ),
  };
}

/** Every table's native DDL, through the one column speller. */
function nativeDefinitions(tables: readonly TableSpec[]) {
  return (names: LiveNames) =>
    Object.fromEntries(
      tables.map((table) => [
        table.name,
        columnDefinitions(table, NATIVE_TYPES, (identifier) =>
          names.quote(identifier),
        ),
      ]),
    );
}

/** One live world per RQ world: its tables, every group's cases in order. */
async function runWorld(world: RecursiveWorld): Promise<void> {
  const cases = world.groups.flatMap((group) => group.cases);
  const fixture: LiveFixture = {
    expectedExecutions: cases.length,
    ...liveTables(world.tables),
    async invoke(driver, factory) {
      assert(factory);
      const engine = factory({ schema: world.schema, driver });
      const outcomes: unknown[] = [];
      for (const providerCase of cases)
        outcomes.push(await observed(engine, providerCase));
      return outcomes;
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      if (observation.outcome.kind === "success")
        assert.deepEqual(observation.outcome.value, cases.map(owed));
    },
  };
  const live = await runLiveWorld(
    fixture,
    nativeDefinitions(world.tables),
    createCommandEngine,
  );
  if (live.terminalFailure !== undefined) throw live.terminalFailure;
  fixture.assert(live.observation);
  // One provider statement per case, whatever its outcome; every case but an
  // ordinary control carries its recursive projection in that statement.
  assert.equal(live.statements.length, cases.length);
  assert.equal(
    live.statements.filter((statement) => /WITH RECURSIVE/.test(statement.sql))
      .length,
    cases.filter((providerCase) => providerCase.control === undefined).length,
  );
  live.assertHealthy();
}

describe(`recursive relation provider SQL on native ${liveProvider}`, () => {
  it("projects the recursive placement matrix through provider SQL", async () => {
    const fixture: LiveFixture = {
      expectedExecutions: PROVIDER_CASES.length + 1,
      ...liveTables(PLACEMENT_MATRIX_TABLES),
      async invoke(driver, factory) {
        assert(factory);
        const engine = factory({ schema: providerSchema, driver });
        const control = await engine.execute(
          ORDINARY_MUTATION_CONTROL.model,
          ORDINARY_MUTATION_CONTROL.operation,
          ORDINARY_MUTATION_CONTROL.args,
        );
        const values: unknown[] = [];
        for (const providerCase of PROVIDER_CASES)
          values.push(
            await engine.execute(
              providerCase.model,
              providerCase.operation,
              providerCase.args,
            ),
          );
        return { control, values };
      },
      assert(observation) {
        assert.equal(observation.outcome.kind, "success");
        if (observation.outcome.kind === "success")
          assert.deepEqual(
            observation.outcome.value,
            {
              control: ORDINARY_MUTATION_CONTROL.expected,
              values: PROVIDER_CASES.map(
                (providerCase) => providerCase.expected,
              ),
            },
          );
      },
    };
    const world = await runLiveWorld(
      fixture,
      nativeDefinitions(PLACEMENT_MATRIX_TABLES),
      createCommandEngine,
    );
    if (world.terminalFailure !== undefined) throw world.terminalFailure;
    fixture.assert(world.observation);
    const recursiveStatementIndexes = world.statements.flatMap(
      (statement, index) =>
        /WITH RECURSIVE/.test(statement.sql) ? [index] : [],
    );
    assert.equal(recursiveStatementIndexes.length, PROVIDER_CASES.length);
    const ordinaryMutationStatements = recursiveStatementIndexes[0]!;
    assert(ordinaryMutationStatements > 0);
    for (let index = 0; index < 7; index += 1)
      assert.equal(
        recursiveStatementIndexes[index],
        ordinaryMutationStatements + index,
        `${PROVIDER_CASES[index]!.name}: statement count`,
      );
    const updateStart = recursiveStatementIndexes[6]! + 1;
    const updateRead = recursiveStatementIndexes[7]!;
    const updateStatements = world.statements.slice(updateStart, updateRead + 1);
    assert.equal(updateStatements.length, ordinaryMutationStatements);
    const updateWrite = updateStatements.findIndex((statement) =>
      /^UPDATE\b/.test(statement.sql),
    );
    assert(updateWrite >= 0 && updateWrite < updateStatements.length - 1);
    const deleteRead = recursiveStatementIndexes[8]!;
    const deleteStatements = world.statements.slice(deleteRead);
    const deleteWrite = deleteStatements.findIndex((statement) =>
      /^DELETE\b/.test(statement.sql),
    );
    assert(deleteWrite > 0);
    world.assertHealthy();
  }, 30_000);

  for (const world of [HIERARCHY_WORLD, GRAPH_WORLD])
    it(world.name, () => runWorld(world), 120_000);
});
