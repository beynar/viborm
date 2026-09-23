/**
 * Time Scalar Schema Runtime Tests
 *
 * `s.time()` is a CLOCK READING: no date, no zone, and therefore no instant.
 * Like `s.date()` it had no per-kind suite of its own before the scalar builder
 * consolidation (footprint workstream 2) rewrote its module, so this file gives
 * the kind its own runtime contract.
 *
 * Its three operation schemas come from the shared family in
 * `src/validation/scalars/family.ts`, which is why the refusals below carry the
 * weight: a family handed the wrong member schema still produces the right
 * SHAPE, and only a value another kind admits exposes it.
 */

import { time } from "@schema/scalars/datetime";
import { parse } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, test } from "vitest";

const morning = "10:30:00.000";
const evening = "21:45:30.500";

const plain = getScalarSchemas(time()["~"].state);
const nullableTime = getScalarSchemas(time().nullable()["~"].state);
const list = getScalarSchemas(time().array()["~"].state);

describe("time create", () => {
  test("admits a clock reading", () => {
    expect(parse(plain.create, morning)).toEqual({ value: morning });
  });

  test("refuses a timestamp, which names an instant a clock does not", () => {
    expect(
      parse(plain.create, "2024-01-15T10:30:00.000Z").issues
    ).toBeDefined();
  });

  test("refuses a calendar day", () => {
    expect(parse(plain.create, "2024-01-15").issues).toBeDefined();
  });

  test("refuses an hour no clock shows", () => {
    expect(parse(plain.create, "24:00:00.000").issues).toBeDefined();
  });

  test("refuses a sixtieth minute", () => {
    expect(parse(plain.create, "10:60:00.000").issues).toBeDefined();
  });
});

describe("time update", () => {
  test("a bare reading is the shorthand for `set`", () => {
    expect(parse(plain.update, morning)).toEqual({ value: { set: morning } });
  });

  test("admits the explicit `set`", () => {
    expect(parse(plain.update, { set: morning })).toEqual({
      value: { set: morning },
    });
  });

  test("refuses a bag that names no value", () => {
    expect(parse(plain.update, {}).issues).toBeDefined();
  });

  test("refuses arithmetic: a clock reading is not a number", () => {
    expect(parse(plain.update, { increment: 1 }).issues).toBeDefined();
  });
});

describe("time filter", () => {
  test("a bare reading is the shorthand for `equals`", () => {
    expect(parse(plain.filter, morning)).toEqual({
      value: { equals: morning },
    });
  });

  test("admits the ordered comparisons: readings sort as text", () => {
    expect(parse(plain.filter, { gte: morning, lt: evening })).toEqual({
      value: { gte: morning, lt: evening },
    });
  });

  test("admits set membership", () => {
    expect(parse(plain.filter, { in: [morning, evening] })).toEqual({
      value: { in: [morning, evening] },
    });
  });

  test("refuses a timestamp in `in`, not only in `equals`", () => {
    expect(
      parse(plain.filter, { in: ["2024-01-15T10:30:00.000Z"] }).issues
    ).toBeDefined();
  });

  test("refuses a calendar day as an ordered operand", () => {
    expect(parse(plain.filter, { gte: "2024-01-15" }).issues).toBeDefined();
  });

  test("refuses the text predicates a string column has", () => {
    expect(parse(plain.filter, { startsWith: "10" }).issues).toBeDefined();
  });

  test("`not` takes a whole filter at any depth", () => {
    expect(parse(plain.filter, { not: { not: { gte: morning } } })).toEqual({
      value: { not: { not: { gte: morning } } },
    });
  });
});

describe("nullable time", () => {
  test("a bare null is the shorthand for `equals: null`", () => {
    expect(parse(nullableTime.filter, null)).toEqual({
      value: { equals: null },
    });
  });

  test("a bare null is the shorthand for `set: null`", () => {
    expect(parse(nullableTime.update, null)).toEqual({
      value: { set: null },
    });
  });

  test("refuses null as a SET member: no row is ever in it", () => {
    expect(parse(nullableTime.filter, { in: [null] }).issues).toBeDefined();
  });
});

describe("time list", () => {
  test("create takes the whole list", () => {
    expect(parse(list.create, [morning, evening])).toEqual({
      value: [morning, evening],
    });
  });

  test("`push` normalizes one reading to a list", () => {
    expect(parse(list.update, { push: morning })).toEqual({
      value: { push: [morning] },
    });
  });

  test("`unshift` normalizes one reading to a list", () => {
    expect(parse(list.update, { unshift: morning })).toEqual({
      value: { unshift: [morning] },
    });
  });

  test("`push` refuses a member outside the clock domain", () => {
    expect(parse(list.update, { push: "2024-01-15" }).issues).toBeDefined();
  });

  test("admits the membership operators", () => {
    expect(parse(list.filter, { has: morning })).toEqual({
      value: { has: morning },
    });
    expect(parse(list.filter, { hasEvery: [morning] })).toEqual({
      value: { hasEvery: [morning] },
    });
    expect(parse(list.filter, { hasSome: [morning] })).toEqual({
      value: { hasSome: [morning] },
    });
    expect(parse(list.filter, { isEmpty: false })).toEqual({
      value: { isEmpty: false },
    });
  });

  test("`has` refuses a member outside the clock domain", () => {
    expect(parse(list.filter, { has: "2024-01-15" }).issues).toBeDefined();
  });

  test("a list has no ordered comparison", () => {
    expect(parse(list.filter, { gte: morning }).issues).toBeDefined();
  });
});
