/**
 * The shared scalar family, and the two things sharing could have broken.
 *
 * `src/validation/scalars/family.ts` is the single owner of the shapes eight
 * kinds used to spell for themselves: the ordered comparison filter, the list
 * filter, the arithmetic and set-only update bags, the list update bag, and the
 * interned pay-per-use tail. The per-kind suites next to this file assert what
 * each kind's schemas MEAN, and `scalar-shape-census.core.test.ts` asserts that
 * every tree is still the exact tree it was. Neither can see the failure a
 * shared owner makes possible, which is what this file owns:
 *
 *  1. `scalarInternKey` spells only the FLAG BITS — nullable, array,
 *     withTimezone, and a string's identifier domain. It carries no kind. Two
 *     kinds sharing one intern cache would therefore hand an `s.number()` field
 *     the validator built for an `s.int()` field, and every shape assertion in
 *     the estate would still pass: the trees are structurally identical and
 *     differ only in which values they admit. `createScalarInterners()` mints a
 *     private pair per module, and that is the whole defence.
 *  2. A family factory closes over ONE kind's member and list schemas. Handed
 *     the wrong pair it would still produce the right shape, so the pin has to
 *     be a value the other kind admits and this one must not.
 */

import { s } from "@schema";
import type { ScalarState } from "@schema/scalars/common";
import { parse, type VibSchema } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, test } from "vitest";

type OperationSchemas = {
  base: VibSchema;
  create: VibSchema;
  update: VibSchema;
  filter: VibSchema;
};

const schemasOf = (state: ScalarState): OperationSchemas =>
  getScalarSchemas(state) as unknown as OperationSchemas;

/** One fresh field per call: interning, not memoization, is what is measured. */
const interned: Record<string, () => ScalarState> = {
  int: () => s.int()["~"].state,
  number: () => s.number()["~"].state,
  bigInt: () => s.bigInt()["~"].state,
  string: () => s.string()["~"].state,
  boolean: () => s.boolean()["~"].state,
  date: () => s.date()["~"].state,
  time: () => s.time()["~"].state,
  dateTime: () => s.dateTime()["~"].state,
};

describe("every kind owns its intern caches", () => {
  test("a kind shares one filter and one update across fields", () => {
    for (const [kind, state] of Object.entries(interned)) {
      expect(schemasOf(state()).filter, kind).toBe(schemasOf(state()).filter);
      expect(schemasOf(state()).update, kind).toBe(schemasOf(state()).update);
    }
  });

  test("no two kinds share one, though their keys are equal", () => {
    const names = Object.keys(interned);
    for (const name of names) {
      for (const other of names) {
        if (name === other) continue;
        const build = interned[name];
        const buildOther = interned[other];
        if (!(build && buildOther)) throw new Error("Missing census kind");
        expect(schemasOf(build()).filter).not.toBe(
          schemasOf(buildOther()).filter
        );
        expect(schemasOf(build()).update).not.toBe(
          schemasOf(buildOther()).update
        );
      }
    }
  });

  test("the filter cache and the update cache are two caches", () => {
    for (const [kind, state] of Object.entries(interned)) {
      expect(schemasOf(state()).filter, kind).not.toBe(
        schemasOf(state()).update
      );
    }
  });

  test("the flag bits still separate shapes within one kind", () => {
    const plain = schemasOf(s.int()["~"].state).filter;
    expect(schemasOf(s.int().nullable()["~"].state).filter).not.toBe(plain);
    expect(schemasOf(s.int().array()["~"].state).filter).not.toBe(plain);
  });

  test("the four variants are enumerated in one order", () => {
    for (const [kind, state] of Object.entries(interned)) {
      expect(Object.keys(schemasOf(state())), kind).toEqual([
        "base",
        "create",
        "update",
        "filter",
      ]);
    }
  });
});

describe("a family factory holds its own kind's operands", () => {
  test("an int filter refuses what only a number admits", () => {
    const int = schemasOf(s.int()["~"].state);
    expect(parse(int.filter, { gte: 1.5 }).issues).toBeDefined();
    expect(parse(int.update, { increment: 1.5 }).issues).toBeDefined();
    expect(parse(int.filter, { in: [1.5] }).issues).toBeDefined();
    expect(
      parse(schemasOf(s.number()["~"].state).filter, { gte: 1.5 }).issues
    ).toBeUndefined();
  });

  test("a date filter refuses what only a dateTime admits, and back", () => {
    const instant = "2024-01-15T10:30:00.000Z";
    const day = "2024-01-15";
    expect(
      parse(schemasOf(s.date()["~"].state).filter, { gte: instant }).issues
    ).toBeDefined();
    expect(
      parse(schemasOf(s.dateTime()["~"].state).filter, { gte: day }).issues
    ).toBeDefined();
    expect(
      parse(schemasOf(s.time()["~"].state).filter, { gte: day }).issues
    ).toBeDefined();
  });

  test("a list family holds the same member as its scalar family", () => {
    expect(
      parse(schemasOf(s.int().array()["~"].state).filter, { has: 1.5 }).issues
    ).toBeDefined();
    expect(
      parse(schemasOf(s.date().array()["~"].state).update, {
        push: "2024-01-15T10:30:00.000Z",
      }).issues
    ).toBeDefined();
  });

  test("the set-only update refuses the arithmetic bag, and back", () => {
    expect(
      parse(schemasOf(s.date()["~"].state).update, { increment: 1 }).issues
    ).toBeDefined();
    expect(
      parse(schemasOf(s.boolean()["~"].state).update, { increment: 1 }).issues
    ).toBeDefined();
    expect(
      parse(schemasOf(s.int()["~"].state).update, { increment: 1 }).issues
    ).toBeUndefined();
  });
});
