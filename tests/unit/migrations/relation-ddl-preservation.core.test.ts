/**
 * Relation → DDL preservation corpus (plan §9.3, §11.5; ruling D4).
 *
 * The unified relation language promises that a canonical schema keeps its
 * physical artifact when its declaration is rewritten. That promise is only
 * testable against evidence frozen BEFORE the rewrite, so this suite compares
 * HEAD's live serializer output against `tests/fixtures/relation-ddl-baseline.ts`,
 * captured from HEAD.
 *
 * Declaration and artifact are separate files on purpose: Package F rewrites
 * `relation-ddl-corpus.ts` into the final relation language, the baseline stays
 * frozen, and a rewrite that moves one column, index, constraint, referential
 * action, history member, or TABLE POSITION turns this suite red.
 *
 * What each assertion uniquely covers:
 *  - the baseline-coverage test: an artifact frozen for a case that no longer
 *    exists (nothing else notices an orphan);
 *  - the verdict assertion: whether the case still reaches the serializer the
 *    same way it does today (it selects the validation path below); the
 *    complete topology verdict matrix is NOT owned here;
 *  - the snapshot comparison: the preservation theorem itself;
 *  - second push: that what the serializer emits and what a live database
 *    reports are the same shape. SQLite is the recreate-table dialect; PGlite is
 *    the dialect the baseline pins, and it runs on a representative subset
 *    because a PGlite push costs ~0.4 s against this layer's 30 s budget.
 */

import { createClient } from "@client/client";
import { push } from "@migrations";
import type { AnyModel } from "@schema/model";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchema, validateSchemaOrThrow } from "@src/schema/validation";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { relationDdlBaseline } from "@tests/fixtures/relation-ddl-baseline";
import {
  type DdlDialect,
  type RelationDdlCase,
  relationDdlCorpus,
} from "@tests/fixtures/relation-ddl-corpus";
import { describe, expect, it } from "vitest";

const migrationDrivers = {
  postgres: postgresMigrationDriver,
  mysql: mysqlMigrationDriver,
  sqlite: sqlite3MigrationDriver,
  libsql: libsqlMigrationDriver,
} satisfies Record<DdlDialect, unknown>;

/**
 * Hydrate and run HEAD's definition validator. A valid schema is validated
 * through the throwing entry point too, because that is what materializes a
 * variant carrier's private storage — the descriptor the serializer reads.
 */
function prepare(testCase: RelationDdlCase): {
  readonly schema: Record<string, AnyModel>;
  readonly errorCodes: readonly string[];
  readonly valid: boolean;
} {
  const schema = testCase.build();
  hydrateSchemaNames(schema);
  const result = validateSchema(schema);
  if (result.valid) {
    validateSchemaOrThrow(schema);
  }
  return {
    schema,
    errorCodes: result.errors.map((issue) => issue.code),
    valid: result.valid,
  };
}

describe("relation → DDL preservation corpus", () => {
  it("freezes one artifact set per corpus case and nothing else", () => {
    expect(Object.keys(relationDdlBaseline)).toEqual(
      relationDdlCorpus.map((testCase) => testCase.id)
    );
  });

  it.each(
    relationDdlCorpus
  )("$id serializes to its frozen artifact", (testCase) => {
    const { schema, valid, errorCodes } = prepare(testCase);

    // The FINAL verdict, which differs from HEAD's exactly where §9.4 says so;
    // `headVerdict` stays the frozen record of what HEAD answered.
    const expectedVerdict = testCase.intendedVerdict ?? testCase.headVerdict;
    const expectedCodes =
      testCase.intendedErrorCodes ?? testCase.headErrorCodes;
    expect(valid).toBe(expectedVerdict === "valid");
    if (expectedCodes) {
      expect(errorCodes).toEqual(expectedCodes);
    }

    for (const dialect of testCase.dialects) {
      const snapshot = serializeModels(schema, {
        migrationDriver: migrationDrivers[dialect],
      });
      expect(snapshot).toEqual(relationDdlBaseline[testCase.id]?.[dialect]);
    }
  });
});

// =============================================================================
// LIVE CONVERGENCE — a second forced push planning ZERO operations is the
// strongest statement that the frozen snapshot and the database agree.
// =============================================================================

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
      const first = await push(client, { force: true });
      expect(
        first.operations
          .filter((operation) => operation.type === "createTable")
          .map((operation) => operation.table.name)
      ).toEqual(
        relationDdlBaseline[testCase.id]?.postgres?.tables.map(
          (table) => table.name
        )
      );
      expect((await push(client, { force: true })).operations).toEqual([]);
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
      const first = await push(client, { force: true });
      expect(
        first.operations
          .filter((operation) => operation.type === "createTable")
          .map((operation) => operation.table.name)
      ).toEqual(
        relationDdlBaseline[testCase.id]?.postgres?.tables.map(
          (table) => table.name
        )
      );
      expect((await push(client, { force: true })).operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });
});
