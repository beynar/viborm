/**
 * The official cache's declared control (ruling 7) and the canonical-data test
 * a keyed read depends on (plan v3.1 §2.4).
 *
 * A mutation's `cache` argument is the cache's one control: core admits it
 * through the cache's own validator, so a malformed value is still a
 * `CacheConfigurationError`, and the cache reads back only what its validator
 * admitted. Provider-backed pins: `official-cache-invalidation.test.ts`; the
 * client-level admission: `extension-controls.core.test.ts`.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache, readMutationCacheOptions } from "@cache/extension";
import { isCanonicalKeyData } from "@cache/key";
import { CacheConfigurationError } from "@errors";
import { describe, expect, test } from "vitest";

const control = cache({ driver: new MemoryCache() }).controls.cache;
const validate = (value: unknown) =>
  control.schema["~standard"].validate(value);

function configurationFailure(value: unknown): CacheConfigurationError {
  try {
    validate(value);
  } catch (error) {
    if (error instanceof CacheConfigurationError) return error;
    throw error;
  }
  throw new Error("expected a CacheConfigurationError");
}

describe("the official cache control", () => {
  test("is declared on writes, and admits a detached frozen copy the cache reads back", () => {
    expect(control.on).toBe("writes");
    const invalidate = ["user:*"];
    const result = validate({ autoInvalidate: true, invalidate });
    if (!("value" in result)) throw new Error("expected a value");
    const admitted = result.value;
    expect(admitted).toEqual({ autoInvalidate: true, invalidate: ["user:*"] });
    expect(Object.isFrozen(admitted)).toBe(true);
    invalidate.push("post:*");
    expect(admitted?.invalidate).toEqual(["user:*"]);
    expect(readMutationCacheOptions({ cache: admitted })).toBe(admitted);
  });

  test("reads back nothing it did not admit itself", () => {
    expect(readMutationCacheOptions(undefined)).toBeUndefined();
    expect(readMutationCacheOptions({})).toBeUndefined();
    expect(readMutationCacheOptions({ cache: true })).toBeUndefined();
    expect(
      readMutationCacheOptions({ cache: { autoInvalidate: true } })
    ).toBeUndefined();
  });

  test("refuses a malformed value with its own error class", () => {
    expect(configurationFailure({ autoInvalidate: "yes" }).message).toContain(
      "Invalid mutation cache options"
    );
    // A throwing option is the parser's issue, never a raw throw.
    const hostile = new Proxy(new Error("private"), {
      getPrototypeOf() {
        throw new Error("prototype read");
      },
    });
    const unreadable = configurationFailure(
      Object.defineProperty({}, "autoInvalidate", {
        enumerable: true,
        get() {
          throw hostile;
        },
      })
    );
    expect(unreadable.message).toContain("Invalid mutation cache options");
    expect(unreadable.originalCause).toBeInstanceOf(Error);
    expect(unreadable.originalCause).not.toBe(hostile);
  });
});

describe("canonical key data", () => {
  test("plain data, bigints, valid dates and bytes key by content", () => {
    const nullPrototype = Object.assign(Object.create(null), { a: 1 });
    for (const value of [
      null,
      "text",
      true,
      1,
      10n,
      new Date(0),
      new Uint8Array([1]),
      [1, ["nested"]],
      { a: { b: [null] } },
      nullPrototype,
    ]) {
      expect(isCanonicalKeyData(value)).toBe(true);
    }
  });

  test("anything the key would flatten, fail on or misread is not", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype read");
        },
      }
    );
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => 1,
      Symbol("s"),
      new Date(Number.NaN),
      new Map([["a", 1]]),
      { nested: new Set([1]) },
      cycle,
      hostile,
    ]) {
      expect(isCanonicalKeyData(value)).toBe(false);
    }
  });
});
