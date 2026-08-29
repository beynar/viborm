import type { ScalarState } from "@schema/scalars/common";
import { point } from "@schema/scalars/point/scalar";
import {
  type GeoArea,
  type GeoPoint,
  type InferInput,
  parse,
} from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import { describe, expect, expectTypeOf, test } from "vitest";

type InferPointInput<
  State extends ScalarState<"point">,
  Key extends keyof GetScalarSchemas<State>,
> = InferInput<GetScalarSchemas<State>[Key]>;

const paris: GeoPoint = { longitude: 2.3522, latitude: 48.8566 };

describe("GeoPoint scalar schemas", () => {
  const scalar = point();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

  test("refuses even an explicitly undefined runtime argument", () => {
    expect(() => Reflect.apply(point, undefined, [undefined])).toThrow(
      "s.point() takes no native type or options"
    );
  });

  test("base and create use the one GeoPoint value", () => {
    type Base = InferPointInput<State, "base">;
    type Create = InferPointInput<State, "create">;
    expectTypeOf<Base>().toEqualTypeOf<GeoPoint>();
    expectTypeOf<Create>().toEqualTypeOf<GeoPoint>();

    const parsed = parse(schemas.create, paris);
    if (parsed.issues) throw new Error("Expected a valid GeoPoint");
    expect(parsed.value).toEqual(paris);
    expect(parsed.value).not.toBe(paris);
    expect(parse(schemas.create, undefined).issues).toBeDefined();
    expect(parse(schemas.create, null).issues).toBeDefined();
  });

  test("update accepts shorthand and set while retaining canonical output", () => {
    type Update = InferPointInput<State, "update">;
    expectTypeOf<GeoPoint>().toExtend<Update>();
    expectTypeOf<{ set: GeoPoint }>().toExtend<Update>();

    expect(parse(schemas.update, paris)).toEqual({ value: { set: paris } });
    expect(parse(schemas.update, { set: paris })).toEqual({
      value: { set: paris },
    });
  });

  test("filter admits equality, distance, area membership, and recursive not", () => {
    type Filter = InferPointInput<State, "filter">;
    const bounds: GeoArea = {
      bounds: { south: 48, west: 1, north: 49, east: 3 },
    };
    expectTypeOf<GeoPoint>().toExtend<Filter>();
    expectTypeOf<{ equals: GeoPoint }>().toExtend<Filter>();
    expectTypeOf<{
      distance: { to: GeoPoint; gte: number; lte: number };
    }>().toExtend<Filter>();
    expectTypeOf<{ within: GeoArea }>().toExtend<Filter>();
    expectTypeOf<{ not: { within: GeoArea } }>().toExtend<Filter>();

    expect(parse(schemas.filter, paris)).toEqual({
      value: { equals: paris },
    });
    expect(
      parse(schemas.filter, {
        distance: { to: paris, gte: 5000, lte: 10_000 },
      })
    ).toEqual({
      value: { distance: { to: paris, gte: 5000, lte: 10_000 } },
    });
    expect(parse(schemas.filter, { within: bounds })).toEqual({
      value: { within: bounds },
    });
    expect(parse(schemas.filter, { not: { within: bounds } })).toEqual({
      value: { not: { within: bounds } },
    });
  });

  test("distance requires a target and one finite non-negative comparison", () => {
    for (const invalid of [
      { distance: { to: paris } },
      { distance: { lte: 10 } },
      { distance: { to: paris, lte: -1 } },
      { distance: { to: paris, lte: Number.POSITIVE_INFINITY } },
      { distance: { to: paris, equals: 10 } },
    ]) {
      expect(parse(schemas.filter, invalid).issues).toBeDefined();
    }
    for (const comparison of ["lt", "lte", "gt", "gte"] as const) {
      expect(
        parse(schemas.filter, {
          distance: { to: paris, [comparison]: 0 },
        }).issues
      ).toBeUndefined();
    }
  });

  test("retired spatial aliases stay absent", () => {
    type Filter = InferPointInput<State, "filter">;
    expectTypeOf<{ notWithin: GeoArea }>().not.toExtend<Filter>();
    expectTypeOf<{ notNear: GeoPoint }>().not.toExtend<Filter>();
    expectTypeOf<{ far: GeoPoint }>().not.toExtend<Filter>();
    expectTypeOf<{ between: [GeoPoint, GeoPoint] }>().not.toExtend<Filter>();
    expectTypeOf<{ intersects: GeoArea }>().not.toExtend<Filter>();

    expect(
      parse(schemas.filter, { notWithin: { bounds: {} } }).issues
    ).toBeDefined();
  });
});

describe("GeoPoint scalar modifiers", () => {
  test("nullable preserves GeoPoint and supplies null", () => {
    const scalar = point().nullable();
    type State = (typeof scalar)["~"]["state"];
    type Base = InferPointInput<State, "base">;
    type Create = InferPointInput<State, "create">;
    expectTypeOf<Base>().toEqualTypeOf<GeoPoint | null>();
    expectTypeOf<Create>().toEqualTypeOf<GeoPoint | null | undefined>();

    const schemas = getScalarSchemas(scalar["~"].state);
    expect(parse(schemas.create, undefined)).toEqual({ value: null });
    expect(parse(schemas.update, null)).toEqual({ value: { set: null } });
    expect(parse(schemas.filter, null)).toEqual({ value: { equals: null } });
    expect(
      parse(schemas.filter, { distance: { to: null, lte: 1 } }).issues
    ).toBeDefined();
    expect(
      parse(schemas.filter, { distance: { to: paris, lte: 1 } }).issues
    ).toBeUndefined();
  });

  test("literal defaults are canonicalized at declaration and detached", () => {
    const literal = { longitude: -180, latitude: -0 };
    const scalar = point().default(literal);
    expect(scalar["~"].state.default).toEqual({
      longitude: 180,
      latitude: 0,
    });
    expect(scalar["~"].state.default).not.toBe(literal);

    literal.longitude = 1;
    const schemas = getScalarSchemas(scalar["~"].state);
    expect(parse(schemas.create, undefined)).toEqual({
      value: { longitude: 180, latitude: 0 },
    });
  });

  test("function defaults cross the codec on each invocation", () => {
    let calls = 0;
    const scalar = point().default(() => ({
      longitude: -180,
      latitude: calls++ === 0 ? -0 : 10,
    }));
    const schemas = getScalarSchemas(scalar["~"].state);
    expect(parse(schemas.create, undefined)).toEqual({
      value: { longitude: 180, latitude: 0 },
    });
    expect(parse(schemas.create, undefined)).toEqual({
      value: { longitude: 180, latitude: 10 },
    });
  });

  test("invalid literal defaults fail at s.point().default", () => {
    expect(() => point().default({ longitude: 181, latitude: 0 })).toThrow(
      "Validation failed for s.point"
    );

    const scalar = point();
    expect(() => Reflect.apply(scalar.default, scalar, [null])).toThrow(
      "Expected GeoPoint object"
    );
  });

  test("map composes without adding a second point language", () => {
    const scalar = point().map("location").nullable().default(paris);
    expect(scalar["~"].state.columnName).toBe("location");
    expect(scalar["~"].state.nullable).toBe(true);
    expect(scalar["~"].state.hasDefault).toBe(true);
  });
});
