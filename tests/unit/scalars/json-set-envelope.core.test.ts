/**
 * The JSON `{ set: v }` envelope means "store v" on EVERY write path (plan §6
 * decision 5, engine-05 / types-06).
 *
 * Until 1.2.0 only the update schema read a one-key `{ set }` object as an
 * envelope; create stored it literally, so the same payload stored different
 * documents on the two arms of one upsert and a read-modify-write that copied a
 * row through `{ set: row.meta }` changed it. These witnesses pin the per-field
 * create and update schemas to the SAME stored value for every payload — the
 * model-level paths (create, createMany, upsert, nested creates) all reach a
 * field through these two schemas, and the driver contract
 * `nested-write-json-envelope-behavior.ts` pins them end to end.
 */

import { JsonNull } from "@schema/json-null";
import type { ScalarState } from "@schema/scalars/common";
import { json } from "@schema/scalars/json/scalar";
import { type InferInput, parse } from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import { number, object } from "valibot";
import { describe, expect, expectTypeOf, test } from "vitest";

type CreateInput<State extends ScalarState<"json">> = InferInput<
  GetScalarSchemas<State>["create"]
>;

/** What a create stores, and what an update's `{ set }` stores, for `input`. */
const stored = (
  schemas: {
    create: Parameters<typeof parse>[0];
    update: Parameters<typeof parse>[0];
  },
  input: unknown
) => {
  const create = parse(schemas.create, input);
  const update = parse(schemas.update, input);
  return {
    create: create.issues ? "refused" : create.value,
    update: update.issues ? "refused" : (update.value as { set: unknown }).set,
  };
};

describe("untyped JSON", () => {
  const schemas = getScalarSchemas(json().nullable()["~"].state);

  test.each([
    ["a one-key envelope", { set: ["a", "b"] }, ["a", "b"]],
    ["an envelope around a scalar", { set: 1 }, 1],
    ["the escape for a one-key set document", { set: { set: 7 } }, { set: 7 }],
    ["an envelope around JsonNull", { set: JsonNull }, JsonNull],
    ["a bare document", { a: 1 }, { a: 1 }],
    ["a set key beside another key", { set: 1, b: 2 }, { set: 1, b: 2 }],
  ])("create and update store the same value for %s", (_label, input, expected) => {
    expect(stored(schemas, input)).toEqual({
      create: expected,
      update: expected,
    });
  });

  test("the envelope unwraps once: a stored one-key document copies verbatim through { set: doc }", () => {
    const row = parse(schemas.create, { set: { set: 7 } });
    if (row.issues) throw new Error(row.issues[0]?.message);
    expect(stored(schemas, { set: row.value })).toEqual({
      create: { set: 7 },
      update: { set: 7 },
    });
  });

  test("an invalid envelope value is refused on create, never stored literally", () => {
    expect(stored(schemas, { set: null })).toEqual({
      create: "refused",
      update: "refused",
    });
  });
});

describe("typed JSON (.schema())", () => {
  const scalar = json().schema(object({ v: number() }));
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

  test("the envelope's value is validated against the declared schema on create", () => {
    expect(stored(schemas, { set: { v: 5 } })).toEqual({
      create: { v: 5 },
      update: { v: 5 },
    });
    expect(stored(schemas, { set: { v: "x" } })).toEqual({
      create: "refused",
      update: "refused",
    });
  });

  test("a refused envelope value is reported under `set` on create, as on update", () => {
    const create = parse(schemas.create, { set: { v: "x" } }).issues?.[0];
    const update = parse(schemas.update, { set: { v: "x" } }).issues?.[0];
    expect(create?.path?.[0]).toBe("set");
    expect(create?.path).toEqual(update?.path);
  });

  test("type: create accepts the envelope around the typed document, as update does", () => {
    type Create = CreateInput<State>;
    expectTypeOf<{ v: number }>().toExtend<Create>();
    expectTypeOf<{ set: { v: number } }>().toExtend<Create>();
    expectTypeOf<{ set: { v: string } }>().not.toExtend<Create>();
  });
});
