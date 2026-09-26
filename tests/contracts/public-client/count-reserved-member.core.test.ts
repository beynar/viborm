/**
 * `_count` is a reserved member name (owner ruling, 2026-09-26).
 *
 * In `select` and `include`, `_count` is the relation-count projection. A model
 * member of that name — scalar, relation or variant slot — is refused where a
 * schema is validated, with one sentence (F010), so admission, the engine's
 * projection, the schema-only renderer and the static types all read `_count`
 * as counts and nothing else. The COLUMN name stays available: a renamed
 * scalar keeps it with `.map("_count")`, and that spelling reaches the same
 * counts as any other model (runtime cells: the relation read/aggregate
 * behavior, `tests/contracts/drivers/behaviors/relation-read-aggregate-behavior.ts`,
 * run on sqlite3, PGlite, pg, postgres.js and mysql2 — libsql's registration is
 * an unconditional `describe.skip`; static pins:
 * `tests/types/client/count-reserved-member.core.types.ts`).
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

const reservedIssue = (model: string) => ({
  code: "F010",
  message: `Model '${model}' declares a member named '_count'; '_count' is reserved for relation counts. Rename it, and use .map("_count") on a renamed scalar to keep its column name.`,
  severity: "error",
  model,
  field: "_count",
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

const refusedSchemas = [
  ["a scalar", "scalarHolder", { scalarHolder, scalarThing }],
  ["a relation", "relationHolder", { relationHolder, relationThing }],
  ["a variant slot", "slotHolder", { slotHolder, article, clip }],
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

const ADMITTED_COUNTS = { select: { entries: true } };

function captureConstructionFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("`_count` is a reserved member name", () => {
  test.each(
    refusedSchemas
  )("schema validation refuses %s named `_count`", (_kind, model, schema) => {
    expect(validateSchema(schema).errors).toEqual([reservedIssue(model)]);
    expect(() => validateSchemaOrThrow(schema)).toThrow(
      reservedIssue(model).message
    );
  });

  test.each(
    refusedSchemas
  )("client construction refuses %s named `_count`", (_kind, model, schema) => {
    const failure = captureConstructionFailure(() =>
      createClient({ schema, driver: new PlanningDriver("postgresql") })
    );

    expect(failure).toBeInstanceOf(SchemaValidationError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      issues: [reservedIssue(model)],
    });
  });

  test("a member mapped to the `_count` column is admitted", () => {
    expect(validateSchema(ledgerSchema)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    expect(() =>
      createClient({
        schema: ledgerSchema,
        driver: new PlanningDriver("postgresql"),
      })
    ).not.toThrow();
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
});
