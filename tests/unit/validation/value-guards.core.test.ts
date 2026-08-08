import {
  isBigInt,
  isBoolean,
  isDate,
  isFunction,
  isNumber,
  isRecord,
  isString,
} from "@validation/value-guards";
import { describe, expect, test } from "vitest";

describe("validation value guards", () => {
  test("recognizes the shared non-array object representation", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
  });

  test.each([
    null,
    undefined,
    [],
    "value",
    1,
    true,
    () => undefined,
  ])("rejects %s as a record", (value) => {
    expect(isRecord(value)).toBe(false);
  });

  test("narrows strings without coercion", () => {
    expect(isString("value")).toBe(true);
    expect(isString({ toString: () => "value" })).toBe(false);
    expect(isString(1)).toBe(false);
  });

  test("narrows callable values", () => {
    expect(isFunction(() => undefined)).toBe(true);
    expect(isFunction(class Example {})).toBe(true);
    expect(isFunction({ call: () => undefined })).toBe(false);
  });

  test("narrows primitive identities without coercion", () => {
    expect(isBigInt(1n)).toBe(true);
    expect(isBigInt(1)).toBe(false);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean(0)).toBe(false);
    expect(isNumber(Number.NaN)).toBe(true);
    expect(isNumber("1")).toBe(false);
  });

  test("narrows Date identity", () => {
    expect(isDate(new Date(0))).toBe(true);
    expect(isDate(Date.now())).toBe(false);
  });
});
