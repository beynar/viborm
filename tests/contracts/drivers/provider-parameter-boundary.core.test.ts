import { runInNewContext } from "node:vm";
import {
  snapshotProviderParameters,
  validateRawParameters,
} from "@drivers/provider-parameter-snapshot";
import { QueryError } from "@errors";
import { describe, expect, test, vi } from "vitest";

const rawContext = {
  correlationId: "raw-parameter-correlation",
  model: "$raw",
  operation: "$executeRaw",
};

function requireObject(value: unknown): object {
  if (value === null || typeof value !== "object") {
    throw new Error("Expected an object parameter snapshot");
  }
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an array parameter snapshot");
  }
  return value;
}

describe("raw provider parameter ownership", () => {
  test("leaves trusted typed values shallow while detaching the outer list", () => {
    const nested = { value: "trusted" };
    const params = [nested];

    const snapshot = snapshotProviderParameters(params, {
      model: "entry",
      operation: "create",
    });

    expect(snapshot).not.toBe(params);
    expect(snapshot).toEqual(params);
    expect(snapshot[0]).toBe(nested);
  });

  test("detaches one cyclic graph while preserving aliases, holes, and descriptors", () => {
    const instant = new Date("2026-08-30T12:34:56.789Z");
    const shared: Record<string, unknown> = { instant };
    shared.self = shared;
    const sparse: unknown[] = [];
    sparse.length = 3;
    sparse[1] = shared;
    Object.setPrototypeOf(sparse, null);
    Object.defineProperty(sparse, "label", {
      configurable: false,
      enumerable: false,
      value: "private-array-fact",
      writable: false,
    });
    const root = Object.create(null);
    Object.defineProperties(root, {
      shared: {
        configurable: false,
        enumerable: true,
        value: shared,
        writable: false,
      },
      sparse: {
        configurable: true,
        enumerable: true,
        value: sparse,
        writable: true,
      },
    });

    const snapshot = snapshotProviderParameters(
      [root, shared, shared, instant],
      rawContext
    );
    const rootCopy = requireObject(snapshot[0]);
    const sharedCopy = requireObject(snapshot[1]);
    const sparseCopy = requireArray(Reflect.get(rootCopy, "sparse"));
    const instantCopy = Reflect.get(sharedCopy, "instant");

    expect(Object.getPrototypeOf(rootCopy)).toBeNull();
    expect(rootCopy).not.toBe(root);
    expect(sharedCopy).not.toBe(shared);
    expect(snapshot[1]).toBe(snapshot[2]);
    expect(Reflect.get(rootCopy, "shared")).toBe(sharedCopy);
    expect(Reflect.get(sharedCopy, "self")).toBe(sharedCopy);
    expect(sparseCopy).not.toBe(sparse);
    expect(Object.getPrototypeOf(sparseCopy)).toBeNull();
    expect(sparseCopy).toHaveLength(3);
    expect(Object.hasOwn(sparseCopy, 0)).toBe(false);
    expect(sparseCopy[1]).toBe(sharedCopy);
    expect(Object.hasOwn(sparseCopy, 2)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(sparseCopy, "label")).toEqual(
      Object.getOwnPropertyDescriptor(sparse, "label")
    );
    expect(instantCopy).toBeInstanceOf(Date);
    expect(instantCopy).not.toBe(instant);
    expect(instantCopy).toBe(snapshot[3]);
    expect(Date.prototype.getTime.call(instantCopy)).toBe(
      Date.parse("2026-08-30T12:34:56.789Z")
    );

    instant.setUTCFullYear(2000);
    shared.later = true;
    sparse[1] = "changed";
    expect(Date.prototype.getUTCFullYear.call(instantCopy)).toBe(2026);
    expect(Reflect.has(sharedCopy, "later")).toBe(false);
    expect(sparseCopy[1]).toBe(sharedCopy);
  });

  test("preserves sparse top-level raw parameter positions", () => {
    const params: unknown[] = [];
    params.length = 3;
    params[1] = "middle";

    const snapshot = snapshotProviderParameters(params, rawContext);

    expect(snapshot).toHaveLength(3);
    expect(Object.hasOwn(snapshot, 0)).toBe(false);
    expect(snapshot[1]).toBe("middle");
    expect(Object.hasOwn(snapshot, 2)).toBe(false);
  });

  test("normalizes admitted foreign built-in containers to local prototypes", () => {
    const foreign: unknown = runInNewContext(`(() => {
      const shared = { value: 1 };
      return { object: { shared }, array: [shared] };
    })()`);
    const foreignRoot = requireObject(foreign);
    const foreignObject = requireObject(Reflect.get(foreignRoot, "object"));
    const foreignArray = requireArray(Reflect.get(foreignRoot, "array"));

    const snapshot = snapshotProviderParameters(
      [foreignObject, foreignArray],
      rawContext
    );
    const objectCopy = requireObject(snapshot[0]);
    const arrayCopy = requireArray(snapshot[1]);

    expect(Object.getPrototypeOf(objectCopy)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(arrayCopy)).toBe(Array.prototype);
    expect(Reflect.get(objectCopy, "shared")).toBe(arrayCopy[0]);
  });

  test("captures a proxy descriptor view once and dispatches the captured value", () => {
    const target = { nested: { value: "captured" } };
    const ownKeys = vi.fn(() => Reflect.ownKeys(target));
    const getOwnPropertyDescriptor = vi.fn(
      (_target: object, key: PropertyKey) =>
        Object.getOwnPropertyDescriptor(target, key)
    );
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor,
      ownKeys,
    });

    const snapshot = snapshotProviderParameters([proxy], rawContext);
    const copy = requireObject(snapshot[0]);
    Reflect.set(target.nested, "value", "changed after capture");

    expect(copy).not.toBe(proxy);
    expect(snapshot).toEqual([{ nested: { value: "captured" } }]);
    expect(ownKeys).toHaveBeenCalled();
    expect(getOwnPropertyDescriptor).toHaveBeenCalled();
  });

  test("keeps custom record carriers opaque without invoking their behavior", () => {
    const getter = vi.fn(() => {
      throw new Error("record accessor must stay provider-owned");
    });
    const customPrototype = { provider: true };
    const customRecord = Object.create(customPrototype);
    Object.defineProperty(customRecord, "value", {
      enumerable: true,
      get: getter,
    });
    const ownToJSON = { invalid: new Date(Number.NaN) };
    const toJSON = vi.fn(() => "provider-owned");
    Object.defineProperty(ownToJSON, "toJSON", {
      enumerable: false,
      value: toJSON,
    });

    const snapshot = snapshotProviderParameters(
      [customRecord, ownToJSON],
      rawContext
    );

    expect(snapshot[0]).toBe(customRecord);
    expect(snapshot[1]).toBe(ownToJSON);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "custom inherited behavior",
      build() {
        const value: unknown[] = [];
        Object.setPrototypeOf(value, { providerArray: true });
        return value;
      },
    },
    {
      label: "an indexed accessor",
      build() {
        const value: unknown[] = [];
        Object.defineProperty(value, "0", {
          configurable: true,
          enumerable: true,
          get: vi.fn(() => "hidden"),
        });
        return value;
      },
    },
    {
      label: "a custom toJSON method",
      build() {
        const value: unknown[] = [];
        Object.defineProperty(value, "toJSON", {
          configurable: true,
          value: vi.fn(() => []),
        });
        return value;
      },
    },
  ])("refuses an array with $label", ({ build }) => {
    expect(() => snapshotProviderParameters([build()], rawContext)).toThrow(
      QueryError
    );
    expect(() => snapshotProviderParameters([build()], rawContext)).toThrow(
      "raw array parameter 0"
    );
  });

  test("rejects invalid Date leaves with the owning raw parameter index", () => {
    const invalid = new Date(Number.NaN);

    expect(() =>
      snapshotProviderParameters(
        [{ nested: { invalid } }, { valid: true }],
        rawContext
      )
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        meta: expect.objectContaining({
          correlationId: "raw-parameter-correlation",
          model: "$raw",
          operation: "$executeRaw",
          parameterIndex: 0,
        }),
      })
    );
  });

  test("uses caller-owned validation errors without converting them", () => {
    const invalidDate = new Error("invalid date sentinel");
    const unsupportedArray = new Error("unsupported array sentinel");

    expect(() =>
      validateRawParameters([new Date(Number.NaN)], {
        invalidDate: () => invalidDate,
        unsupportedArray: () => unsupportedArray,
      })
    ).toThrow(invalidDate);

    const customArray: unknown[] = [];
    Object.defineProperty(customArray, "0", {
      enumerable: true,
      get: () => "provider-owned",
    });
    expect(() =>
      validateRawParameters([customArray], {
        invalidDate: () => invalidDate,
        unsupportedArray: () => unsupportedArray,
      })
    ).toThrow(unsupportedArray);
  });
});
