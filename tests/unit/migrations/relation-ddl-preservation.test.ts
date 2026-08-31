/** Live relation-to-DDL convergence across local SQLite and PGlite. */

import { createClient } from "@client/client";
import type { AnyModel } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchema, validateSchemaOrThrow } from "@src/schema/validation";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { relationDdlBaseline } from "@tests/fixtures/relation-ddl-baseline";
import { type RelationDdlCase, relationDdlCorpus } from "@tests/fixtures/relation-ddl-corpus";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const CREATE_TABLE_NAME =
  /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:(?:"[^"]+"|\x60[^\x60]+\x60|\w+)\.)?(?:"([^"]+)"|\x60([^\x60]+)\x60|(\w+))/i;

function prepare(testCase: RelationDdlCase): {
  readonly schema: Record<string, AnyModel>;
} {
  const schema = testCase.build();
  hydrateSchemaNames(schema);
  const validation = validateSchema(schema);
  if (validation.valid) validateSchemaOrThrow(schema);
  return { schema };
}

function createdTableNames(result: {
  readonly statements: readonly { readonly sql: string }[];
}): string[] {
  const names: string[] = [];
  for (const statement of result.statements) {
    const match = statement.sql.match(CREATE_TABLE_NAME);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name && !name.startsWith("__new_")) {
      names.push(name);
    }
  }
  return names;
}

const convergingCases = relationDdlCorpus.filter(
  (testCase) => testCase.converges
);

/**
 * The cells whose Postgres convergence is worth its wall time: one row FK cell,
 * the default junction, a compound junction, both variant storage families, and
 * the mixed-junction table-order witness.
 */
const PGLITE_CELLS = new Set([
  "one-to-many-required-fk",
  "many-to-many-default-names",
  "many-to-many-compound-keys",
  "variant-row-to-one-inverse",
  "variant-member-mixed-inverses",
  "ordinary-junction-before-variant-carrier",
]);

describe("relation → DDL convergence", () => {
  it.each(
    convergingCases
  )("$id creates once and then plans no operations on SQLite", async (testCase) => {
    const driver = createInMemorySQLite3Driver();
    try {
      const client = createClient({ schema: prepare(testCase).schema, driver });
      const first = await syncLiveSchema(client);
      expect(
        first.operations.filter(
          (operation) => operation.label === "createTable"
        )
      ).toHaveLength(
        relationDdlBaseline[testCase.id]?.postgres?.tables.length ?? 0
      );
      expect(createdTableNames(first)).toEqual(
        relationDdlBaseline[testCase.id]?.postgres?.tables.map(
          (table) => table.name
        )
      );
      expect((await syncLiveSchema(client)).operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });

  it.each(
    convergingCases.filter((testCase) => PGLITE_CELLS.has(testCase.id))
  )("$id creates once and then plans no operations on PGlite", async (testCase) => {
    const driver = createInMemoryPGliteDriver();
    try {
      const client = createClient({ schema: prepare(testCase).schema, driver });
      const first = await syncLiveSchema(client);
      expect(
        first.operations.filter(
          (operation) => operation.label === "createTable"
        )
      ).toHaveLength(
        relationDdlBaseline[testCase.id]?.postgres?.tables.length ?? 0
      );
      expect(createdTableNames(first)).toEqual(
        relationDdlBaseline[testCase.id]?.postgres?.tables.map(
          (table) => table.name
        )
      );
      expect((await syncLiveSchema(client)).operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });
});

