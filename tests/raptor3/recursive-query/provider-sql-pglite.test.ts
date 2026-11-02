import assert from "node:assert/strict";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type ColumnType,
  columnDefinitions,
  FILTER_SQL_PINS,
  GRAPH_WORLD,
  HIERARCHY_WORLD,
  PLACEMENT_MATRIX_TABLES,
  providerSchema,
  runCase,
  runPageWalks,
  runPlacementMatrix,
  SELECT_SQL_PINS,
  sqlPins,
} from "./provider-sql-fixture";

class ObservedPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  readonly rows: (Record<string, unknown>[] | undefined)[] = [];

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    this.rows.push(undefined);
    const index = this.rows.length - 1;
    const response = await super.execute<T>(client, statement, parameters);
    this.rows[index] = response.rows as Record<string, unknown>[];
    return response;
  }
}

const PGLITE_TYPES: Readonly<Record<ColumnType, string>> = {
  text: "TEXT",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  json: "JSONB",
};

describe("recursive relation provider SQL on PGlite", () => {
  const driver = new ObservedPGliteDriver();

  beforeAll(async () => {
    // One statement per call: the driver's raw path is PGlite's `query`, which
    // parses a single statement, so a combined script is a syntax error (42601).
    // The RQ-03/RQ-04 worlds live beside the matrix in the same database: their
    // tables are disjoint, and the matrix's two mutations touch neither.
    const quote = (identifier: string) => `"${identifier}"`;
    for (const table of [
      ...PLACEMENT_MATRIX_TABLES,
      ...HIERARCHY_WORLD.tables,
      ...GRAPH_WORLD.tables,
    ]) {
      const quoted = table.columns.map((column) => quote(column.name));
      await driver._executeRaw(
        `CREATE TABLE ${quote(table.name)}(${columnDefinitions(
          table,
          PGLITE_TYPES,
          quote
        )})`
      );
      const values: unknown[] = [];
      const tuples = table.rows.map(
        (row) =>
          `(${table.columns
            .map((column) => {
              values.push(row[column.name]);
              return `$${values.length}`;
            })
            .join(", ")})`
      );
      await driver._executeRaw(
        `INSERT INTO "${table.name}"(${quoted.join(", ")}) VALUES ${tuples.join(", ")}`,
        values
      );
    }
    driver.statements.length = 0;
    driver.rows.length = 0;
  });

  it("pins the recursive filter SQL byte for byte", async () => {
    const engine = createTestCommandEngine({ schema: providerSchema, driver });
    assert.deepEqual(
      await sqlPins(engine, driver, FILTER_SQL_PINS),
      FILTER_SQL
    );
    driver.statements.length = 0;
    driver.rows.length = 0;
  });

  afterAll(async () => {
    await driver._disconnect();
  });

  // Before the matrix, whose writes change the rows these values read.
  it("pins the recursive select SQL byte for byte", async () => {
    const engine = createTestCommandEngine({ schema: providerSchema, driver });
    assert.deepEqual(
      await sqlPins(engine, driver, SELECT_SQL_PINS),
      SELECT_SQL
    );
    driver.statements.length = 0;
    driver.rows.length = 0;
  });

  it("walks a root list's recursive slots once for its whole page", async () => {
    const engine = createTestCommandEngine({ schema: providerSchema, driver });
    await runPageWalks(engine, driver, true);
    driver.statements.length = 0;
    driver.rows.length = 0;
  });

  it("projects the recursive placement matrix through provider SQL", async () => {
    const engine = createTestCommandEngine({ schema: providerSchema, driver });
    await runPlacementMatrix(engine, driver);
  });

  for (const world of [HIERARCHY_WORLD, GRAPH_WORLD])
    for (const group of world.groups)
      it(group.name, async () => {
        const engine = createTestCommandEngine({
          schema: world.schema,
          driver,
        });
        for (const providerCase of group.cases)
          await runCase(engine, driver, providerCase);
      });
});

