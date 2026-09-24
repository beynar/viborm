/**
 * Date Scalar Schema Runtime Tests
 *
 * `s.date()` is a CALENDAR DAY: no clock, no zone, and therefore no instant.
 * It is one of the two kinds that had no per-kind suite of its own — the
 * datetime file owned four cases at its foot, and the cross-kind shape census
 * owned the rest — which is exactly the coverage the builder consolidation
 * (footprint workstream 2) rewrote. This file gives the kind its own runtime
 * contract: what each of its four variants admits and what it refuses.
 *
 * Its three operation schemas are built by the shared family in
 * `src/validation/scalars/family.ts`. That is why the refusals below matter as
 * much as the acceptances: a family handed the wrong member schema would still
 * produce the right SHAPE, and only a value the other kind admits shows it.
 */

import { date } from "@schema/scalars/datetime/date-scalar";
import { parse } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, test } from "vitest";

const day = "2024-01-15";
const laterDay = "2024-06-20";

const plain = getScalarSchemas(date()["~"].state);
const nullableDay = getScalarSchemas(date().nullable()["~"].state);
const list = getScalarSchemas(date().array()["~"].state);

describe("date create", () => {
  test("admits a calendar day", () => {
    expect(parse(plain.create, day)).toEqual({ value: day });
  });

  test("refuses a timestamp, which names an instant a day does not", () => {
    expect(
      parse(plain.create, "2024-01-15T00:00:00.000Z").issues
    ).toBeDefined();
  });

  test("refuses a clock time", () => {
    expect(parse(plain.create, "10:30:00.000").issues).toBeDefined();
  });

  test("refuses a day that no calendar has", () => {
    expect(parse(plain.create, "2024-02-30").issues).toBeDefined();
  });

  test("refuses a non-ISO spelling", () => {
    expect(parse(plain.create, "2024/01/15").issues).toBeDefined();
  });
});

describe("date update", () => {
  test("a bare day is the shorthand for `set`", () => {
    expect(parse(plain.update, day)).toEqual({ value: { set: day } });
  });

  test("admits the explicit `set`", () => {
    expect(parse(plain.update, { set: day })).toEqual({
      value: { set: day },
    });
  });

  test("refuses a bag that names no value", () => {
    expect(parse(plain.update, {}).issues).toBeDefined();
  });

  test("refuses arithmetic: a day is not a number", () => {
    expect(parse(plain.update, { increment: 1 }).issues).toBeDefined();
  });

  test("refuses a value outside the day domain", () => {
    expect(
      parse(plain.update, { set: "2024-01-15T00:00:00.000Z" }).issues
    ).toBeDefined();
  });
});

describe("date filter", () => {
  test("a bare day is the shorthand for `equals`", () => {
    expect(parse(plain.filter, day)).toEqual({ value: { equals: day } });
  });

  test("admits the ordered comparisons: days sort as text", () => {
    expect(parse(plain.filter, { gte: day, lt: laterDay })).toEqual({
      value: { gte: day, lt: laterDay },
    });
  });

  test("admits set membership", () => {
    expect(parse(plain.filter, { in: [day, laterDay] })).toEqual({
      value: { in: [day, laterDay] },
    });
  });

  test("refuses a timestamp in `in`, not only in `equals`", () => {
    expect(
      parse(plain.filter, { in: ["2024-01-15T00:00:00.000Z"] }).issues
    ).toBeDefined();
  });

  test("refuses a timestamp as an ordered operand", () => {
    expect(
      parse(plain.filter, { gte: "2024-01-15T00:00:00.000Z" }).issues
    ).toBeDefined();
  });

  test("refuses the text predicates a string column has", () => {
    expect(parse(plain.filter, { contains: "01" }).issues).toBeDefined();
  });

  test("`not` takes a whole filter at any depth", () => {
    expect(parse(plain.filter, { not: { not: { gte: day } } })).toEqual({
      value: { not: { not: { gte: day } } },
    });
  });
});

describe("nullable date", () => {
  test("a bare null is the shorthand for `equals: null`", () => {
    expect(parse(nullableDay.filter, null)).toEqual({
      value: { equals: null },
    });
  });

  test("a bare null is the shorthand for `set: null`", () => {
    expect(parse(nullableDay.update, null)).toEqual({ value: { set: null } });
  });

  test("refuses null as a SET member: no row is ever in it", () => {
    expect(parse(nullableDay.filter, { in: [null] }).issues).toBeDefined();
  });

  test("refuses null as an ordered operand", () => {
    expect(parse(nullableDay.filter, { lt: null }).issues).toBeDefined();
  });
});

describe("date list", () => {
  test("create takes the whole list", () => {
    expect(parse(list.create, [day, laterDay])).toEqual({
      value: [day, laterDay],
    });
  });

  test("`push` normalizes one day to a list", () => {
    expect(parse(list.update, { push: day })).toEqual({
      value: { push: [day] },
    });
  });

  test("`unshift` normalizes one day to a list", () => {
    expect(parse(list.update, { unshift: day })).toEqual({
      value: { unshift: [day] },
    });
  });

  test("`push` also takes a list", () => {
    expect(parse(list.update, { push: [day, laterDay] })).toEqual({
      value: { push: [day, laterDay] },
    });
  });

  test("`push` refuses a member outside the day domain", () => {
    expect(
      parse(list.update, { push: "2024-01-15T00:00:00.000Z" }).issues
    ).toBeDefined();
  });

  test("admits the membership operators", () => {
    expect(parse(list.filter, { has: day })).toEqual({ value: { has: day } });
    expect(parse(list.filter, { hasEvery: [day] })).toEqual({
      value: { hasEvery: [day] },
    });
    expect(parse(list.filter, { hasSome: [day] })).toEqual({
      value: { hasSome: [day] },
    });
    expect(parse(list.filter, { isEmpty: true })).toEqual({
      value: { isEmpty: true },
    });
  });

  test("`has` refuses a member outside the day domain", () => {
    expect(
      parse(list.filter, { has: "2024-01-15T00:00:00.000Z" }).issues
    ).toBeDefined();
  });

  test("a list has no ordered comparison", () => {
    expect(parse(list.filter, { gte: day }).issues).toBeDefined();
  });
});
