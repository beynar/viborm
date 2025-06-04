import { describe, test, expect } from "vitest";
import { filterValidators } from "../../src/types/query/field-filters";

describe("Zod Filter Validation Debug", () => {
  test("should test string filter validation directly", () => {
    const stringValidator = filterValidators.string.base;

    // Test raw string transformation
    const rawStringResult = stringValidator.safeParse("test@example.com");
    console.log("Raw string result:", rawStringResult);

    // Test explicit equals filter
    const explicitEqualsResult = stringValidator.safeParse({
      equals: "test@example.com",
    });
    console.log("Explicit equals result:", explicitEqualsResult);

    // Test contains filter
    const containsResult = stringValidator.safeParse({ contains: "example" });
    console.log("Contains result:", containsResult);

    // Test invalid contains filter (number instead of string)
    const invalidContainsResult = stringValidator.safeParse({ contains: 123 });
    console.log("Invalid contains result:", invalidContainsResult);

    expect(rawStringResult.success).toBe(true);
    expect(explicitEqualsResult.success).toBe(true);
    expect(containsResult.success).toBe(true);
    expect(invalidContainsResult.success).toBe(false);
  });

  test("should test number filter validation directly", () => {
    const numberValidator = filterValidators.number.base;

    // Test raw number transformation
    const rawNumberResult = numberValidator.safeParse(42);
    console.log("Raw number result:", rawNumberResult);

    // Test explicit equals filter
    const explicitEqualsResult = numberValidator.safeParse({ equals: 42 });
    console.log("Explicit equals result:", explicitEqualsResult);

    // Test gt filter
    const gtResult = numberValidator.safeParse({ gt: 18 });
    console.log("GT result:", gtResult);

    // Test invalid gt filter (string instead of number)
    const invalidGtResult = numberValidator.safeParse({ gt: "invalid" });
    console.log("Invalid GT result:", invalidGtResult);

    // Test Infinity
    const infinityResult = numberValidator.safeParse({ equals: Infinity });
    console.log("Infinity result:", infinityResult);

    expect(rawNumberResult.success).toBe(true);
    expect(explicitEqualsResult.success).toBe(true);
    expect(gtResult.success).toBe(true);
    expect(invalidGtResult.success).toBe(false);
    expect(infinityResult.success).toBe(false);
  });

  test("should test boolean filter validation directly", () => {
    const booleanValidator = filterValidators.boolean.base;

    // Test raw boolean transformation
    const rawBooleanResult = booleanValidator.safeParse(true);
    console.log("Raw boolean result:", rawBooleanResult);

    // Test explicit equals filter
    const explicitEqualsResult = booleanValidator.safeParse({ equals: true });
    console.log("Explicit equals result:", explicitEqualsResult);

    // Test invalid equals filter (string instead of boolean)
    const invalidEqualsResult = booleanValidator.safeParse({ equals: "true" });
    console.log("Invalid equals result:", invalidEqualsResult);

    expect(rawBooleanResult.success).toBe(true);
    expect(explicitEqualsResult.success).toBe(true);
    expect(invalidEqualsResult.success).toBe(false);
  });

  test("should test dateTime filter validation directly", () => {
    const dateTimeValidator = filterValidators.dateTime.base;

    // Test raw Date transformation
    const rawDateResult = dateTimeValidator.safeParse(new Date("2023-01-01"));
    console.log("Raw date result:", rawDateResult);

    // Test raw ISO string transformation
    const rawISOResult = dateTimeValidator.safeParse(
      "2023-01-01T00:00:00.000Z"
    );
    console.log("Raw ISO result:", rawISOResult);

    // Test explicit equals filter
    const explicitEqualsResult = dateTimeValidator.safeParse({
      equals: new Date("2023-01-01"),
    });
    console.log("Explicit equals result:", explicitEqualsResult);

    // Test invalid date string
    const invalidDateResult = dateTimeValidator.safeParse({
      equals: "invalid-date",
    });
    console.log("Invalid date result:", invalidDateResult);

    expect(rawDateResult.success).toBe(true);
    expect(rawISOResult.success).toBe(true);
    expect(explicitEqualsResult.success).toBe(true);
    expect(invalidDateResult.success).toBe(false);
  });

  test("should test bigInt filter validation directly", () => {
    const bigIntValidator = filterValidators.bigInt.base;

    // Test raw bigint transformation
    const rawBigIntResult = bigIntValidator.safeParse(BigInt(123));
    console.log("Raw bigint result:", rawBigIntResult);

    // Test string representation
    const stringBigIntResult = bigIntValidator.safeParse("9007199254740991");
    console.log("String bigint result:", stringBigIntResult);

    // Test explicit equals filter
    const explicitEqualsResult = bigIntValidator.safeParse({
      equals: BigInt(456),
    });
    console.log("Explicit equals result:", explicitEqualsResult);

    expect(rawBigIntResult.success).toBe(true);
    expect(stringBigIntResult.success).toBe(true);
    expect(explicitEqualsResult.success).toBe(true);
  });

  test("should test json filter validation directly", () => {
    const jsonValidator = filterValidators.json.base;

    // Test raw JSON transformation
    const rawJSONResult = jsonValidator.safeParse({ key: "value" });
    console.log("Raw JSON result:", rawJSONResult);

    // Test explicit equals filter
    const explicitEqualsResult = jsonValidator.safeParse({
      equals: { nested: { prop: 123 } },
    });
    console.log("Explicit equals result:", explicitEqualsResult);

    // Test undefined value
    const undefinedResult = jsonValidator.safeParse({ equals: undefined });
    console.log("Undefined result:", undefinedResult);

    expect(rawJSONResult.success).toBe(true);
    expect(explicitEqualsResult.success).toBe(true);
    expect(undefinedResult.success).toBe(false);
  });
});
