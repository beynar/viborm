import { createClient } from "@drivers/pglite";
import { ClientInitializationError } from "@errors";
import { s } from "@src/index";
import { describe, expect, it } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const schema = { item };

describe("official cache PGlite wrapper", () => {
  // The removed keys are unknown to the wrapper, which refuses the first one
  // by name without reading any of them.
  it("refuses removed cache config keys without reading their accessors", () => {
    const reads = { cache: 0, cacheVersion: 0, waitUntil: 0 };
    const config = Object.defineProperties(
      { schema, dataDir: "memory://" },
      Object.getOwnPropertyDescriptors({
        get cache() {
          reads.cache += 1;
          throw new Error("removed cache accessor was read");
        },
        get cacheVersion() {
          reads.cacheVersion += 1;
          throw new Error("removed cacheVersion accessor was read");
        },
        get waitUntil() {
          reads.waitUntil += 1;
          throw new Error("removed waitUntil accessor was read");
        },
      })
    );

    expect(() => Reflect.apply(createClient, undefined, [config])).toThrow(
      ClientInitializationError
    );
    expect(() => Reflect.apply(createClient, undefined, [config])).toThrow(
      'viborm/pglite does not accept "cache"'
    );
    expect(reads).toEqual({ cache: 0, cacheVersion: 0, waitUntil: 0 });
  });
});
