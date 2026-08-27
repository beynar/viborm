import { MemoryCache } from "@cache/drivers/memory";
import {
  cache,
  getOfficialCacheChainCapability,
  getOfficialCacheChainDefinition,
} from "@cache/extension";
import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import { CacheConfigurationError, ClientInitializationError } from "@errors";
import {
  appendResolvedExtension,
  type ResolvedExtensionChain,
} from "@extensions/chain";
import { createClient, s } from "@src/index";
import { afterEach, describe, expect, it } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const schema = { item };
const clients: Array<{ $disconnect(): Promise<void> }> = [];

function baseClient() {
  const client = createClient({
    schema,
    driver: new PGliteDriver(),
  });
  clients.push(client);
  return client;
}

function applyUnsafe(client: object, extension: unknown): object {
  return Reflect.apply(Reflect.get(client, "$extends"), client, [extension]);
}

/**
 * Append with no client and therefore no driver. Such a chain carries the cache
 * DEFINITION only: the scope partitions on dialect and SQL namespace, which do
 * not exist until a client composition root binds the chain, so every assertion
 * here reads the definition rather than a bound capability.
 */
function appendOfficial(
  extension: unknown,
  chain?: ResolvedExtensionChain
): ResolvedExtensionChain {
  return appendResolvedExtension(chain, extension, schema);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official cache extension foundation", () => {
  it("snapshots hostile config once without mutating the shared driver", () => {
    const driver = new MemoryCache();
    const firstWaitUntil = () => undefined;
    const reads = { driver: 0, version: 0, waitUntil: 0 };
    const config = {
      get driver() {
        reads.driver += 1;
        return driver;
      },
      get version() {
        reads.version += 1;
        return "first";
      },
      get waitUntil() {
        reads.waitUntil += 1;
        return firstWaitUntil;
      },
    };

    const extension = cache(config);
    const chain = appendOfficial(extension);
    const capability = getOfficialCacheChainDefinition(chain);

    expect(getOfficialCacheChainCapability(chain)).toBeUndefined();
    expect(extension.name).toBe("viborm.cache");
    expect(Reflect.ownKeys(extension)).toEqual(["name", "query"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(config)).toBe(false);
    expect(reads).toEqual({ driver: 1, version: 1, waitUntil: 1 });
    expect(capability?.driver).toBe(driver);
    expect(capability?.version).toBe("first");
    expect(capability?.waitUntil).toBe(firstWaitUntil);
    expect(chain.hasCache).toBe(true);
    expect(chain.hasQueryHandlers).toBe(false);
    expect(chain.query.global).toHaveLength(0);
  });

  it("keeps version and waitUntil isolated when one driver is shared", () => {
    const driver = new MemoryCache();
    const firstWaitUntil = () => undefined;
    const secondWaitUntil = () => undefined;

    const first = appendOfficial(
      cache({ driver, version: "first", waitUntil: firstWaitUntil })
    );
    const second = appendOfficial(
      cache({ driver, version: "second", waitUntil: secondWaitUntil })
    );

    expect(getOfficialCacheChainDefinition(first)).toMatchObject({
      driver,
      version: "first",
      waitUntil: firstWaitUntil,
    });
    expect(getOfficialCacheChainDefinition(second)).toMatchObject({
      driver,
      version: "second",
      waitUntil: secondWaitUntil,
    });
  });

  it("exposes cache methods only on an authentic official derived client", () => {
    const base = baseClient();
    const ordinary = base.$extends({ name: "ordinary" });
    const official = base.$extends(cache({ driver: new MemoryCache() }));

    expect(Reflect.get(base, "$withCache")).toBeUndefined();
    expect(Reflect.get(base, "$invalidate")).toBeUndefined();
    expect(Reflect.get(ordinary, "$withCache")).toBeUndefined();
    expect(Reflect.get(ordinary, "$invalidate")).toBeUndefined();
    expect(typeof Reflect.get(official, "$withCache")).toBe("function");
    expect(typeof Reflect.get(official, "$invalidate")).toBe("function");
  });

  it("does not read removed cache config accessors on either client entry point", () => {
    const coreReads = { cache: 0, cacheVersion: 0, waitUntil: 0 };
    const wrapperReads = { cache: 0, cacheVersion: 0, waitUntil: 0 };
    const removed = (reads: typeof coreReads) => ({
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
    });
    const coreConfig = Object.defineProperties(
      { schema, driver: new PGliteDriver() },
      Object.getOwnPropertyDescriptors(removed(coreReads))
    );
    const wrapperConfig = Object.defineProperties(
      { schema, dataDir: "memory://" },
      Object.getOwnPropertyDescriptors(removed(wrapperReads))
    );

    const core = Reflect.apply(createClient, undefined, [coreConfig]);
    const wrapper = Reflect.apply(createPGliteClient, undefined, [
      wrapperConfig,
    ]);
    clients.push(core, wrapper);

    expect(coreReads).toEqual({ cache: 0, cacheVersion: 0, waitUntil: 0 });
    expect(wrapperReads).toEqual({ cache: 0, cacheVersion: 0, waitUntil: 0 });
  });

  it("accepts an exact clone and preserves provenance through ordinary chains", () => {
    const base = baseClient();
    const official = cache({ driver: new MemoryCache() });
    const cloned = { ...official };
    const cached = base.$extends(cloned);
    const ordinary = cached.$extends({ name: "after-cache" });

    expect(ordinary.$schema).toBe(schema);
    expect(typeof ordinary.$withCache).toBe("function");
    expect(typeof ordinary.$invalidate).toBe("function");
  });

  it("refuses fake, renamed, replaced, bound, and duplicate capabilities atomically", () => {
    const base = baseClient();
    const official = cache({ driver: new MemoryCache() });
    const derived = base.$extends(official);

    expect(() => applyUnsafe(base, { name: "viborm.cache" })).toThrow(
      ClientInitializationError
    );
    expect(() =>
      applyUnsafe(base, { ...official, name: "renamed-cache" })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, {
        ...official,
        query: async ({ proceed }: { proceed(): Promise<unknown> }) =>
          proceed(),
      })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, { ...official, query: official.query.bind(undefined) })
    ).toThrow(ClientInitializationError);
    expect(() => applyUnsafe(derived, { ...official })).toThrow(
      ClientInitializationError
    );

    expect(derived.$extends({ name: "after-refusals" }).$schema).toBe(schema);
  });

  it("reports hostile factory configuration without leaking raw throws", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private-hostile-value");
        },
      }
    );

    expect(() => Reflect.apply(cache, undefined, [hostile])).toThrow(
      CacheConfigurationError
    );
    try {
      Reflect.apply(cache, undefined, [hostile]);
    } catch (error) {
      expect(error).toBeInstanceOf(CacheConfigurationError);
      if (!(error instanceof CacheConfigurationError)) throw error;
      expect(error.originalCause).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private-hostile-value");
    }
  });

  it("normalizes a hostile Error thrown while reading factory configuration", () => {
    const hostileFailure = new Proxy(new Error("private-config-failure"), {
      getPrototypeOf() {
        throw new Error("hostile config error prototype read");
      },
    });
    const config = Object.defineProperty({}, "driver", {
      enumerable: true,
      get() {
        throw hostileFailure;
      },
    });

    try {
      Reflect.apply(cache, undefined, [config]);
      throw new Error("Expected cache configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CacheConfigurationError);
      if (!(error instanceof CacheConfigurationError)) throw error;
      expect(error.originalCause).toBeInstanceOf(Error);
      expect(error.originalCause).not.toBe(hostileFailure);
      expect(String(error)).not.toContain("private-config-failure");
    }
  });

  it("normalizes a hostile cache driver prototype inspection", () => {
    const hostileDriver = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private-driver-prototype");
        },
      }
    );

    expect(() =>
      Reflect.apply(cache, undefined, [{ driver: hostileDriver }])
    ).toThrow(CacheConfigurationError);
    try {
      Reflect.apply(cache, undefined, [{ driver: hostileDriver }]);
    } catch (error) {
      expect(error).toBeInstanceOf(CacheConfigurationError);
      if (!(error instanceof CacheConfigurationError)) throw error;
      expect(error.originalCause).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private-driver-prototype");
    }
  });
});
