/**
 * The exactness harness for the scalar operation-schema builders.
 *
 * `_scalar-shape-census.ts` records what the thirteen per-kind builders
 * produce today, tree by tree. This suite is what makes that record a
 * CONTRACT: the consolidation of those builders into one parameterized family
 * plus a per-kind descriptor (footprint workstream 2) is behavior-preserving
 * exactly when this census, the shorthand admission below, and the recursive
 * `not` arm all still hold.
 *
 * The per-kind suites next to this file already assert what each shape MEANS.
 * Nothing here duplicates them: this one owns the cross-kind statement — that
 * every kind's tree is the one recorded, down to entry order and operand kind.
 */

import type { ScalarState } from "@schema/scalars/common";
import { parse, type VibSchema } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, test } from "vitest";
import {
  buildScalarShapeCensus,
  EXPECTED_SCALAR_SHAPE_CENSUS,
  scalarShapeCases,
} from "./_scalar-shape-census";

type ScalarOperationSchemas = {
  base: VibSchema;
  create: VibSchema;
  update: VibSchema;
  filter: VibSchema;
};

const schemasOf = (state: ScalarState): ScalarOperationSchemas =>
  getScalarSchemas(state) as unknown as ScalarOperationSchemas;

describe("scalar operation-schema shape census", () => {
  test("every kind builds exactly the recorded tree", () => {
    expect(buildScalarShapeCensus()).toEqual(EXPECTED_SCALAR_SHAPE_CENSUS);
  });

  test("a bare value is the shorthand for `equals` and for `set`", () => {
    // The validated OUTPUT, not the input: a bigint renders as text and a
    // decimal as its canonical private text, and the shorthand must hand the
    // operand exactly what the long form would.
    const samples: Record<string, { input: unknown; output: unknown }> = {
      int: { input: 1, output: 1 },
      string: { input: "x", output: "x" },
      boolean: { input: true, output: true },
      enum: { input: "a", output: "a" },
      bigInt: { input: 10n, output: "10" },
      dateTime: {
        input: "2024-01-02T03:04:05.000Z",
        output: "2024-01-02T03:04:05.000Z",
      },
      decimal: { input: "1.25", output: "1.25" },
    };
    const states = scalarShapeCases();

    for (const [name, sample] of Object.entries(samples)) {
      const state = states[name];
      if (!state) throw new Error(`No census case named ${name}`);
      const schemas = schemasOf(state);
      expect(parse(schemas.filter, sample.input)).toEqual({
        value: { equals: sample.output },
      });
      expect(parse(schemas.update, sample.input)).toEqual({
        value: { set: sample.output },
      });
    }
  });

  test("`not` takes a whole filter at any depth", () => {
    const states = scalarShapeCases();
    const state = states.string;
    if (!state) throw new Error("No census case named string");
    const { filter } = schemasOf(state);

    expect(parse(filter, { not: { not: { not: { contains: "z" } } } })).toEqual(
      {
        value: { not: { not: { not: { contains: "z" } } } },
      }
    );
  });

  test("JSON keeps its own language: a filter object, no shorthand arm", () => {
    const states = scalarShapeCases();
    const state = states.json;
    if (!state) throw new Error("No census case named json");
    const { filter } = schemasOf(state);

    expect(parse(filter, { equals: { a: 1 } })).toEqual({
      value: { equals: { a: 1 } },
    });
  });
});
