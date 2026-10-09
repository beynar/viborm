import assert from "node:assert/strict";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
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
  SELECT_SQL_PINS,
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
    createTestCommandEngine,
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

/**
 * What each case sent on this provider, in one live world over the placement
 * tables: its statement, or its refusal sentence when it sent none. The run's
 * own namespace is spelled `<namespace>`. Every case that is not refused
 * sends exactly one statement, which is what lets the statements be read in
 * case order.
 */
async function nativeSqlPins(
  cases: readonly ProviderCase[],
): Promise<Record<string, readonly string[] | string>> {
  const fixture: LiveFixture = {
    expectedExecutions: cases.length,
    ...liveTables(PLACEMENT_MATRIX_TABLES),
    async invoke(driver, factory) {
      assert(factory);
      const engine = factory({ schema: providerSchema, driver });
      const outcomes: unknown[] = [];
      for (const providerCase of cases)
        outcomes.push(await caseOutcome(engine, providerCase));
      return outcomes;
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      if (observation.outcome.kind === "success")
        assert.deepEqual(observation.outcome.value, cases.map(owedOutcome));
    },
  };
  const live = await runLiveWorld(
    fixture,
    nativeDefinitions(PLACEMENT_MATRIX_TABLES),
    createTestCommandEngine,
  );
  if (live.terminalFailure !== undefined) throw live.terminalFailure;
  fixture.assert(live.observation);
  live.assertHealthy();
  const statements = live.statements.map((statement) =>
    statement.sql.replaceAll(live.namespace, "<namespace>"),
  );
  const refused = cases.filter((providerCase) => providerCase.failure);
  assert.equal(statements.length, cases.length - refused.length);
  return Object.fromEntries(
    cases.map((providerCase) => [
      providerCase.name,
      providerCase.failure ?? [statements.shift()!],
    ]),
  );
}

