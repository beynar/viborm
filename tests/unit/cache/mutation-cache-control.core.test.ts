/**
 * A write's `cache` argument is an ordinary argument of the cache extension:
 * its validator is the cache's own, so a malformed value is refused as a
 * `CacheConfigurationError`, passed by the host as it is. Provider-backed
 * pins: `official-cache-invalidation.test.ts`.
 */

import { admitMutationOptions } from "@cache/schema";
import { CacheConfigurationError } from "@errors";
import { describe, expect, test } from "vitest";

describe("the cache's mutation argument", () => {
  test("admits a frozen copy of the options it validated", () => {
    const given = { invalidate: ["post:*"] };
    const admitted = admitMutationOptions(given);
    expect(admitted).toEqual({ autoInvalidate: true, invalidate: ["post:*"] });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted?.invalidate)).toBe(true);
    expect(admitted?.invalidate).not.toBe(given.invalidate);
    expect(admitMutationOptions(undefined)).toEqual({ autoInvalidate: true });
  });

  test("its validator refuses a malformed value as a CacheConfigurationError", () => {
    expect(() => admitMutationOptions({ autoInvalidate: "yes" })).toThrow(
      CacheConfigurationError
    );
  });
});
