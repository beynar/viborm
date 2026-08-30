import vm from "node:vm";
import {
  isBigInt,
  isBoolean,
  isDate,
  isFunction,
  isNumber,
  isRecord,
  isString,
  isUint8Array,
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

  test("reads the Date brand slot rather than the prototype chain", () => {
    const foreign: Date = vm.runInNewContext("new Date(0)");
    expect(foreign instanceof Date).toBe(false);
    expect(isDate(foreign)).toBe(true);
    // Whether the instant is NaN belongs to the schemas that consume this.
    expect(isDate(vm.runInNewContext("new Date(NaN)"))).toBe(true);
  });

  test("refuses every Date impostor", () => {
    expect(isDate({ [Symbol.toStringTag]: "Date", getTime: () => 0 })).toBe(
      false
    );
    expect(isDate({})).toBe(false);
    expect(isDate(null)).toBe(false);
    expect(isDate("1970-01-01T00:00:00.000Z")).toBe(false);
  });

  test("narrows Uint8Array identity across realms and Buffer", () => {
    expect(isUint8Array(new Uint8Array([1]))).toBe(true);
    expect(isUint8Array(Buffer.from([1]))).toBe(true);
    const foreign: Uint8Array = vm.runInNewContext("new Uint8Array([1])");
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(isUint8Array(foreign)).toBe(true);
  });

  test("refuses every Uint8Array impostor", () => {
    expect(
      isUint8Array({ [Symbol.toStringTag]: "Uint8Array", length: 1 })
    ).toBe(false);
    expect(isUint8Array(new Float64Array(1))).toBe(false);
    expect(isUint8Array(new DataView(new ArrayBuffer(1)))).toBe(false);
    expect(isUint8Array([1])).toBe(false);
    expect(isUint8Array(null)).toBe(false);
    expect(isUint8Array("bytes")).toBe(false);
  });
});
