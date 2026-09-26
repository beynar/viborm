/**
 * `_count` and `_distance` are reserved member names (owner rulings,
 * 2026-09-26: "_count is a reserved word", "_distance is reserved too").
 *
 * In `select` and `include`, `_count` is the relation-count projection, and
 * `_distance` is the key a selected point or vector distance publishes under.
 * A model member of either name — scalar, relation or variant slot — is
 * refused where a schema is validated, with one sentence parameterised by the
 * name (F010), so admission, the engine's projection, the schema-only renderer
 * and the static types each read the key with one meaning. The COLUMN names
 * stay available: a renamed scalar keeps either with `.map(...)`. Runtime
 * cells: `_count` in the relation read/aggregate behavior
 * (`tests/contracts/drivers/behaviors/relation-read-aggregate-behavior.ts`,
 * run on sqlite3, PGlite, pg, postgres.js and mysql2 — libsql's registration
 * is an unconditional `describe.skip`), `_distance` in the GeoPoint behavior
 * (`tests/contracts/drivers/behaviors/geopoint-behavior.ts`, the full tier
 * where a distance runs, the column alone on every tier). Static pins:
 * `tests/types/client/count-reserved-member.core.types.ts`. The file keeps its
 * `_count` name: both words are one rule and one refusal table, and the path
 * is the one the guard ledger and the scoping record cite.
 */

import { createClient } from "@client/client";
import {
  renderOperationResultType,
  validateOperationPayload,
} from "@client/schema-introspection";
import { VibORMErrorCode } from "@errors";
import { s } from "@schema";
import {
  SchemaValidationError,
  validateSchema,
  validateSchemaOrThrow,
} from "@schema/validation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

const RESERVED_FOR = {
  _count: "relation counts",
  _distance: "distance results",
} as const;

const reservedIssue = (model: string, reserved: keyof typeof RESERVED_FOR) => ({
  code: "F010",
  message: `Model '${model}' declares a member named '${reserved}'; '${reserved}' is reserved for ${RESERVED_FOR[reserved]}. Rename it, and use .map("${reserved}") on a renamed scalar to keep its column name.`,
  severity: "error",
  model,
  field: reserved,
});

// A scalar named `_count` beside a to-many relation.
const scalarHolder = s.model({
  id: s.string().id(),
  // @ts-expect-error `_count` is a reserved member name: `s.model` refuses it at compile time too; F010 is the runtime pin here.
  _count: s.int(),
  things: s.toMany(() => scalarThing),
});
const scalarThing = s.model({
  id: s.string().id(),
  holderId: s.string(),
  holder: s
    .toOne(() => scalarHolder)
    .fields("holderId")
    .references("id"),
});

// A to-many relation named `_count`.
const relationHolder = s.model({
  id: s.string().id(),
  // @ts-expect-error `_count` is a reserved member name: `s.model` refuses it at compile time too; F010 is the runtime pin here.
  _count: s.toMany(() => relationThing),
});
const relationThing = s.model({
  id: s.string().id(),
  holderId: s.string(),
  holder: s
    .toOne(() => relationHolder)
    .fields("holderId")
    .references("id"),
});

// A variant slot named `_count`.
const article = s.model({ id: s.string().id(), title: s.string() });
const clip = s.model({ id: s.string().id(), seconds: s.int() });
const slotHolder = s.model({
  id: s.string().id(),
  // @ts-expect-error `_count` is a reserved member name: `s.model` refuses it at compile time too; F010 is the runtime pin here.
  _count: s.toOne({ article: () => article, clip: () => clip }),
});

// The same three members named `_distance`, on a model that owns a point.
const distanceScalarHolder = s.model({
  id: s.string().id(),
  at: s.point(),
  // @ts-expect-error `_distance` is a reserved member name: `s.model` refuses it at compile time too; F010 is the runtime pin here.
  _distance: s.number(),
});
const distanceRelationHolder = s.model({
  id: s.string().id(),
  at: s.point(),
  // @ts-expect-error `_distance` is a reserved member name: `s.model` refuses it at compile time too; F010 is the runtime pin here.
  _distance: s.toMany(() => distanceRelationThing),
});
const distanceRelationThing = s.model({
  id: s.string().id(),
  holderId: s.string(),
  holder: s
    .toOne(() => distanceRelationHolder)
    .fields("holderId")
    .references("id"),
});
const distanceSlotHolder = s.model({
  id: s.string().id(),
  at: s.point(),
  // @ts-expect-error `_distance` is a reserved member name: `s.model` refuses it at compile time too; F010 is the runtime pin here.
  _distance: s.toOne({ article: () => article, clip: () => clip }),
});

