import { MemoryCache } from "@cache/drivers/memory";
import { CacheConfigurationError } from "@errors";
import { createTestClock } from "@tests/fixtures/test-clock";
import { describe, expect, it } from "vitest";

describe("Cache", () => {
  it("keeps the memory driver constructor option-free", () => {
    let reads = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          reads += 1;
          throw new Error("must not read retired options");
        },
      }
    );

    expect(() => Reflect.construct(MemoryCache, [hostile])).toThrow(
      CacheConfigurationError
    );
    expect(reads).toBe(0);

    const retiredClockOption = () => {
      // @ts-expect-error - the public MemoryCache clock seam was removed
      new MemoryCache({ clock: createTestClock() });
    };
    expect(retiredClockOption).toBeTypeOf("function");
  });
});
