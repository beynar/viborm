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
import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
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
import { ddlContext } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const CREATE_TABLE_NAME =
  /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:(?:"[^"]+"|`[^`]+`|\w+)\.)?(?:"([^"]+)"|`([^`]+)`|(\w+))/i;

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
// JSON DOCUMENT ROUND TRIP (schema-json plan §4, T1)
// =============================================================================

/**
 * The semantic round-trip theorem. `parseSchema(serializeSchema(S))` and `S`
 * are the same schema, and the strongest available statement of that is this
 * file's own oracle: the round-tripped graph must produce the FROZEN artifact,
 * byte for byte, in every dialect the case pins — same columns, same order,
 * same constraints, same junction tables, same table positions.
 *
 * The document is written from a FRESH build, before hydration, because
 * serializing must not bind or settle anything (see the schema-json serializer).
 */
describe("relation → DDL preservation through a JSON document", () => {
  it.each(relationDdlCorpus)("$id survives parse ∘ serialize", (testCase) => {
    const document = serializeSchema(testCase.build());
    const roundTripped = parseSchema(document);
    hydrateSchemaNames(roundTripped);
    const result = validateSchema(roundTripped);
    if (result.valid) {
      validateSchemaOrThrow(roundTripped);
    }

    const expectedVerdict = testCase.intendedVerdict ?? testCase.headVerdict;
    expect(result.valid).toBe(expectedVerdict === "valid");

    for (const dialect of testCase.dialects) {
      const snapshot = serializeModels(roundTripped, {
        migrationDriver: migrationDrivers[dialect],
      });
      expect(snapshot).toEqual(relationDdlBaseline[testCase.id]?.[dialect]);
    }

    // T2 on the same corpus: the document a round trip writes is the one it
    // read, so the canonical form is a fixed point.
    expect(serializeSchema(roundTripped)).toEqual(document);
  });
});

// =============================================================================
// DEFAULTS THROUGH A JSON DOCUMENT — the DDL-visible half of T1
// =============================================================================

/**
 * A default's TYPE is a DDL fact, not just an application one.
 *
 * `getDefaultExpression` emits a SQL `DEFAULT` clause for a string and nothing
 * at all for an object, so a `Date` default and the ISO string that spells it
 * produce two DIFFERENT tables. A document that flattened one into the other
 * would round-trip a schema into a schema that migrates differently — which is
 * exactly what T1 forbids — so the codec keeps them apart and this is the
 * statement of what "apart" buys.
 */
describe("scalar defaults through a JSON document", () => {
  const AT = "2020-01-02T03:04:05.000Z";

  function createTable(schema: Record<string, AnyModel>): string {
    const snapshot = serializeModels(schema, {
      migrationDriver: sqlite3MigrationDriver,
    });
    const table = snapshot.tables[0];
    if (table === undefined) throw new Error("one table was serialized");
    return sqlite3MigrationDriver.generateDDL(
      { type: "createTable", table },
      ddlContext("artifact")
    );
  }

  const cases: [string, () => Record<string, AnyModel>, string][] = [
    [
      "a Date default stays an application default",
      () => ({
        row: s.model({
          id: s.string().id(),
          at: s.dateTime().default(new Date(AT)),
        }),
      }),
      '"at" TEXT NOT NULL',
    ],
    [
      "an ISO string default stays a SQL default",
      () => ({
        row: s.model({ id: s.string().id(), at: s.dateTime().default(AT) }),
      }),
      `"at" TEXT NOT NULL DEFAULT '${AT}'`,
    ],
    [
      "a bigint default survives as a bigint",
      () => ({
        row: s.model({ id: s.string().id(), n: s.bigInt().default(5n) }),
      }),
      '"n" INTEGER NOT NULL',
    ],
  ];

  it.each(cases)("%s", (_label, build, expected) => {
    const before = createTable(build());
    const after = createTable(parseSchema(serializeSchema(build())));
    expect(before).toContain(expected);
    expect(after).toBe(before);
  });
});

// =============================================================================
// LIVE CONVERGENCE — a second forced push planning ZERO operations is the
// strongest statement that the frozen snapshot and the database agree.
// =============================================================================

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
