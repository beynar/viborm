// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
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
  FILTER_SQL_PINS,
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
 * case order, and no case changes a row (a refused one least of all).
 */
async function nativeSqlPins(
  cases: readonly ProviderCase[],
): Promise<Record<string, readonly string[] | string>> {
  const owedHere = cases.map((providerCase) =>
    liveProvider === "mysql" && providerCase.mysqlFailure !== undefined
      ? { failure: providerCase.mysqlFailure }
      : owedOutcome(providerCase),
  );
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
        assert.deepEqual(observation.outcome.value, owedHere);
      assert.deepEqual(observation.final, observation.initial);
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
  const refused = owedHere.filter((outcome) => "failure" in outcome);
  assert.equal(statements.length, cases.length - refused.length);
  return Object.fromEntries(
    cases.map((providerCase, index) => {
      const outcome = owedHere[index]!;
      return [
        providerCase.name,
        "failure" in outcome ? outcome.failure : [statements.shift()!],
      ];
    }),
  );
}

describe(`recursive relation provider SQL on native ${liveProvider}`, () => {
  it("pins the recursive select SQL byte for byte", async () => {
    const pins = await nativeSqlPins(SELECT_SQL_PINS);
    // PostgreSQL's text is the adapter's, pinned once on PGlite.
    if (liveProvider === "mysql") assert.deepEqual(pins, MYSQL_SELECT_SQL);
  }, 30_000);

  it("pins the recursive filter SQL byte for byte", async () => {
    const pins = await nativeSqlPins(FILTER_SQL_PINS);
    if (liveProvider === "mysql") assert.deepEqual(pins, MYSQL_FILTER_SQL);
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

const MYSQL_FILTER_SQL: Readonly<Record<string, readonly string[] | string>> = {
  "foreign-key ancestors with self, default depth": [
    "SELECT `q0`.`node_code` AS `code` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE EXISTS (WITH RECURSIVE `__q3_recursive` AS (\n        SELECT `q0`.`tenant_key` AS `__q3_child_0`, `q0`.`node_code` AS `__q3_child_1`, CAST(? AS SIGNED) AS `__q3_depth` UNION SELECT `q4`.`tenant_key` AS `__q3_child_0`, `q4`.`node_code` AS `__q3_child_1`, CAST(? AS SIGNED) AS `__q3_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q4` WHERE (`q0`.`parent_tenant` = `q4`.`tenant_key` AND `q0`.`parent_code` = `q4`.`node_code`)\n        UNION\n        SELECT `q7`.`tenant_key` AS `__q3_child_0`, `q7`.`node_code` AS `__q3_child_1`, (`q5`.`__q3_depth` + ?) AS `__q3_depth` FROM `__q3_recursive` AS `q5` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q6` ON (`q6`.`tenant_key` = `q5`.`__q3_child_0` AND `q6`.`node_code` = `q5`.`__q3_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q7` ON (`q6`.`parent_tenant` = `q7`.`tenant_key` AND `q6`.`parent_code` = `q7`.`node_code`) WHERE `q5`.`__q3_depth` < ?\n      ) SELECT 1 FROM `__q3_recursive` AS `q5` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q1` ON (`q1`.`tenant_key` = `q5`.`__q3_child_0` AND `q1`.`node_code` = `q5`.`__q3_child_1`) WHERE EXISTS (SELECT 1 FROM `<namespace>`.`rq_provider_notes` AS `q2` WHERE ((`q1`.`tenant_key` = `q2`.`node_tenant` AND `q1`.`node_code` = `q2`.`node_code`) AND (`q2`.`text` = ? AND BINARY `q2`.`text` = ?)))) ORDER BY `q0`.`node_code` ASC, `q0`.`tenant_key` ASC",
  ],
  "junction walk with self, bounded, nested in a relation filter": [
    "SELECT `q0`.`id` AS `id` FROM `<namespace>`.`rq_provider_notes` AS `q0` WHERE EXISTS (SELECT 1 FROM `<namespace>`.`rq_provider_nodes` AS `q1` WHERE ((`q0`.`node_tenant` = `q1`.`tenant_key` AND `q0`.`node_code` = `q1`.`node_code`) AND EXISTS (WITH RECURSIVE `__q4_recursive` AS (\n        SELECT `q1`.`tenant_key` AS `__q4_child_0`, `q1`.`node_code` AS `__q4_child_1`, CAST(? AS SIGNED) AS `__q4_depth` UNION SELECT `q5`.`tenant_key` AS `__q4_child_0`, `q5`.`node_code` AS `__q4_child_1`, CAST(? AS SIGNED) AS `__q4_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q5` WHERE (`q5`.`tenant_key`, `q5`.`node_code`) IN (SELECT `q6`.`to_1`, `q6`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q6` WHERE (`q6`.`from_1` = `q1`.`tenant_key` AND `q6`.`from_2` = `q1`.`node_code`))\n        UNION\n        SELECT `q9`.`tenant_key` AS `__q4_child_0`, `q9`.`node_code` AS `__q4_child_1`, (`q7`.`__q4_depth` + ?) AS `__q4_depth` FROM `__q4_recursive` AS `q7` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q8` ON (`q8`.`tenant_key` = `q7`.`__q4_child_0` AND `q8`.`node_code` = `q7`.`__q4_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q9` ON (`q9`.`tenant_key`, `q9`.`node_code`) IN (SELECT `q10`.`to_1`, `q10`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q10` WHERE (`q10`.`from_1` = `q8`.`tenant_key` AND `q10`.`from_2` = `q8`.`node_code`)) WHERE `q7`.`__q4_depth` < ?\n      ) SELECT 1 FROM `__q4_recursive` AS `q7` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q2` ON (`q2`.`tenant_key` = `q7`.`__q4_child_0` AND `q2`.`node_code` = `q7`.`__q4_child_1`) WHERE (EXISTS (SELECT 1 FROM `<namespace>`.`rq_provider_notes` AS `q3` WHERE ((`q2`.`tenant_key` = `q3`.`node_tenant` AND `q2`.`node_code` = `q3`.`node_code`) AND `q3`.`position` = ?)) OR (`q2`.`label` = ? AND BINARY `q2`.`label` = ?))))) ORDER BY `q0`.`id` ASC",
  ],
  "foreign-key descendants, exhaustive, none": [
    "SELECT `q0`.`node_code` AS `code` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE NOT EXISTS (WITH RECURSIVE `__q2_recursive` AS (\n        SELECT `q3`.`tenant_key` AS `__q2_child_0`, `q3`.`node_code` AS `__q2_child_1` FROM `<namespace>`.`rq_provider_nodes` AS `q3` WHERE (`q0`.`tenant_key` = `q3`.`parent_tenant` AND `q0`.`node_code` = `q3`.`parent_code`)\n        UNION\n        SELECT `q6`.`tenant_key` AS `__q2_child_0`, `q6`.`node_code` AS `__q2_child_1` FROM `__q2_recursive` AS `q4` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q5` ON (`q5`.`tenant_key` = `q4`.`__q2_child_0` AND `q5`.`node_code` = `q4`.`__q2_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q6` ON (`q5`.`tenant_key` = `q6`.`parent_tenant` AND `q5`.`node_code` = `q6`.`parent_code`) WHERE TRUE\n      ) SELECT 1 FROM `__q2_recursive` AS `q4` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q1` ON (`q1`.`tenant_key` = `q4`.`__q2_child_0` AND `q1`.`node_code` = `q4`.`__q2_child_1`) WHERE `q1`.`visible` = ?) ORDER BY `q0`.`node_code` ASC, `q0`.`tenant_key` ASC",
  ],
  "junction, one hop, every over empty closures": [
    "SELECT `q0`.`node_code` AS `code` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE NOT EXISTS (WITH RECURSIVE `__q2_recursive` AS (\n        SELECT `q3`.`tenant_key` AS `__q2_child_0`, `q3`.`node_code` AS `__q2_child_1`, CAST(? AS SIGNED) AS `__q2_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q3` WHERE (`q3`.`tenant_key`, `q3`.`node_code`) IN (SELECT `q4`.`to_1`, `q4`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q4` WHERE (`q4`.`from_1` = `q0`.`tenant_key` AND `q4`.`from_2` = `q0`.`node_code`))\n        UNION\n        SELECT `q7`.`tenant_key` AS `__q2_child_0`, `q7`.`node_code` AS `__q2_child_1`, (`q5`.`__q2_depth` + ?) AS `__q2_depth` FROM `__q2_recursive` AS `q5` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q6` ON (`q6`.`tenant_key` = `q5`.`__q2_child_0` AND `q6`.`node_code` = `q5`.`__q2_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q7` ON (`q7`.`tenant_key`, `q7`.`node_code`) IN (SELECT `q8`.`to_1`, `q8`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q8` WHERE (`q8`.`from_1` = `q6`.`tenant_key` AND `q8`.`from_2` = `q6`.`node_code`)) WHERE `q5`.`__q2_depth` < ?\n      ) SELECT 1 FROM `__q2_recursive` AS `q5` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q1` ON (`q1`.`tenant_key` = `q5`.`__q2_child_0` AND `q1`.`node_code` = `q5`.`__q2_child_1`) WHERE NOT (`q1`.`rank` >= ?)) ORDER BY `q0`.`node_code` ASC, `q0`.`tenant_key` ASC",
  ],
  "a closure nested in a closure": [
    "SELECT `q0`.`node_code` AS `code` FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE EXISTS (WITH RECURSIVE `__q10_recursive` AS (\n        SELECT `q11`.`tenant_key` AS `__q10_child_0`, `q11`.`node_code` AS `__q10_child_1`, CAST(? AS SIGNED) AS `__q10_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q11` WHERE (`q0`.`parent_tenant` = `q11`.`tenant_key` AND `q0`.`parent_code` = `q11`.`node_code`)\n        UNION\n        SELECT `q14`.`tenant_key` AS `__q10_child_0`, `q14`.`node_code` AS `__q10_child_1`, (`q12`.`__q10_depth` + ?) AS `__q10_depth` FROM `__q10_recursive` AS `q12` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q13` ON (`q13`.`tenant_key` = `q12`.`__q10_child_0` AND `q13`.`node_code` = `q12`.`__q10_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q14` ON (`q13`.`parent_tenant` = `q14`.`tenant_key` AND `q13`.`parent_code` = `q14`.`node_code`) WHERE `q12`.`__q10_depth` < ?\n      ) SELECT 1 FROM `__q10_recursive` AS `q12` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q1` ON (`q1`.`tenant_key` = `q12`.`__q10_child_0` AND `q1`.`node_code` = `q12`.`__q10_child_1`) WHERE EXISTS (WITH RECURSIVE `__q3_recursive` AS (\n        SELECT `q1`.`tenant_key` AS `__q3_child_0`, `q1`.`node_code` AS `__q3_child_1` UNION SELECT `q4`.`tenant_key` AS `__q3_child_0`, `q4`.`node_code` AS `__q3_child_1` FROM `<namespace>`.`rq_provider_nodes` AS `q4` WHERE (`q4`.`tenant_key`, `q4`.`node_code`) IN (SELECT `q5`.`to_1`, `q5`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q5` WHERE (`q5`.`from_1` = `q1`.`tenant_key` AND `q5`.`from_2` = `q1`.`node_code`))\n        UNION\n        SELECT `q8`.`tenant_key` AS `__q3_child_0`, `q8`.`node_code` AS `__q3_child_1` FROM `__q3_recursive` AS `q6` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q7` ON (`q7`.`tenant_key` = `q6`.`__q3_child_0` AND `q7`.`node_code` = `q6`.`__q3_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q8` ON (`q8`.`tenant_key`, `q8`.`node_code`) IN (SELECT `q9`.`to_1`, `q9`.`to_2` FROM `<namespace>`.`rq_provider_links` AS `q9` WHERE (`q9`.`from_1` = `q7`.`tenant_key` AND `q9`.`from_2` = `q7`.`node_code`)) WHERE TRUE\n      ) SELECT 1 FROM `__q3_recursive` AS `q6` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q2` ON (`q2`.`tenant_key` = `q6`.`__q3_child_0` AND `q2`.`node_code` = `q6`.`__q3_child_1`) WHERE (`q2`.`node_code` = ? AND BINARY `q2`.`node_code` = ?))) ORDER BY `q0`.`node_code` ASC, `q0`.`tenant_key` ASC",
  ],
  "updateMany walking the table it updates":
    "where.parent.recurse is not supported. MySQL re-reads a recursive filter's table while its own update or delete changes it, so the walk would see the statement's own writes. Read the matching keys first, then update or delete by key.",
  "updateMany walking another table": [
    "UPDATE `<namespace>`.`rq_provider_forests` SET `name` = ? WHERE EXISTS (SELECT 1 FROM `<namespace>`.`rq_provider_nodes` AS `q0` WHERE ((`rq_provider_forests`.`entry_tenant` = `q0`.`tenant_key` AND `rq_provider_forests`.`entry_code` = `q0`.`node_code`) AND EXISTS (WITH RECURSIVE `__q2_recursive` AS (\n        SELECT `q3`.`tenant_key` AS `__q2_child_0`, `q3`.`node_code` AS `__q2_child_1`, CAST(? AS SIGNED) AS `__q2_depth` FROM `<namespace>`.`rq_provider_nodes` AS `q3` WHERE (`q0`.`tenant_key` = `q3`.`parent_tenant` AND `q0`.`node_code` = `q3`.`parent_code`)\n        UNION\n        SELECT `q6`.`tenant_key` AS `__q2_child_0`, `q6`.`node_code` AS `__q2_child_1`, (`q4`.`__q2_depth` + ?) AS `__q2_depth` FROM `__q2_recursive` AS `q4` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q5` ON (`q5`.`tenant_key` = `q4`.`__q2_child_0` AND `q5`.`node_code` = `q4`.`__q2_child_1`) INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q6` ON (`q5`.`tenant_key` = `q6`.`parent_tenant` AND `q5`.`node_code` = `q6`.`parent_code`) WHERE `q4`.`__q2_depth` < ?\n      ) SELECT 1 FROM `__q2_recursive` AS `q4` INNER JOIN `<namespace>`.`rq_provider_nodes` AS `q1` ON (`q1`.`tenant_key` = `q4`.`__q2_child_0` AND `q1`.`node_code` = `q4`.`__q2_child_1`) WHERE (`q1`.`node_code` = ? AND BINARY `q1`.`node_code` = ?))))",
  ],
};
