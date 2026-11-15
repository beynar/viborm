import { MemoryCache } from "@cache/drivers/memory";
import { CacheConfigurationError } from "@errors";
import { createTestClock } from "@tests/fixtures/test-clock";
import { describe, expect, it } from "vitest";

describe("Cache", () => {
  it("refuses a misspelled option and a bound that is no positive integer", () => {
    for (const options of [
      { maxEntrie: 2 },
      { maxEntries: 0 },
      { maxEntries: 1.5 },
    ])
      expect(() => Reflect.construct(MemoryCache, [options])).toThrow(
        CacheConfigurationError
      );

    const retiredClockOption = () => {
      // @ts-expect-error - the public MemoryCache clock seam was removed
      new MemoryCache({ clock: createTestClock() });
    };
    expect(retiredClockOption).toBeTypeOf("function");
  });
});