describe(`recursive relation provider SQL on native ${liveProvider}`, () => {
  it("pins the recursive select SQL byte for byte", async () => {
    const pins = await nativeSqlPins(SELECT_SQL_PINS);
    // PostgreSQL's text is the adapter's, pinned once on PGlite.
    if (liveProvider === "mysql") assert.deepEqual(pins, MYSQL_SELECT_SQL);
  }, 30_000);

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
      createTestCommandEngine,
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

/** The MySQL adapter's exact text for each pinned case (`<namespace>` is the run's). */
const MYSQL_SELECT_SQL: Readonly<Record<string, readonly string[] | string>> = {
  "foreign key up, bounded": [
    "SELECT `q0`.`label` AS `label`, (SELECT JSON_OBJECT(?, JSON_ARRAY(`q0`.`tenant_key`, `q0`.`node_code`), ?, `q12`.`__q1_nodes`, ?, `q12`.`__q1_edges`) FROM (SELECT 1) AS `q11` JOIN LATERAL (WITH RECURSIVE `__q1_recursive` AS (\n        SELECT `q0`.`tenant_key` AS `__q1_parent_0`, `q0`.`node_code` AS `__q1_parent_1`, `q2`.`tenant_key` AS `__q1_child_0`, `q2`.`node_code` AS `__q1_child_1`, CAST(? AS SIGNED) AS `__q1_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q2` WHERE (`q0`.`parent_tenant` = `q2`.`tenant_key` AND `q0`.`parent_code` = `q2`.`node_code`)\n        UNION\n        SELECT `q3`.`__q1_child_0` AS `__q1_parent_0`, `q3`.`__q1_child_1` AS `__q1_parent_1`, `q5`.`tenant_key` AS `__q1_child_0`, `q5`.`node_code` AS `__q1_child_1`, (`q3`.`__q1_depth` + ?) AS `__q1_depth` FROM `__q1_recursive` AS `q3` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q4` ON (`q4`.`tenant_key` = `q3`.`__q1_child_0` AND `q4`.`node_code` = `q3`.`__q1_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q5` ON (`q4`.`parent_tenant` = `q5`.`tenant_key` AND `q4`.`parent_code` = `q5`.`node_code`) WHERE `q3`.`__q1_depth` < ?\n      ) SELECT (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(?, JSON_ARRAY(`q7`.`tenant_key`, `q7`.`node_code`), ?, JSON_OBJECT(?, `q7`.`label`))), JSON_ARRAY()) FROM (SELECT `__q1_id_0`, `__q1_id_1` FROM (SELECT `q3`.`__q1_child_0` AS `__q1_id_0`, `q3`.`__q1_child_1` AS `__q1_id_1`, ROW_NUMBER() OVER (PARTITION BY `q3`.`__q1_child_0`, `q3`.`__q1_child_1` ORDER BY `q3`.`__q1_child_0`, `q3`.`__q1_child_1`) AS `_rn` FROM `__q1_recursive` AS `q3`) AS `_distinct_subquery` WHERE `_rn` = 1) AS `q6` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q7` ON (`q7`.`tenant_key` = `q6`.`__q1_id_0` AND `q7`.`node_code` = `q6`.`__q1_id_1`)) AS `__q1_nodes`, (SELECT COALESCE(JSON_ARRAYAGG(`q10`.`__q1_edge`), JSON_ARRAY()) FROM (SELECT JSON_OBJECT(?, JSON_ARRAY(`q8`.`__q1_parent_0`, `q8`.`__q1_parent_1`), ?, JSON_ARRAY(`q8`.`__q1_child_0`, `q8`.`__q1_child_1`), ?, `q8`.`__q1_depth`) AS `__q1_edge` FROM `__q1_recursive` AS `q8` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q9` ON (`q9`.`tenant_key` = `q8`.`__q1_child_0` AND `q9`.`node_code` = `q8`.`__q1_child_1`) ORDER BY `q8`.`__q1_parent_0` ASC, `q8`.`__q1_parent_1` ASC, `q9`.`tenant_key` ASC, `q9`.`node_code` ASC LIMIT 18446744073709551615) AS `q10`) AS `__q1_edges`) AS `q12` ON TRUE) AS `parent` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE ((`q0`.`tenant_key` = ? AND BINARY `q0`.`tenant_key` = ?) AND (`q0`.`node_code` = ? AND BINARY `q0`.`node_code` = ?)) ORDER BY `q0`.`tenant_key` ASC, `q0`.`node_code` ASC",
  ],
  "foreign key down, exhaustive, selector": [
    "SELECT `q0`.`label` AS `label`, (SELECT JSON_OBJECT(?, JSON_ARRAY(`q0`.`tenant_key`, `q0`.`node_code`), ?, `q12`.`__q1_nodes`, ?, `q12`.`__q1_edges`) FROM (SELECT 1) AS `q11` JOIN LATERAL (WITH RECURSIVE `__q1_recursive` AS (\n        SELECT `q0`.`tenant_key` AS `__q1_parent_0`, `q0`.`node_code` AS `__q1_parent_1`, `q2`.`tenant_key` AS `__q1_child_0`, `q2`.`node_code` AS `__q1_child_1` FROM `<namespace>`.`rq_provider_nodes` AS `q2` WHERE ((`q0`.`tenant_key` = `q2`.`parent_tenant` AND `q0`.`node_code` = `q2`.`parent_code`) AND `q2`.`visible` = ?)\n        UNION\n        SELECT `q3`.`__q1_child_0` AS `__q1_parent_0`, `q3`.`__q1_child_1` AS `__q1_parent_1`, `q5`.`tenant_key` AS `__q1_child_0`, `q5`.`node_code` AS `__q1_child_1` FROM `__q1_recursive` AS `q3` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q4` ON (`q4`.`tenant_key` = `q3`.`__q1_child_0` AND `q4`.`node_code` = `q3`.`__q1_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q5` ON (`q4`.`tenant_key` = `q5`.`parent_tenant` AND `q4`.`node_code` = `q5`.`parent_code`) WHERE `q5`.`visible` = ?\n      ) SELECT (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(?, JSON_ARRAY(`q7`.`tenant_key`, `q7`.`node_code`), ?, JSON_OBJECT(?, `q7`.`label`))), JSON_ARRAY()) FROM (SELECT `__q1_id_0`, `__q1_id_1` FROM (SELECT `q3`.`__q1_child_0` AS `__q1_id_0`, `q3`.`__q1_child_1` AS `__q1_id_1`, ROW_NUMBER() OVER (PARTITION BY `q3`.`__q1_child_0`, `q3`.`__q1_child_1` ORDER BY `q3`.`__q1_child_0`, `q3`.`__q1_child_1`) AS `_rn` FROM `__q1_recursive` AS `q3`) AS `_distinct_subquery` WHERE `_rn` = 1) AS `q6` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q7` ON (`q7`.`tenant_key` = `q6`.`__q1_id_0` AND `q7`.`node_code` = `q6`.`__q1_id_1`)) AS `__q1_nodes`, (SELECT COALESCE(JSON_ARRAYAGG(`q10`.`__q1_edge`), JSON_ARRAY()) FROM (SELECT JSON_OBJECT(?, JSON_ARRAY(`q8`.`__q1_parent_0`, `q8`.`__q1_parent_1`), ?, JSON_ARRAY(`q8`.`__q1_child_0`, `q8`.`__q1_child_1`)) AS `__q1_edge` FROM `__q1_recursive` AS `q8` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q9` ON (`q9`.`tenant_key` = `q8`.`__q1_child_0` AND `q9`.`node_code` = `q8`.`__q1_child_1`) ORDER BY `q8`.`__q1_parent_0` ASC, `q8`.`__q1_parent_1` ASC, `q9`.`tenant_key` ASC, `q9`.`node_code` ASC LIMIT 18446744073709551615) AS `q10`) AS `__q1_edges`) AS `q12` ON TRUE) AS `children` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE ((`q0`.`tenant_key` = ? AND BINARY `q0`.`tenant_key` = ?) AND (`q0`.`node_code` = ? AND BINARY `q0`.`node_code` = ?)) ORDER BY `q0`.`tenant_key` ASC, `q0`.`node_code` ASC",
  ],
  "junction, bounded, selector": [
    "SELECT `q0`.`label` AS `label`, (SELECT JSON_OBJECT(?, JSON_ARRAY(`q0`.`tenant_key`, `q0`.`node_code`), ?, `q14`.`__q1_nodes`, ?, `q14`.`__q1_edges`) FROM (SELECT 1) AS `q13` JOIN LATERAL (WITH RECURSIVE `__q1_recursive` AS (\n        SELECT `q0`.`tenant_key` AS `__q1_parent_0`, `q0`.`node_code` AS `__q1_parent_1`, `q2`.`tenant_key` AS `__q1_child_0`, `q2`.`node_code` AS `__q1_child_1`, CAST(? AS SIGNED) AS `__q1_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q2` WHERE ((`q2`.`tenant_key`, `q2`.`node_code`) IN (SELECT `q3`.`to_1`, `q3`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q3` WHERE (`q3`.`from_1` = `q0`.`tenant_key` AND `q3`.`from_2` = `q0`.`node_code`)) AND `q2`.`visible` = ?)\n        UNION\n        SELECT `q4`.`__q1_child_0` AS `__q1_parent_0`, `q4`.`__q1_child_1` AS `__q1_parent_1`, `q6`.`tenant_key` AS `__q1_child_0`, `q6`.`node_code` AS `__q1_child_1`, (`q4`.`__q1_depth` + ?) AS `__q1_depth` FROM `__q1_recursive` AS `q4` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q5` ON (`q5`.`tenant_key` = `q4`.`__q1_child_0` AND `q5`.`node_code` = `q4`.`__q1_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q6` ON (`q6`.`tenant_key`, `q6`.`node_code`) IN (SELECT `q7`.`to_1`, `q7`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q7` WHERE (`q7`.`from_1` = `q5`.`tenant_key` AND `q7`.`from_2` = `q5`.`node_code`)) WHERE (`q4`.`__q1_depth` < ? AND `q6`.`visible` = ?)\n      ) SELECT (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(?, JSON_ARRAY(`q9`.`tenant_key`, `q9`.`node_code`), ?, JSON_OBJECT(?, `q9`.`label`))), JSON_ARRAY()) FROM (SELECT `__q1_id_0`, `__q1_id_1` FROM (SELECT `q4`.`__q1_child_0` AS `__q1_id_0`, `q4`.`__q1_child_1` AS `__q1_id_1`, ROW_NUMBER() OVER (PARTITION BY `q4`.`__q1_child_0`, `q4`.`__q1_child_1` ORDER BY `q4`.`__q1_child_0`, `q4`.`__q1_child_1`) AS `_rn` FROM `__q1_recursive` AS `q4`) AS `_distinct_subquery` WHERE `_rn` = 1) AS `q8` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q9` ON (`q9`.`tenant_key` = `q8`.`__q1_id_0` AND `q9`.`node_code` = `q8`.`__q1_id_1`)) AS `__q1_nodes`, (SELECT COALESCE(JSON_ARRAYAGG(`q12`.`__q1_edge`), JSON_ARRAY()) FROM (SELECT JSON_OBJECT(?, JSON_ARRAY(`q10`.`__q1_parent_0`, `q10`.`__q1_parent_1`), ?, JSON_ARRAY(`q10`.`__q1_child_0`, `q10`.`__q1_child_1`), ?, `q10`.`__q1_depth`) AS `__q1_edge` FROM `__q1_recursive` AS `q10` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q11` ON (`q11`.`tenant_key` = `q10`.`__q1_child_0` AND `q11`.`node_code` = `q10`.`__q1_child_1`) ORDER BY `q10`.`__q1_parent_0` ASC, `q10`.`__q1_parent_1` ASC, `q11`.`node_code` ASC, `q11`.`tenant_key` ASC LIMIT 18446744073709551615) AS `q12`) AS `__q1_edges`) AS `q14` ON TRUE) AS `neighbors` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE ((`q0`.`tenant_key` = ? AND BINARY `q0`.`tenant_key` = ?) AND (`q0`.`node_code` = ? AND BINARY `q0`.`node_code` = ?)) ORDER BY `q0`.`tenant_key` ASC, `q0`.`node_code` ASC",
  ],
  "junction, exhaustive": [
    "SELECT `q0`.`label` AS `label`, (SELECT JSON_OBJECT(?, JSON_ARRAY(`q0`.`tenant_key`, `q0`.`node_code`), ?, `q14`.`__q1_nodes`, ?, `q14`.`__q1_edges`) FROM (SELECT 1) AS `q13` JOIN LATERAL (WITH RECURSIVE `__q1_recursive` AS (\n        SELECT `q0`.`tenant_key` AS `__q1_parent_0`, `q0`.`node_code` AS `__q1_parent_1`, `q2`.`tenant_key` AS `__q1_child_0`, `q2`.`node_code` AS `__q1_child_1` FROM `<namespace>`.`rq_provider_nodes` AS `q2` WHERE (`q2`.`tenant_key`, `q2`.`node_code`) IN (SELECT `q3`.`to_1`, `q3`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q3` WHERE (`q3`.`from_1` = `q0`.`tenant_key` AND `q3`.`from_2` = `q0`.`node_code`))\n        UNION\n        SELECT `q4`.`__q1_child_0` AS `__q1_parent_0`, `q4`.`__q1_child_1` AS `__q1_parent_1`, `q6`.`tenant_key` AS `__q1_child_0`, `q6`.`node_code` AS `__q1_child_1` FROM `__q1_recursive` AS `q4` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q5` ON (`q5`.`tenant_key` = `q4`.`__q1_child_0` AND `q5`.`node_code` = `q4`.`__q1_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q6` ON (`q6`.`tenant_key`, `q6`.`node_code`) IN (SELECT `q7`.`to_1`, `q7`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q7` WHERE (`q7`.`from_1` = `q5`.`tenant_key` AND `q7`.`from_2` = `q5`.`node_code`)) WHERE TRUE\n      ) SELECT (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(?, JSON_ARRAY(`q9`.`tenant_key`, `q9`.`node_code`), ?, JSON_OBJECT(?, `q9`.`label`))), JSON_ARRAY()) FROM (SELECT `__q1_id_0`, `__q1_id_1` FROM (SELECT `q4`.`__q1_child_0` AS `__q1_id_0`, `q4`.`__q1_child_1` AS `__q1_id_1`, ROW_NUMBER() OVER (PARTITION BY `q4`.`__q1_child_0`, `q4`.`__q1_child_1` ORDER BY `q4`.`__q1_child_0`, `q4`.`__q1_child_1`) AS `_rn` FROM `__q1_recursive` AS `q4`) AS `_distinct_subquery` WHERE `_rn` = 1) AS `q8` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q9` ON (`q9`.`tenant_key` = `q8`.`__q1_id_0` AND `q9`.`node_code` = `q8`.`__q1_id_1`)) AS `__q1_nodes`, (SELECT COALESCE(JSON_ARRAYAGG(`q12`.`__q1_edge`), JSON_ARRAY()) FROM (SELECT JSON_OBJECT(?, JSON_ARRAY(`q10`.`__q1_parent_0`, `q10`.`__q1_parent_1`), ?, JSON_ARRAY(`q10`.`__q1_child_0`, `q10`.`__q1_child_1`)) AS `__q1_edge` FROM `__q1_recursive` AS `q10` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q11` ON (`q11`.`tenant_key` = `q10`.`__q1_child_0` AND `q11`.`node_code` = `q10`.`__q1_child_1`) ORDER BY `q10`.`__q1_parent_0` ASC, `q10`.`__q1_parent_1` ASC, `q11`.`node_code` ASC, `q11`.`tenant_key` ASC LIMIT 18446744073709551615) AS `q12`) AS `__q1_edges`) AS `q14` ON TRUE) AS `neighbors` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE ((`q0`.`tenant_key` = ? AND BINARY `q0`.`tenant_key` = ?) AND (`q0`.`node_code` = ? AND BINARY `q0`.`node_code` = ?)) ORDER BY `q0`.`tenant_key` ASC, `q0`.`node_code` ASC",
  ],
};