/** The PostgreSQL adapter's exact text for each pinned case. */
const SELECT_SQL: Readonly<Record<string, readonly string[]>> = {
  "foreign key up, bounded": [
    `WITH RECURSIVE "__q0_page" AS (SELECT "q0"."tenant_key", "q0"."node_code", "q0"."label", "q0"."rank", "q0"."visible", "q0"."parent_tenant", "q0"."parent_code", "q0"."tenant_key" AS "__q0_order_0", "q0"."node_code" AS "__q0_order_1" FROM "public"."rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" = $1 AND "q0"."node_code" = $2) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC), "__q3_recursive" AS (SELECT "q2"."tenant_key" AS "__q3_root_0", "q2"."node_code" AS "__q3_root_1", "q2"."tenant_key" AS "__q3_parent_0", "q2"."node_code" AS "__q3_parent_1", "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1", "q4"."parent_tenant" AS "__q3_hop_0", "q4"."parent_code" AS "__q3_hop_1", CAST($3 AS INTEGER) AS "__q3_depth" FROM "__q0_page" AS "q2" INNER JOIN "public"."rq_provider_nodes" AS "q4" ON ("q2"."parent_tenant" = "q4"."tenant_key" AND "q2"."parent_code" = "q4"."node_code") UNION SELECT "q5"."__q3_root_0", "q5"."__q3_root_1", "q5"."__q3_child_0" AS "__q3_parent_0", "q5"."__q3_child_1" AS "__q3_parent_1", "q6"."tenant_key" AS "__q3_child_0", "q6"."node_code" AS "__q3_child_1", "q6"."parent_tenant" AS "__q3_hop_0", "q6"."parent_code" AS "__q3_hop_1", ("q5"."__q3_depth" + $4) AS "__q3_depth" FROM "__q3_recursive" AS "q5" INNER JOIN "public"."rq_provider_nodes" AS "q6" ON ("q5"."__q3_hop_0" = "q6"."tenant_key" AND "q5"."__q3_hop_1" = "q6"."node_code") WHERE "q5"."__q3_depth" < $5), "__q3_recursive_nodes" AS (SELECT "q7"."__q3_root_0", "q7"."__q3_root_1", COALESCE(json_agg(json_build_object($6::text, json_build_array("q8"."tenant_key", "q8"."node_code"), $7::text, json_build_object($8::text, "q8"."label"))), '[]'::json) AS "__q3_facts" FROM (SELECT DISTINCT ON ("q5"."__q3_root_0", "q5"."__q3_root_1", "q5"."__q3_child_0", "q5"."__q3_child_1") "q5"."__q3_root_0", "q5"."__q3_root_1", "q5"."__q3_child_0" AS "__q3_id_0", "q5"."__q3_child_1" AS "__q3_id_1" FROM "__q3_recursive" AS "q5") AS "q7" INNER JOIN "public"."rq_provider_nodes" AS "q8" ON ("q8"."tenant_key" = "q7"."__q3_id_0" AND "q8"."node_code" = "q7"."__q3_id_1") GROUP BY "q7"."__q3_root_0", "q7"."__q3_root_1"), "__q3_recursive_edges" AS (SELECT "q11"."__q3_root_0", "q11"."__q3_root_1", COALESCE(json_agg("q11"."__q3_edge"), '[]'::json) AS "__q3_facts" FROM (SELECT "q9"."__q3_root_0", "q9"."__q3_root_1", json_build_object($9::text, json_build_array("q9"."__q3_parent_0", "q9"."__q3_parent_1"), $10::text, json_build_array("q9"."__q3_child_0", "q9"."__q3_child_1"), $11::text, "q9"."__q3_depth") AS "__q3_edge" FROM "__q3_recursive" AS "q9" INNER JOIN "public"."rq_provider_nodes" AS "q10" ON ("q10"."tenant_key" = "q9"."__q3_child_0" AND "q10"."node_code" = "q9"."__q3_child_1") ORDER BY "q9"."__q3_root_0" ASC, "q9"."__q3_root_1" ASC, "q9"."__q3_parent_0" ASC, "q9"."__q3_parent_1" ASC, "q10"."tenant_key" ASC, "q10"."node_code" ASC) AS "q11" GROUP BY "q11"."__q3_root_0", "q11"."__q3_root_1") SELECT "q1"."label", json_build_object($12::text, json_build_array("q1"."tenant_key", "q1"."node_code"), $13::text, COALESCE("q12"."__q3_facts", '[]'::json), $14::text, COALESCE("q13"."__q3_facts", '[]'::json)) AS "parent" FROM "__q0_page" AS "q1" LEFT JOIN "__q3_recursive_nodes" AS "q12" ON ("q1"."tenant_key" = "q12"."__q3_root_0" AND "q1"."node_code" = "q12"."__q3_root_1") LEFT JOIN "__q3_recursive_edges" AS "q13" ON ("q1"."tenant_key" = "q13"."__q3_root_0" AND "q1"."node_code" = "q13"."__q3_root_1") ORDER BY "q1"."__q0_order_0" ASC, "q1"."__q0_order_1" ASC`,
  ],
  "foreign key down, exhaustive, selector": [
    `WITH RECURSIVE "__q0_page" AS (SELECT "q0"."tenant_key", "q0"."node_code", "q0"."label", "q0"."rank", "q0"."visible", "q0"."parent_tenant", "q0"."parent_code", "q0"."tenant_key" AS "__q0_order_0", "q0"."node_code" AS "__q0_order_1" FROM "public"."rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" = $1 AND "q0"."node_code" = $2) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC), "__q3_recursive" AS (SELECT "q2"."tenant_key" AS "__q3_root_0", "q2"."node_code" AS "__q3_root_1", "q2"."tenant_key" AS "__q3_parent_0", "q2"."node_code" AS "__q3_parent_1", "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1" FROM "__q0_page" AS "q2" INNER JOIN "public"."rq_provider_nodes" AS "q4" ON ("q2"."tenant_key" = "q4"."parent_tenant" AND "q2"."node_code" = "q4"."parent_code") WHERE "q4"."visible" = $3 UNION SELECT "q5"."__q3_root_0", "q5"."__q3_root_1", "q5"."__q3_child_0" AS "__q3_parent_0", "q5"."__q3_child_1" AS "__q3_parent_1", "q6"."tenant_key" AS "__q3_child_0", "q6"."node_code" AS "__q3_child_1" FROM "__q3_recursive" AS "q5" INNER JOIN "public"."rq_provider_nodes" AS "q6" ON ("q5"."__q3_child_0" = "q6"."parent_tenant" AND "q5"."__q3_child_1" = "q6"."parent_code") WHERE "q6"."visible" = $4), "__q3_recursive_nodes" AS (SELECT "q7"."__q3_root_0", "q7"."__q3_root_1", COALESCE(json_agg(json_build_object($5::text, json_build_array("q8"."tenant_key", "q8"."node_code"), $6::text, json_build_object($7::text, "q8"."label"))), '[]'::json) AS "__q3_facts" FROM (SELECT DISTINCT ON ("q5"."__q3_root_0", "q5"."__q3_root_1", "q5"."__q3_child_0", "q5"."__q3_child_1") "q5"."__q3_root_0", "q5"."__q3_root_1", "q5"."__q3_child_0" AS "__q3_id_0", "q5"."__q3_child_1" AS "__q3_id_1" FROM "__q3_recursive" AS "q5") AS "q7" INNER JOIN "public"."rq_provider_nodes" AS "q8" ON ("q8"."tenant_key" = "q7"."__q3_id_0" AND "q8"."node_code" = "q7"."__q3_id_1") GROUP BY "q7"."__q3_root_0", "q7"."__q3_root_1"), "__q3_recursive_edges" AS (SELECT "q11"."__q3_root_0", "q11"."__q3_root_1", COALESCE(json_agg("q11"."__q3_edge"), '[]'::json) AS "__q3_facts" FROM (SELECT "q9"."__q3_root_0", "q9"."__q3_root_1", json_build_object($8::text, json_build_array("q9"."__q3_parent_0", "q9"."__q3_parent_1"), $9::text, json_build_array("q9"."__q3_child_0", "q9"."__q3_child_1")) AS "__q3_edge" FROM "__q3_recursive" AS "q9" INNER JOIN "public"."rq_provider_nodes" AS "q10" ON ("q10"."tenant_key" = "q9"."__q3_child_0" AND "q10"."node_code" = "q9"."__q3_child_1") ORDER BY "q9"."__q3_root_0" ASC, "q9"."__q3_root_1" ASC, "q9"."__q3_parent_0" ASC, "q9"."__q3_parent_1" ASC, "q10"."tenant_key" ASC, "q10"."node_code" ASC) AS "q11" GROUP BY "q11"."__q3_root_0", "q11"."__q3_root_1") SELECT "q1"."label", json_build_object($10::text, json_build_array("q1"."tenant_key", "q1"."node_code"), $11::text, COALESCE("q12"."__q3_facts", '[]'::json), $12::text, COALESCE("q13"."__q3_facts", '[]'::json)) AS "children" FROM "__q0_page" AS "q1" LEFT JOIN "__q3_recursive_nodes" AS "q12" ON ("q1"."tenant_key" = "q12"."__q3_root_0" AND "q1"."node_code" = "q12"."__q3_root_1") LEFT JOIN "__q3_recursive_edges" AS "q13" ON ("q1"."tenant_key" = "q13"."__q3_root_0" AND "q1"."node_code" = "q13"."__q3_root_1") ORDER BY "q1"."__q0_order_0" ASC, "q1"."__q0_order_1" ASC`,
  ],
  "junction, bounded, selector": [
    `WITH RECURSIVE "__q0_page" AS (SELECT "q0"."tenant_key", "q0"."node_code", "q0"."label", "q0"."rank", "q0"."visible", "q0"."parent_tenant", "q0"."parent_code", "q0"."tenant_key" AS "__q0_order_0", "q0"."node_code" AS "__q0_order_1" FROM "public"."rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" = $1 AND "q0"."node_code" = $2) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC), "__q3_recursive" AS (SELECT "q2"."tenant_key" AS "__q3_root_0", "q2"."node_code" AS "__q3_root_1", "q2"."tenant_key" AS "__q3_parent_0", "q2"."node_code" AS "__q3_parent_1", "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1", CAST($3 AS INTEGER) AS "__q3_depth" FROM "__q0_page" AS "q2" INNER JOIN "public"."rq_provider_links" AS "q5" ON ("q5"."from_1" = "q2"."tenant_key" AND "q5"."from_2" = "q2"."node_code") INNER JOIN "public"."rq_provider_nodes" AS "q4" ON ("q5"."to_1" = "q4"."tenant_key" AND "q5"."to_2" = "q4"."node_code") WHERE "q4"."visible" = $4 UNION SELECT "q6"."__q3_root_0", "q6"."__q3_root_1", "q6"."__q3_child_0" AS "__q3_parent_0", "q6"."__q3_child_1" AS "__q3_parent_1", "q7"."tenant_key" AS "__q3_child_0", "q7"."node_code" AS "__q3_child_1", ("q6"."__q3_depth" + $5) AS "__q3_depth" FROM "__q3_recursive" AS "q6" INNER JOIN "public"."rq_provider_links" AS "q8" ON ("q8"."from_1" = "q6"."__q3_child_0" AND "q8"."from_2" = "q6"."__q3_child_1") INNER JOIN "public"."rq_provider_nodes" AS "q7" ON ("q8"."to_1" = "q7"."tenant_key" AND "q8"."to_2" = "q7"."node_code") WHERE ("q6"."__q3_depth" < $6 AND "q7"."visible" = $7)), "__q3_recursive_nodes" AS (SELECT "q9"."__q3_root_0", "q9"."__q3_root_1", COALESCE(json_agg(json_build_object($8::text, json_build_array("q10"."tenant_key", "q10"."node_code"), $9::text, json_build_object($10::text, "q10"."label"))), '[]'::json) AS "__q3_facts" FROM (SELECT DISTINCT ON ("q6"."__q3_root_0", "q6"."__q3_root_1", "q6"."__q3_child_0", "q6"."__q3_child_1") "q6"."__q3_root_0", "q6"."__q3_root_1", "q6"."__q3_child_0" AS "__q3_id_0", "q6"."__q3_child_1" AS "__q3_id_1" FROM "__q3_recursive" AS "q6") AS "q9" INNER JOIN "public"."rq_provider_nodes" AS "q10" ON ("q10"."tenant_key" = "q9"."__q3_id_0" AND "q10"."node_code" = "q9"."__q3_id_1") GROUP BY "q9"."__q3_root_0", "q9"."__q3_root_1"), "__q3_recursive_edges" AS (SELECT "q13"."__q3_root_0", "q13"."__q3_root_1", COALESCE(json_agg("q13"."__q3_edge"), '[]'::json) AS "__q3_facts" FROM (SELECT "q11"."__q3_root_0", "q11"."__q3_root_1", json_build_object($11::text, json_build_array("q11"."__q3_parent_0", "q11"."__q3_parent_1"), $12::text, json_build_array("q11"."__q3_child_0", "q11"."__q3_child_1"), $13::text, "q11"."__q3_depth") AS "__q3_edge" FROM "__q3_recursive" AS "q11" INNER JOIN "public"."rq_provider_nodes" AS "q12" ON ("q12"."tenant_key" = "q11"."__q3_child_0" AND "q12"."node_code" = "q11"."__q3_child_1") ORDER BY "q11"."__q3_root_0" ASC, "q11"."__q3_root_1" ASC, "q11"."__q3_parent_0" ASC, "q11"."__q3_parent_1" ASC, "q12"."node_code" ASC, "q12"."tenant_key" ASC) AS "q13" GROUP BY "q13"."__q3_root_0", "q13"."__q3_root_1") SELECT "q1"."label", json_build_object($14::text, json_build_array("q1"."tenant_key", "q1"."node_code"), $15::text, COALESCE("q14"."__q3_facts", '[]'::json), $16::text, COALESCE("q15"."__q3_facts", '[]'::json)) AS "neighbors" FROM "__q0_page" AS "q1" LEFT JOIN "__q3_recursive_nodes" AS "q14" ON ("q1"."tenant_key" = "q14"."__q3_root_0" AND "q1"."node_code" = "q14"."__q3_root_1") LEFT JOIN "__q3_recursive_edges" AS "q15" ON ("q1"."tenant_key" = "q15"."__q3_root_0" AND "q1"."node_code" = "q15"."__q3_root_1") ORDER BY "q1"."__q0_order_0" ASC, "q1"."__q0_order_1" ASC`,
  ],
  "junction, exhaustive": [
    `WITH RECURSIVE "__q0_page" AS (SELECT "q0"."tenant_key", "q0"."node_code", "q0"."label", "q0"."rank", "q0"."visible", "q0"."parent_tenant", "q0"."parent_code", "q0"."tenant_key" AS "__q0_order_0", "q0"."node_code" AS "__q0_order_1" FROM "public"."rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" = $1 AND "q0"."node_code" = $2) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC), "__q3_recursive" AS (SELECT "q2"."tenant_key" AS "__q3_root_0", "q2"."node_code" AS "__q3_root_1", "q2"."tenant_key" AS "__q3_parent_0", "q2"."node_code" AS "__q3_parent_1", "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1" FROM "__q0_page" AS "q2" INNER JOIN "public"."rq_provider_links" AS "q5" ON ("q5"."from_1" = "q2"."tenant_key" AND "q5"."from_2" = "q2"."node_code") INNER JOIN "public"."rq_provider_nodes" AS "q4" ON ("q5"."to_1" = "q4"."tenant_key" AND "q5"."to_2" = "q4"."node_code") UNION SELECT "q6"."__q3_root_0", "q6"."__q3_root_1", "q6"."__q3_child_0" AS "__q3_parent_0", "q6"."__q3_child_1" AS "__q3_parent_1", "q7"."tenant_key" AS "__q3_child_0", "q7"."node_code" AS "__q3_child_1" FROM "__q3_recursive" AS "q6" INNER JOIN "public"."rq_provider_links" AS "q8" ON ("q8"."from_1" = "q6"."__q3_child_0" AND "q8"."from_2" = "q6"."__q3_child_1") INNER JOIN "public"."rq_provider_nodes" AS "q7" ON ("q8"."to_1" = "q7"."tenant_key" AND "q8"."to_2" = "q7"."node_code")), "__q3_recursive_nodes" AS (SELECT "q9"."__q3_root_0", "q9"."__q3_root_1", COALESCE(json_agg(json_build_object($3::text, json_build_array("q10"."tenant_key", "q10"."node_code"), $4::text, json_build_object($5::text, "q10"."label"))), '[]'::json) AS "__q3_facts" FROM (SELECT DISTINCT ON ("q6"."__q3_root_0", "q6"."__q3_root_1", "q6"."__q3_child_0", "q6"."__q3_child_1") "q6"."__q3_root_0", "q6"."__q3_root_1", "q6"."__q3_child_0" AS "__q3_id_0", "q6"."__q3_child_1" AS "__q3_id_1" FROM "__q3_recursive" AS "q6") AS "q9" INNER JOIN "public"."rq_provider_nodes" AS "q10" ON ("q10"."tenant_key" = "q9"."__q3_id_0" AND "q10"."node_code" = "q9"."__q3_id_1") GROUP BY "q9"."__q3_root_0", "q9"."__q3_root_1"), "__q3_recursive_edges" AS (SELECT "q13"."__q3_root_0", "q13"."__q3_root_1", COALESCE(json_agg("q13"."__q3_edge"), '[]'::json) AS "__q3_facts" FROM (SELECT "q11"."__q3_root_0", "q11"."__q3_root_1", json_build_object($6::text, json_build_array("q11"."__q3_parent_0", "q11"."__q3_parent_1"), $7::text, json_build_array("q11"."__q3_child_0", "q11"."__q3_child_1")) AS "__q3_edge" FROM "__q3_recursive" AS "q11" INNER JOIN "public"."rq_provider_nodes" AS "q12" ON ("q12"."tenant_key" = "q11"."__q3_child_0" AND "q12"."node_code" = "q11"."__q3_child_1") ORDER BY "q11"."__q3_root_0" ASC, "q11"."__q3_root_1" ASC, "q11"."__q3_parent_0" ASC, "q11"."__q3_parent_1" ASC, "q12"."node_code" ASC, "q12"."tenant_key" ASC) AS "q13" GROUP BY "q13"."__q3_root_0", "q13"."__q3_root_1") SELECT "q1"."label", json_build_object($8::text, json_build_array("q1"."tenant_key", "q1"."node_code"), $9::text, COALESCE("q14"."__q3_facts", '[]'::json), $10::text, COALESCE("q15"."__q3_facts", '[]'::json)) AS "neighbors" FROM "__q0_page" AS "q1" LEFT JOIN "__q3_recursive_nodes" AS "q14" ON ("q1"."tenant_key" = "q14"."__q3_root_0" AND "q1"."node_code" = "q14"."__q3_root_1") LEFT JOIN "__q3_recursive_edges" AS "q15" ON ("q1"."tenant_key" = "q15"."__q3_root_0" AND "q1"."node_code" = "q15"."__q3_root_1") ORDER BY "q1"."__q0_order_0" ASC, "q1"."__q0_order_1" ASC`,
  ],
};

