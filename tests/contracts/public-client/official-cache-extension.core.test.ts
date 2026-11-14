import { CacheDriver } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { CacheConfigurationError, ClientInitializationError } from "@errors";
import { createClient, extension as extExtension, s } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { afterEach, describe, expect, it } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const schema = { item };
const clients: Array<{ $disconnect(): Promise<void> }> = [];

function baseClient() {
  const client = createClient({
    schema,
    driver: new PlanningDriver("postgresql"),
  });
  clients.push(client);
  return client;
}

/** Records the prefixes an invalidation clears. */
class ClearRecordingCache extends MemoryCache {
  readonly cleared: string[] = [];
  protected override async clear(prefix: string): Promise<void> {
    this.cleared.push(prefix);
    await super.clear(prefix);
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official cache extension foundation", () => {
  it("reads its configuration once, as given", () => {
    const driver = new MemoryCache();
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
        return () => undefined;
      },
    };
    const extension = cache(config);
    baseClient().$extends(extension);
    baseClient().$extends(extension);
    expect(reads).toEqual({ driver: 1, version: 1, waitUntil: 1 });
    expect(extension.name).toBe("viborm.cache");
  });

  it("keeps version scopes apart when one driver is shared", async () => {
    const driver = new ClearRecordingCache();
    const first = baseClient().$extends(cache({ driver, version: "first" }));
    const second = baseClient().$extends(cache({ driver, version: "second" }));
    await first.$invalidate("*");
    await second.$invalidate("*");
    expect(driver.cleared).toHaveLength(2);
    expect(driver.cleared[0]).not.toBe(driver.cleared[1]);
    expect(driver).toBeInstanceOf(CacheDriver);
  });

  it("exposes cache methods only on a client the cache extends", () => {
    const base = baseClient();
    const ordinary = base.$extends(extExtension("ordinary"));
    const official = base.$extends(cache({ driver: new MemoryCache() }));

    expect(Reflect.get(base, "$withCache")).toBeUndefined();
    expect(Reflect.get(base, "$invalidate")).toBeUndefined();
    expect(Reflect.get(ordinary, "$withCache")).toBeUndefined();
    expect(Reflect.get(ordinary, "$invalidate")).toBeUndefined();
    expect(typeof Reflect.get(official, "$withCache")).toBe("function");
    expect(typeof Reflect.get(official, "$invalidate")).toBe("function");
  });

  it("does not read removed cache config accessors on the core client entry point", () => {
    const coreReads = { cache: 0, cacheVersion: 0, waitUntil: 0 };
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
      { schema, driver: new PlanningDriver("postgresql") },
      Object.getOwnPropertyDescriptors(removed(coreReads))
    );

    const core = Reflect.apply(createClient, undefined, [coreConfig]);
    clients.push(core);

    expect(coreReads).toEqual({ cache: 0, cacheVersion: 0, waitUntil: 0 });
  });

  it("keeps its methods through ordinary extensions applied after it", () => {
    const cached = baseClient().$extends(cache({ driver: new MemoryCache() }));
    const ordinary = cached.$extends(extExtension("after-cache"));

    expect(ordinary.$schema).toBe(schema);
    expect(typeof ordinary.$withCache).toBe("function");
    expect(typeof ordinary.$invalidate).toBe("function");
  });

  it("is applied once: a second cache is refused by its name", () => {
    const derived = baseClient().$extends(cache({ driver: new MemoryCache() }));
    expect(() =>
      // @ts-expect-error - one cache per chain: the runtime refusal is tested
      derived.$extends(cache({ driver: new MemoryCache() }))
    ).toThrow(ClientInitializationError);
    expect(derived.$extends(extExtension("after-refusal")).$schema).toBe(
      schema
    );
  });

  it("refuses a configuration without a cache driver, a bad version or waitUntil", () => {
    const refusals: unknown[] = [
      {},
      { driver: {} },
      { driver: new MemoryCache(), version: Number.NaN },
      { driver: new MemoryCache(), version: true },
      { driver: new MemoryCache(), waitUntil: "later" },
    ];
    for (const config of refusals)
      expect(() => Reflect.apply(cache, undefined, [config])).toThrow(
        CacheConfigurationError
      );
  });

  it("refuses invalid $withCache options when the view is made", () => {
    const cached = baseClient().$extends(cache({ driver: new MemoryCache() }));
    expect(() =>
      Reflect.apply(Reflect.get(cached, "$withCache"), cached, [
        { ttl: "forever" },
      ])
    ).toThrow(CacheConfigurationError);
  });
});
