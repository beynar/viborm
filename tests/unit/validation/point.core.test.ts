import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { type GeoPoint, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("GeoPoint validation boundary", () => {
  const schema = v.point();

  test("uses the exact public value and returns a canonical fresh object", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<GeoPoint>();

    const input = { longitude: -180, latitude: -0 };
    const result = parse(schema, input);
    if (result.issues) throw new Error("Expected success");
    expect(result.value).toEqual({ longitude: 180, latitude: 0 });
    expect(result.value).not.toBe(input);
  });

  test.each([
    { longitude: 180, latitude: 90 },
    { longitude: 180, latitude: -90 },
    { longitude: 0, latitude: 0 },
  ])("accepts the portable coordinate boundary %#", (point) => {
    expect(parse(schema, point).issues).toBeUndefined();
  });

  test.each([
    null,
    undefined,
    [1, 2],
    "POINT(1 2)",
    { type: "Point", coordinates: [1, 2] },
    { longitude: 0 },
    { latitude: 0 },
    { longitude: 0, latitude: 0, altitude: 1 },
    { longitude: Number.NaN, latitude: 0 },
    { longitude: Number.POSITIVE_INFINITY, latitude: 0 },
    { longitude: 181, latitude: 0 },
    { longitude: 0, latitude: "48" },
    { longitude: 0, latitude: Number.NaN },
    { longitude: 0, latitude: -91 },
  ])("refuses values outside the one point language %#", (value) => {
    expect(parse(schema, value).issues).toBeDefined();
  });

  test("reads the point as an ordinary record: string keys, own or inherited", () => {
    // The record walker owns key reading for every object operand. It sees
    // enumerable string keys, inherited ones included, and never symbols.
    expect(
      parse(schema, { longitude: 1, latitude: 2, [Symbol("altitude")]: 3 })
    ).toEqual({ value: { longitude: 1, latitude: 2 } });
    expect(
      parse(
        schema,
        Object.assign(Object.create({ longitude: 1 }), { latitude: 2 })
      )
    ).toEqual({ value: { longitude: 1, latitude: 2 } });
  });

  test("names the offending key of a misspelled or incomplete point", () => {
    expect(
      parse(schema, { longitude: 2, latitude: 48, latitdue: 48 }).issues
    ).toEqual([{ message: "Unknown key: latitdue", path: ["latitdue"] }]);
    expect(parse(schema, { longitude: 2 }).issues).toEqual([
      { message: "Missing required field: latitude", path: ["latitude"] },
    ]);
    expect(
      parse(schema, { longitude: Number.NaN, latitude: 0 }).issues
    ).toEqual([{ message: "Expected finite number", path: ["longitude"] }]);
    expect(parse(schema, { longitude: 181, latitude: 0 }).issues).toEqual([
      {
        message: "Longitude must be between -180 and 180",
        path: ["longitude"],
      },
    ]);
  });

  test("reads each coordinate accessor exactly once", () => {
    let longitudeReads = 0;
    let latitudeReads = 0;
    const value = Object.defineProperties(
      {},
      {
        longitude: {
          enumerable: true,
          get() {
            longitudeReads += 1;
            return 2;
          },
        },
        latitude: {
          enumerable: true,
          get() {
            latitudeReads += 1;
            return 48;
          },
        },
      }
    );
    expect(parse(schema, value)).toEqual({
      value: { longitude: 2, latitude: 48 },
    });
    expect({ longitudeReads, latitudeReads }).toEqual({
      longitudeReads: 1,
      latitudeReads: 1,
    });
  });

  test("contains hostile reflection and property failures", () => {
    const ownKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      }
    );
    const getter = Object.defineProperties(
      {},
      {
        longitude: {
          enumerable: true,
          get() {
            throw new Error("getter trap");
          },
        },
        latitude: { enumerable: true, value: 0 },
      }
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const value of [ownKeys, getter, revoked.proxy]) {
      expect(() => parse(schema, value)).not.toThrow();
      expect(parse(schema, value).issues).toBeDefined();
    }
  });

  test("refuses a coordinate removed while the point is read", () => {
    const value = Object.defineProperties(
      {},
      {
        longitude: {
          enumerable: true,
          get() {
            Reflect.deleteProperty(value, "latitude");
            return 2;
          },
        },
        latitude: {
          configurable: true,
          enumerable: true,
          value: 48,
        },
      }
    );

    expect(parse(schema, value).issues).toEqual([
      { message: "Missing required field: latitude", path: ["latitude"] },
    ]);
  });

  test("retains validation-library optional, nullable, and array composition", () => {
    expect(
      parse(v.point({ optional: true }), undefined).issues
    ).toBeUndefined();
    expect(parse(v.point({ nullable: true }), null).issues).toBeUndefined();
    expect(
      parse(v.point({ array: true }), [
        { longitude: 1, latitude: 2 },
        { longitude: 3, latitude: 4 },
      ]).issues
    ).toBeUndefined();
  });
});
