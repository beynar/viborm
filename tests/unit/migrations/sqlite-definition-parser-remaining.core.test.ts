import {
  sqliteConstraintClauses,
  sqliteTableDefinitions,
} from "@src/migrations/drivers/sqlite/column-constraints";
import { describe, expect, test } from "vitest";

describe("SQLite table-definition parsing", () => {
  test("separates bare and quoted columns from top-level constraints", () => {
    const definitions = sqliteTableDefinitions(`
      CREATE TABLE "events" (
        bare TEXT DEFAULT 'comma, inside',
        "quoted name" INTEGER,
        CONSTRAINT "events_pair_key" UNIQUE (bare, "quoted name"),
        CHECK (instr(bare, ',') > 0)
      )
    `);

    expect(definitions).toEqual([
      {
        text: "bare TEXT DEFAULT 'comma, inside'",
        columnName: "bare",
      },
      { text: '"quoted name" INTEGER', columnName: "quoted name" },
      {
        text: 'CONSTRAINT "events_pair_key" UNIQUE (bare, "quoted name")',
        columnName: undefined,
      },
      {
        text: "CHECK (instr(bare, ',') > 0)",
        columnName: undefined,
      },
    ]);
  });

  test("finds only structural, top-level named constraints", () => {
    const definition = `value TEXT CONSTRAINT "outer_check" CHECK (
      value <> 'CONSTRAINT hidden' AND
      length(value) > (SELECT length('CONSTRAINT nested'))
    ) CONSTRAINT outer_unique UNIQUE`;
    const clauses = sqliteConstraintClauses(definition);

    expect(clauses.map(({ name }) => name)).toEqual([
      "outer_check",
      "outer_unique",
    ]);
    expect(
      clauses.every(({ offset }) =>
        definition.slice(offset).startsWith("CONSTRAINT")
      )
    ).toBe(true);
  });
});