const refusedSchemas = [
  ["a scalar", "_count", "scalarHolder", { scalarHolder, scalarThing }],
  ["a relation", "_count", "relationHolder", { relationHolder, relationThing }],
  ["a variant slot", "_count", "slotHolder", { slotHolder, article, clip }],
  ["a scalar", "_distance", "distanceScalarHolder", { distanceScalarHolder }],
  [
    "a relation",
    "_distance",
    "distanceRelationHolder",
    { distanceRelationHolder, distanceRelationThing },
  ],
  [
    "a variant slot",
    "_distance",
    "distanceSlotHolder",
    { distanceSlotHolder, article, clip },
  ],
] as const;

// The remedy: a differently-named member mapped to the `_count` column.
const ledger = s.model({
  id: s.string().id(),
  tally: s.int().map("_count"),
  entries: s.toMany(() => entry),
});
const entry = s.model({
  id: s.string().id(),
  ledgerId: s.string(),
  ledger: s
    .toOne(() => ledger)
    .fields("ledgerId")
    .references("id"),
});
const ledgerSchema = { ledger, entry };

// The remedy for `_distance`: a differently-named member in the `_distance`
// column, on a model whose point selects a distance.
const landmark = s.model({
  id: s.string().id(),
  at: s.point(),
  score: s.number().map("_distance"),
});
const landmarkSchema = { landmark };
const paris = { longitude: 2.3522, latitude: 48.8566 };

const ADMITTED_COUNTS = { select: { entries: true } };

/**
 * MySQL's adapter carries the GeoPoint protocol, so construction of a model
 * that owns a point reaches the schema gate instead of stopping at the
 * provider tier (PostgreSQL without PostGIS has none).
 */
const planning = () => new PlanningDriver("mysql");

function captureConstructionFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("`_count` and `_distance` are reserved member names", () => {
  test.each(
    refusedSchemas
  )("schema validation refuses %s named %s", (_kind, reserved, model, schema) => {
    expect(validateSchema(schema).errors).toEqual([
      reservedIssue(model, reserved),
    ]);
    expect(() => validateSchemaOrThrow(schema)).toThrow(
      reservedIssue(model, reserved).message
    );
  });

  test.each(
    refusedSchemas
  )("client construction refuses %s named %s", (_kind, reserved, model, schema) => {
    const failure = captureConstructionFailure(() =>
      createClient({ schema, driver: planning() })
    );

    expect(failure).toBeInstanceOf(SchemaValidationError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      issues: [reservedIssue(model, reserved)],
    });
  });

  test("a model declaring both names meets one issue per name", () => {
    const both = s.model({
      id: s.string().id(),
      at: s.point(),
      // @ts-expect-error `_count` is a reserved member name.
      _count: s.int(),
      // @ts-expect-error `_distance` is a reserved member name.
      _distance: s.number(),
    });
    expect(validateSchema({ both }).errors).toEqual([
      reservedIssue("both", "_count"),
      reservedIssue("both", "_distance"),
    ]);
  });

  test.each([
    ["_count", ledgerSchema],
    ["_distance", landmarkSchema],
  ] as const)("a member mapped to the `%s` column is admitted", (_column, schema) => {
    expect(validateSchema(schema)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    expect(() => createClient({ schema, driver: planning() })).not.toThrow();
  });

  test("admission and the renderer read `_count` as the counts beside the mapped member", () => {
    const selected = { select: { id: true, tally: true, _count: true } };
    const included = { include: { _count: true } };
    const counts = `Array<{
  id: string;
  tally: number;
  _count: {
    entries: number;
  };
}>`;

    expect(
      validateOperationPayload(ledgerSchema, "ledger", "findMany", selected)
    ).toEqual({ select: { id: true, tally: true, _count: ADMITTED_COUNTS } });
    expect(
      validateOperationPayload(ledgerSchema, "ledger", "findMany", included)
    ).toEqual({ include: { _count: ADMITTED_COUNTS } });
    expect(
      renderOperationResultType(ledgerSchema, "ledger", "findMany", selected)
    ).toBe(counts);
    expect(
      renderOperationResultType(ledgerSchema, "ledger", "findMany", included)
    ).toBe(counts);
  });

  test("admission and the renderer read `_distance` as the distance beside the mapped member", () => {
    const selected = {
      select: { id: true, score: true, at: { _distance: { to: paris } } },
    };

    expect(
      validateOperationPayload(landmarkSchema, "landmark", "findMany", selected)
    ).toEqual(selected);
    expect(
      renderOperationResultType(
        landmarkSchema,
        "landmark",
        "findMany",
        selected
      )
    ).toBe(`Array<{
  id: string;
  score: number;
  _distance: number;
}>`);
  });
});
