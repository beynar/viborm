import { PGlite, type Transaction } from "@electric-sql/pglite";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type ColumnType,
  columnDefinitions,
  GRAPH_WORLD,
  HIERARCHY_WORLD,
  PLACEMENT_MATRIX_TABLES,
  providerSchema,
  runCase,
  runPlacementMatrix,
} from "./provider-sql-fixture";

class ObservedPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  readonly rows: (Record<string, unknown>[] | undefined)[] = [];

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    parameters: unknown[],
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
          quote,
        )})`,
      );
      const values: unknown[] = [];
      const tuples = table.rows.map(
        (row) =>
          `(${table.columns
            .map((column) => {
              values.push(row[column.name]);
              return `$${values.length}`;
            })
            .join(", ")})`,
      );
      await driver._executeRaw(
        `INSERT INTO "${table.name}"(${quoted.join(", ")}) VALUES ${tuples.join(", ")}`,
        values,
      );
    }
    driver.statements.length = 0;
    driver.rows.length = 0;
  });

  afterAll(async () => {
    await driver._disconnect();
  });

  it("projects the recursive placement matrix through provider SQL", async () => {
    const engine = createCommandEngine({ schema: providerSchema, driver });
    await runPlacementMatrix(engine, driver);
  });

  for (const world of [HIERARCHY_WORLD, GRAPH_WORLD])
    for (const group of world.groups)
      it(group.name, async () => {
        const engine = createCommandEngine({ schema: world.schema, driver });
        for (const providerCase of group.cases)
          await runCase(engine, driver, providerCase);
      });
});
