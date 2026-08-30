import vm from "node:vm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

/** A Date built in another realm: same internal slot, failing `instanceof`. */
function foreignDate(source: string): Date {
  return vm.runInNewContext(`new Date(${source})`);
}

function successfulValue<const S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): StandardSchemaV1.InferOutput<S> {
  const result = parse(schema, input);
  if (result.issues) throw new Error("Expected success");
  return result.value;
}

/** An object that spells the Date surface without holding the slot. */
const DATE_IMPOSTOR = {
  [Symbol.toStringTag]: "Date",
  getTime: () => 1_702_636_200_000,
  toISOString: () => "2023-12-15T10:30:00.000Z",
};

describe("isoTimestamp schema", () => {
  describe("basic validation", () => {
    const schema = v.isoTimestamp();

    test("validates ISO timestamps", () => {
      const valid = "2023-12-15T10:30:00.000Z";
      const result = parse(schema, valid);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(valid);
    });

    test("validates timestamps with timezone offset", () => {
      const valid = "2023-12-15T10:30:00.000+05:00";
      const result = parse(schema, valid);
      expect(result.issues).toBeUndefined();
    });

    test("admits the full offset range when the represented instant stays in range", () => {
      expect(
        parse(schema, "0000-01-01T23:59:59.999+23:59").issues
      ).toBeUndefined();
      expect(
        parse(schema, "9999-12-31T00:00:00.000-23:59").issues
      ).toBeUndefined();
    });

    test("rejects invalid formats", () => {
      expect(parse(schema, "2023-12-15").issues).toBeDefined();
      expect(parse(schema, "not-a-date").issues).toBeDefined();
      expect(parse(schema, "2023-12-15T10:30:00").issues).toBeDefined();
    });

    test("rejects invalid dates", () => {
      expect(parse(schema, "2023-13-15T10:30:00.000Z").issues).toBeDefined();
      expect(parse(schema, "2023-12-32T10:30:00.000Z").issues).toBeDefined();
      expect(parse(schema, "2023-02-29T10:30:00.000Z").issues).toBeDefined();
      expect(parse(schema, "2023-04-31T10:30:00.000Z").issues).toBeDefined();
      expect(parse(schema, "2023-12-15T24:00:00.000Z").issues).toBeDefined();
      expect(parse(schema, "2024-02-29T23:59:59.999Z").issues).toBeUndefined();
      expect(parse(schema, "1900-02-29T00:00:00.000Z").issues).toBeDefined();
      expect(parse(schema, "2000-02-29T00:00:00.000Z").issues).toBeUndefined();
    });

    test("rejects an offset spelling whose represented instant leaves the four-digit range", () => {
      expect(
        parse(schema, "0000-01-01T00:00:00.000+23:59").issues
      ).toBeDefined();
      expect(
        parse(schema, "9999-12-31T23:59:59.999-23:59").issues
      ).toBeDefined();
    });

    test("normalizes Date values and rejects invalid or unrelated values", () => {
      expect(
        (
          parse(schema, new Date("2023-12-15T10:30:00.000Z")) as {
            value: string;
          }
        ).value
      ).toBe("2023-12-15T10:30:00.000Z");
      expect(parse(schema, new Date(Number.NaN)).issues).toBeDefined();
      expect(parse(schema, 1).issues).toBeDefined();
    });

    test("admits only Date instants in the four-digit UTC range", () => {
      const minimum = new Date(-62_167_219_200_000);
      const maximum = new Date(253_402_300_799_999);

      expect(successfulValue(schema, minimum)).toBe("0000-01-01T00:00:00.000Z");
      expect(successfulValue(schema, maximum)).toBe("9999-12-31T23:59:59.999Z");
      expect(
        parse(schema, new Date(minimum.getTime() - 1)).issues
      ).toBeDefined();
      expect(
        parse(schema, new Date(maximum.getTime() + 1)).issues
      ).toBeDefined();
    });

    test("normalizes a Date from another realm and refuses an impostor", () => {
      const foreign = foreignDate("'2023-12-15T10:30:00.000Z'");
      expect(foreign instanceof Date).toBe(false);
      expect(successfulValue(schema, foreign)).toBe("2023-12-15T10:30:00.000Z");
      expect(parse(schema, foreignDate("NaN")).issues).toBeDefined();
      expect(parse(schema, DATE_IMPOSTOR).issues).toBeDefined();
    });

    test("uses the foreign Date instant instead of overridable methods", () => {
      const valid: Date = vm.runInNewContext(
        `Object.assign(new Date('2023-12-15T10:30:00.000Z'), {
          getTime() { return NaN },
          toISOString() { return 'spoofed' }
        })`
      );
      const invalid: Date = vm.runInNewContext(
        "Object.assign(new Date(NaN), { getTime() { return 0 } })"
      );

      expect(successfulValue(schema, valid)).toBe("2023-12-15T10:30:00.000Z");
      expect(parse(schema, invalid).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string>();
    });
  });

  describe("options", () => {
    test("optional", () => {
      const schema = v.isoTimestamp({ optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
    });

    test("nullable", () => {
      const schema = v.isoTimestamp({ nullable: true });
      expect(parse(schema, null).issues).toBeUndefined();
    });

    test("array", () => {
      const schema = v.isoTimestamp({ array: true });
      const result = parse(schema, ["2023-12-15T10:30:00.000Z"]);
      expect(result.issues).toBeUndefined();
    });
  });
});

describe("isoDate schema", () => {
  describe("basic validation", () => {
    const schema = v.isoDate();

    test("validates ISO dates", () => {
      const valid = "2023-12-15";
      const result = parse(schema, valid);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(valid);
    });

    test("rejects invalid formats", () => {
      expect(parse(schema, "2023-12-15T10:30:00Z").issues).toBeDefined();
      expect(parse(schema, "12/15/2023").issues).toBeDefined();
      expect(parse(schema, "2023-1-1").issues).toBeDefined();
    });

    test("rejects invalid dates", () => {
      expect(parse(schema, "2023-13-15").issues).toBeDefined();
      expect(parse(schema, "2023-12-32").issues).toBeDefined();
      expect(parse(schema, "2023-02-29").issues).toBeDefined();
      expect(parse(schema, "2023-04-31").issues).toBeDefined();
      expect(parse(schema, "2024-02-29").issues).toBeUndefined();
      expect(parse(schema, "1900-02-29").issues).toBeDefined();
      expect(parse(schema, "2000-02-29").issues).toBeUndefined();
    });

    test("normalizes Date values and rejects invalid or unrelated values", () => {
      expect(
        (
          parse(schema, new Date("2023-12-15T10:30:00.000Z")) as {
            value: string;
          }
        ).value
      ).toBe("2023-12-15");
      expect(parse(schema, new Date(Number.NaN)).issues).toBeDefined();
      expect(parse(schema, 1).issues).toBeDefined();
    });

    test("normalizes only Date instants in the four-digit UTC range", () => {
      const minimum = new Date(-62_167_219_200_000);
      const maximum = new Date(253_402_300_799_999);

      expect(successfulValue(schema, minimum)).toBe("0000-01-01");
      expect(successfulValue(schema, maximum)).toBe("9999-12-31");
      expect(
        parse(schema, new Date(minimum.getTime() - 1)).issues
      ).toBeDefined();
      expect(
        parse(schema, new Date(maximum.getTime() + 1)).issues
      ).toBeDefined();
    });

    test("normalizes a Date from another realm and refuses an impostor", () => {
      expect(
        successfulValue(schema, foreignDate("'2023-12-15T10:30:00.000Z'"))
      ).toBe("2023-12-15");
      expect(parse(schema, foreignDate("NaN")).issues).toBeDefined();
      expect(parse(schema, DATE_IMPOSTOR).issues).toBeDefined();
    });

    test("uses the foreign Date instant instead of overridable methods", () => {
      const valid: Date = vm.runInNewContext(
        `Object.assign(new Date('2023-12-15T10:30:00.000Z'), {
          getTime() { return NaN },
          toISOString() { return 'spoofed' }
        })`
      );
      const invalid: Date = vm.runInNewContext(
        "Object.assign(new Date(NaN), { getTime() { return 0 } })"
      );

      expect(successfulValue(schema, valid)).toBe("2023-12-15");
      expect(parse(schema, invalid).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string>();
    });
  });

  describe("options", () => {
    test("optional", () => {
      const schema = v.isoDate({ optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
    });

    test("nullable", () => {
      const schema = v.isoDate({ nullable: true });
      expect(parse(schema, null).issues).toBeUndefined();
    });

    test("array", () => {
      const schema = v.isoDate({ array: true });
      const result = parse(schema, ["2023-12-15"]);
      expect(result.issues).toBeUndefined();
    });
  });
});

describe("isoTime schema", () => {
  describe("basic validation", () => {
    const schema = v.isoTime();

    test("validates ISO times", () => {
      const valid = "10:30:00";
      const result = parse(schema, valid);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(valid);
    });

    test("validates times with milliseconds", () => {
      const valid = "10:30:00.123";
      const result = parse(schema, valid);
      expect(result.issues).toBeUndefined();
    });

    test("rejects invalid formats", () => {
      expect(parse(schema, "10:30").issues).toBeDefined();
      expect(parse(schema, "10:30:00:00").issues).toBeDefined();
    });

    test("rejects invalid times", () => {
      expect(parse(schema, "25:00:00").issues).toBeDefined();
      expect(parse(schema, "10:60:00").issues).toBeDefined();
      expect(parse(schema, "10:30:60").issues).toBeDefined();
    });

    test("normalizes Date values and rejects invalid or unrelated values", () => {
      expect(
        (
          parse(schema, new Date("2023-12-15T10:30:00.000Z")) as {
            value: string;
          }
        ).value
      ).toBe("10:30:00.000");
      expect(parse(schema, new Date(Number.NaN)).issues).toBeDefined();
      expect(parse(schema, 1).issues).toBeDefined();
    });

    test("normalizes a Date from another realm and refuses an impostor", () => {
      expect(
        successfulValue(schema, foreignDate("'2023-12-15T10:30:00.000Z'"))
      ).toBe("10:30:00.000");
      expect(parse(schema, foreignDate("NaN")).issues).toBeDefined();
      expect(parse(schema, DATE_IMPOSTOR).issues).toBeDefined();
    });

    test("uses the foreign Date instant instead of overridable methods", () => {
      const valid: Date = vm.runInNewContext(
        `Object.assign(new Date('2023-12-15T10:30:00.000Z'), {
          getTime() { return NaN },
          toISOString() { return 'spoofed' }
        })`
      );
      const invalid: Date = vm.runInNewContext(
        "Object.assign(new Date(NaN), { getTime() { return 0 } })"
      );

      expect(successfulValue(schema, valid)).toBe("10:30:00.000");
      expect(parse(schema, invalid).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string>();
    });
  });

  describe("options", () => {
    test("optional", () => {
      const schema = v.isoTime({ optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
    });

    test("nullable", () => {
      const schema = v.isoTime({ nullable: true });
      expect(parse(schema, null).issues).toBeUndefined();
    });

    test("array", () => {
      const schema = v.isoTime({ array: true });
      const result = parse(schema, ["10:30:00"]);
      expect(result.issues).toBeUndefined();
    });
  });
});