const FILTER_SQL: Readonly<Record<string, readonly string[]>> = {
  "foreign-key ancestors with self, default depth": [
    `SELECT "q0"."node_code" AS "code" FROM "public"."rq_provider_nodes" AS "q0" WHERE EXISTS (WITH RECURSIVE "__q3_recursive" AS (
        SELECT "q5"."__q3_child_0", "q5"."__q3_child_1", "q5"."__q3_hop_0", "q5"."__q3_hop_1", "q5"."__q3_depth" FROM (SELECT "q0"."tenant_key" AS "__q3_child_0", "q0"."node_code" AS "__q3_child_1", "q0"."parent_tenant" AS "__q3_hop_0", "q0"."parent_code" AS "__q3_hop_1", CAST($1 AS INTEGER) AS "__q3_depth" UNION SELECT "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1", "q4"."parent_tenant" AS "__q3_hop_0", "q4"."parent_code" AS "__q3_hop_1", CAST($2 AS INTEGER) AS "__q3_depth" FROM "public"."rq_provider_nodes" AS "q4" WHERE ("q0"."parent_tenant" = "q4"."tenant_key" AND "q0"."parent_code" = "q4"."node_code")) AS "q5"
        UNION
        SELECT "q7"."tenant_key" AS "__q3_child_0", "q7"."node_code" AS "__q3_child_1", "q7"."parent_tenant" AS "__q3_hop_0", "q7"."parent_code" AS "__q3_hop_1", ("q6"."__q3_depth" + $3) AS "__q3_depth" FROM "__q3_recursive" AS "q6" INNER JOIN "public"."rq_provider_nodes" AS "q7" ON ("q6"."__q3_hop_0" = "q7"."tenant_key" AND "q6"."__q3_hop_1" = "q7"."node_code") WHERE "q6"."__q3_depth" < $4
      ) SELECT 1 FROM "__q3_recursive" AS "q6" INNER JOIN "public"."rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q6"."__q3_child_0" AND "q1"."node_code" = "q6"."__q3_child_1") WHERE EXISTS (SELECT 1 FROM "public"."rq_provider_notes" AS "q2" WHERE (("q1"."tenant_key" = "q2"."node_tenant" AND "q1"."node_code" = "q2"."node_code") AND "q2"."text" = $5))) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "junction walk with self, bounded, nested in a relation filter": [
    `SELECT "q0"."id" FROM "public"."rq_provider_notes" AS "q0" WHERE EXISTS (SELECT 1 FROM "public"."rq_provider_nodes" AS "q1" WHERE (("q0"."node_tenant" = "q1"."tenant_key" AND "q0"."node_code" = "q1"."node_code") AND EXISTS (WITH RECURSIVE "__q4_recursive" AS (
        SELECT "q7"."__q4_child_0", "q7"."__q4_child_1", "q7"."__q4_depth" FROM (SELECT "q1"."tenant_key" AS "__q4_child_0", "q1"."node_code" AS "__q4_child_1", CAST($1 AS INTEGER) AS "__q4_depth" UNION SELECT "q5"."tenant_key" AS "__q4_child_0", "q5"."node_code" AS "__q4_child_1", CAST($2 AS INTEGER) AS "__q4_depth" FROM "public"."rq_provider_nodes" AS "q5" WHERE ("q5"."tenant_key", "q5"."node_code") IN (SELECT "q6"."to_1", "q6"."to_2" FROM "public"."rq_provider_links" AS "q6" WHERE ("q6"."from_1" = "q1"."tenant_key" AND "q6"."from_2" = "q1"."node_code"))) AS "q7"
        UNION
        SELECT "q9"."tenant_key" AS "__q4_child_0", "q9"."node_code" AS "__q4_child_1", ("q8"."__q4_depth" + $3) AS "__q4_depth" FROM "__q4_recursive" AS "q8" INNER JOIN "public"."rq_provider_links" AS "q10" ON ("q10"."from_1" = "q8"."__q4_child_0" AND "q10"."from_2" = "q8"."__q4_child_1") INNER JOIN "public"."rq_provider_nodes" AS "q9" ON ("q10"."to_1" = "q9"."tenant_key" AND "q10"."to_2" = "q9"."node_code") WHERE "q8"."__q4_depth" < $4
      ) SELECT 1 FROM "__q4_recursive" AS "q8" INNER JOIN "public"."rq_provider_nodes" AS "q2" ON ("q2"."tenant_key" = "q8"."__q4_child_0" AND "q2"."node_code" = "q8"."__q4_child_1") WHERE (EXISTS (SELECT 1 FROM "public"."rq_provider_notes" AS "q3" WHERE (("q2"."tenant_key" = "q3"."node_tenant" AND "q2"."node_code" = "q3"."node_code") AND "q3"."position" = $5)) OR "q2"."label" = $6)))) ORDER BY "q0"."id" ASC`,
  ],
  "foreign-key descendants, exhaustive, none": [
    `SELECT "q0"."node_code" AS "code" FROM "public"."rq_provider_nodes" AS "q0" WHERE NOT EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."tenant_key" AS "__q2_child_0", "q3"."node_code" AS "__q2_child_1" FROM "public"."rq_provider_nodes" AS "q3" WHERE ("q0"."tenant_key" = "q3"."parent_tenant" AND "q0"."node_code" = "q3"."parent_code")
        UNION
        SELECT "q5"."tenant_key" AS "__q2_child_0", "q5"."node_code" AS "__q2_child_1" FROM "__q2_recursive" AS "q4" INNER JOIN "public"."rq_provider_nodes" AS "q5" ON ("q4"."__q2_child_0" = "q5"."parent_tenant" AND "q4"."__q2_child_1" = "q5"."parent_code")
      ) SELECT 1 FROM "__q2_recursive" AS "q4" INNER JOIN "public"."rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q4"."__q2_child_0" AND "q1"."node_code" = "q4"."__q2_child_1") WHERE "q1"."visible" = $1) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "junction, one hop, every over empty closures": [
    `SELECT "q0"."node_code" AS "code" FROM "public"."rq_provider_nodes" AS "q0" WHERE NOT EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."tenant_key" AS "__q2_child_0", "q3"."node_code" AS "__q2_child_1", CAST($1 AS INTEGER) AS "__q2_depth" FROM "public"."rq_provider_nodes" AS "q3" WHERE ("q3"."tenant_key", "q3"."node_code") IN (SELECT "q4"."to_1", "q4"."to_2" FROM "public"."rq_provider_links" AS "q4" WHERE ("q4"."from_1" = "q0"."tenant_key" AND "q4"."from_2" = "q0"."node_code"))
        UNION
        SELECT "q6"."tenant_key" AS "__q2_child_0", "q6"."node_code" AS "__q2_child_1", ("q5"."__q2_depth" + $2) AS "__q2_depth" FROM "__q2_recursive" AS "q5" INNER JOIN "public"."rq_provider_links" AS "q7" ON ("q7"."from_1" = "q5"."__q2_child_0" AND "q7"."from_2" = "q5"."__q2_child_1") INNER JOIN "public"."rq_provider_nodes" AS "q6" ON ("q7"."to_1" = "q6"."tenant_key" AND "q7"."to_2" = "q6"."node_code") WHERE "q5"."__q2_depth" < $3
      ) SELECT 1 FROM "__q2_recursive" AS "q5" INNER JOIN "public"."rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q5"."__q2_child_0" AND "q1"."node_code" = "q5"."__q2_child_1") WHERE NOT ("q1"."rank" >= $4)) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "a closure nested in a closure": [
    `SELECT "q0"."node_code" AS "code" FROM "public"."rq_provider_nodes" AS "q0" WHERE EXISTS (WITH RECURSIVE "__q13_recursive" AS (
        SELECT "q14"."tenant_key" AS "__q13_child_0", "q14"."node_code" AS "__q13_child_1", "q14"."parent_tenant" AS "__q13_hop_0", "q14"."parent_code" AS "__q13_hop_1", CAST($1 AS INTEGER) AS "__q13_depth" FROM "public"."rq_provider_nodes" AS "q14" WHERE ("q0"."parent_tenant" = "q14"."tenant_key" AND "q0"."parent_code" = "q14"."node_code")
        UNION
        SELECT "q16"."tenant_key" AS "__q13_child_0", "q16"."node_code" AS "__q13_child_1", "q16"."parent_tenant" AS "__q13_hop_0", "q16"."parent_code" AS "__q13_hop_1", ("q15"."__q13_depth" + $2) AS "__q13_depth" FROM "__q13_recursive" AS "q15" INNER JOIN "public"."rq_provider_nodes" AS "q16" ON ("q15"."__q13_hop_0" = "q16"."tenant_key" AND "q15"."__q13_hop_1" = "q16"."node_code") WHERE "q15"."__q13_depth" < $3
      ) SELECT 1 FROM "__q13_recursive" AS "q15" INNER JOIN "public"."rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q15"."__q13_child_0" AND "q1"."node_code" = "q15"."__q13_child_1") WHERE EXISTS (WITH RECURSIVE "__q3_recursive" AS (
        SELECT "q6"."__q3_child_0", "q6"."__q3_child_1" FROM (SELECT "q1"."tenant_key" AS "__q3_child_0", "q1"."node_code" AS "__q3_child_1" UNION SELECT "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1" FROM "public"."rq_provider_nodes" AS "q4" WHERE ("q4"."tenant_key", "q4"."node_code") IN (SELECT "q5"."to_1", "q5"."to_2" FROM "public"."rq_provider_links" AS "q5" WHERE ("q5"."from_1" = "q1"."tenant_key" AND "q5"."from_2" = "q1"."node_code"))) AS "q6"
        UNION
        SELECT "q8"."tenant_key" AS "__q3_child_0", "q8"."node_code" AS "__q3_child_1" FROM "__q3_recursive" AS "q7" INNER JOIN "public"."rq_provider_links" AS "q9" ON ("q9"."from_1" = "q7"."__q3_child_0" AND "q9"."from_2" = "q7"."__q3_child_1") INNER JOIN "public"."rq_provider_nodes" AS "q8" ON ("q9"."to_1" = "q8"."tenant_key" AND "q9"."to_2" = "q8"."node_code")
      ) SELECT 1 FROM "__q3_recursive" AS "q7" INNER JOIN "public"."rq_provider_nodes" AS "q2" ON ("q2"."tenant_key" = "q7"."__q3_child_0" AND "q2"."node_code" = "q7"."__q3_child_1") WHERE "q2"."node_code" = $4)) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "updateMany walking the table it updates": [
    `UPDATE "public"."rq_provider_nodes" SET "rank" = "rank" + $1 WHERE EXISTS (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1", "q2"."parent_tenant" AS "__q1_hop_0", "q2"."parent_code" AS "__q1_hop_1", CAST($2 AS INTEGER) AS "__q1_depth" FROM "public"."rq_provider_nodes" AS "q2" WHERE ("rq_provider_nodes"."parent_tenant" = "q2"."tenant_key" AND "rq_provider_nodes"."parent_code" = "q2"."node_code")
        UNION
        SELECT "q4"."tenant_key" AS "__q1_child_0", "q4"."node_code" AS "__q1_child_1", "q4"."parent_tenant" AS "__q1_hop_0", "q4"."parent_code" AS "__q1_hop_1", ("q3"."__q1_depth" + $3) AS "__q1_depth" FROM "__q1_recursive" AS "q3" INNER JOIN "public"."rq_provider_nodes" AS "q4" ON ("q3"."__q1_hop_0" = "q4"."tenant_key" AND "q3"."__q1_hop_1" = "q4"."node_code") WHERE "q3"."__q1_depth" < $4
      ) SELECT 1 FROM "__q1_recursive" AS "q3" INNER JOIN "public"."rq_provider_nodes" AS "q0" ON ("q0"."tenant_key" = "q3"."__q1_child_0" AND "q0"."node_code" = "q3"."__q1_child_1") WHERE "q0"."node_code" = $5)`,
  ],
  "updateMany walking another table": [
    `UPDATE "public"."rq_provider_forests" SET "name" = $1 WHERE EXISTS (SELECT 1 FROM "public"."rq_provider_nodes" AS "q0" WHERE (("rq_provider_forests"."entry_tenant" = "q0"."tenant_key" AND "rq_provider_forests"."entry_code" = "q0"."node_code") AND EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."tenant_key" AS "__q2_child_0", "q3"."node_code" AS "__q2_child_1", CAST($2 AS INTEGER) AS "__q2_depth" FROM "public"."rq_provider_nodes" AS "q3" WHERE ("q0"."tenant_key" = "q3"."parent_tenant" AND "q0"."node_code" = "q3"."parent_code")
        UNION
        SELECT "q5"."tenant_key" AS "__q2_child_0", "q5"."node_code" AS "__q2_child_1", ("q4"."__q2_depth" + $3) AS "__q2_depth" FROM "__q2_recursive" AS "q4" INNER JOIN "public"."rq_provider_nodes" AS "q5" ON ("q4"."__q2_child_0" = "q5"."parent_tenant" AND "q4"."__q2_child_1" = "q5"."parent_code") WHERE "q4"."__q2_depth" < $4
      ) SELECT 1 FROM "__q2_recursive" AS "q4" INNER JOIN "public"."rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q4"."__q2_child_0" AND "q1"."node_code" = "q4"."__q2_child_1") WHERE "q1"."node_code" = $5)))`,
  ],
};
