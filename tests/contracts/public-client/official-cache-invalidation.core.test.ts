import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  ValidationError,
} from "@src/errors";
import { createClient, s } from "@src/index";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test, vi } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
  })
  .map("official_cache_invalidation_user");
const video = s
  .model({
    id: s.string().id(),
    title: s.string(),
  })
  .map("official_cache_invalidation_video");
const schema = { user, video };

const NAMESPACE = Object.freeze({
  one: "viborm:cache:r1:s:006f006e0065",
  tx: "viborm:cache:r1:s:00740078",
  fallback: "viborm:cache:r1:s:00660061006c006c006200610063006b",
  native: "viborm:cache:r1:s:006e00610074006900760065",
  A: "viborm:cache:r1:s:0041",
  colon: "viborm:cache:r1:s:0061003a0062",
  stringOne: "viborm:cache:r1:s:0031",
  numberOne: "viborm:cache:r1:n:3ff0000000000000",
  loneSurrogate: "viborm:cache:r1:s:d800",
  unversioned: "viborm:cache:r1:u",
  ambiguous: "viborm:cache:r1:s:0061006d0062006900670075006f00750073",
});

const fallbackFamily = usePGliteSchemaFamily(schema);
const nativeFamily = usePGliteSchemaFamily(schema, "atomicBatch");

class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];
  private readonly timeline: string[] | undefined;
  private nextClearFailure: Error | undefined;

  constructor(timeline?: string[]) {
    super();
    this.timeline = timeline;
  }

  failNextClear(error: Error): void {
    this.nextClearFailure = error;
  }

  protected override async delete(keys: string[]): Promise<void> {
    this.timeline?.push("cache");
    this.invalidations.push(`delete:${keys.join(",")}`);
    await super.delete(keys);
  }

  protected override async clear(prefix: string): Promise<void> {
    this.timeline?.push("cache");
    this.invalidations.push(`clear:${prefix}`);
    const failure = this.nextClearFailure;
    this.nextClearFailure = undefined;
    if (failure !== undefined) throw failure;
    await super.clear(prefix);
  }
}

function officialClient(
  driver: ReturnType<typeof fallbackFamily>["driver"],
  cacheDriver: RecordingCache,
  version?: string | number
) {
  return createClient({ schema, driver }).$extends(
    cache({ driver: cacheDriver, version })
  );
}

describe("official cache mutation ownership", () => {
  test("keeps extraction lazy, runs it after request, and publishes before public listeners", async () => {
    const { driver } = fallbackFamily();
    const timeline: string[] = [];
    const cacheDriver = new RecordingCache(timeline);
    const base = createClient({ schema, driver }).$extends({
      name: "inject-cache-after-request",
      request: {
        user: {
          create() {
            timeline.push("request");
            return Object.defineProperty({}, "cache", {
              enumerable: true,
              value: { autoInvalidate: true },
            });
          },
        },
      },
    });
    const client = base
      .$extends(cache({ driver: cacheDriver, version: "one" }))
      .$extends({
        name: "inspect-clean-query",
        query: {
          user: {
            async create({ input, onWriteOutcome, proceed }) {
              timeline.push(`query:cache=${Reflect.has(input, "cache")}`);
              onWriteOutcome(({ certainty }) => {
                timeline.push(`public:${certainty}`);
              });
              return proceed();
            },
          },
        },
      });

    const operation = client.user.create({
      data: { id: "u1", name: "Ada" },
    });
    expect(timeline).toEqual([]);
    expect(cacheDriver.invalidations).toEqual([]);

    await expect(operation).resolves.toMatchObject({ id: "u1", name: "Ada" });
    expect(timeline).toEqual([
      "request",
      "query:cache=false",
      "cache",
      "public:committed",
    ]);
    expect(cacheDriver.invalidations).toEqual([`clear:${NAMESPACE.one}:user:`]);
  });

  test("reads only the cache descriptor once and preserves unrelated descriptors", async () => {
    const { driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const client = officialClient(driver, cacheDriver, "one");
    let cacheReads = 0;
    let dataReads = 0;
    const input = Object.defineProperties(
      {},
      {
        cache: {
          enumerable: true,
          get() {
            cacheReads += 1;
            return { autoInvalidate: true };
          },
        },
        data: {
          enumerable: true,
          get() {
            dataReads += 1;
            return { id: "u1", name: "Ada" };
          },
        },
      }
    );

    const operation = Reflect.apply(client.user.create, undefined, [input]);
    expect({ cacheReads, dataReads }).toEqual({ cacheReads: 0, dataReads: 0 });
    await operation;
    expect(cacheReads).toBe(1);
    expect(dataReads).toBeGreaterThan(0);
  });

  test("memoizes hostile cache failures and leaves unconfigured cache input to core validation", async () => {
    const { client: unconfigured, driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const configured = officialClient(driver, cacheDriver);
    let reads = 0;
    const hostileCacheFailure = new Proxy(new Error("private-cache-value"), {
      getPrototypeOf() {
        throw new Error("hostile cache error prototype read");
      },
    });
    const hostile = Object.defineProperty(
      { data: { id: "u1", name: "Ada" } },
      "cache",
      {
        enumerable: true,
        get() {
          reads += 1;
          throw hostileCacheFailure;
        },
      }
    );

    const configuredOperation = Reflect.apply(
      configured.user.create,
      undefined,
      [hostile]
    );
    expect(reads).toBe(0);
    const first = configuredOperation.then(undefined, (error) => error);
    const second = configuredOperation.then(undefined, (error) => error);
    await expect(first).resolves.toBeInstanceOf(CacheConfigurationError);
    await expect(second).resolves.toBeInstanceOf(CacheConfigurationError);
    const normalizedFailure = await first;
    if (!(normalizedFailure instanceof CacheConfigurationError)) {
      throw normalizedFailure;
    }
    expect(normalizedFailure).toMatchObject({
      originalCause: expect.any(Error),
    });
    expect(normalizedFailure.originalCause).not.toBe(hostileCacheFailure);
    expect(reads).toBe(1);

    const hostileValidationFailure = new Proxy(
      new Error("private-cache-option"),
      {
        getPrototypeOf() {
          throw new Error("hostile cache option prototype read");
        },
      }
    );
    const hostileOptions = Object.defineProperty({}, "autoInvalidate", {
      enumerable: true,
      get() {
        throw hostileValidationFailure;
      },
    });
    const hostileValidationOperation = Reflect.apply(
      configured.user.create,
      undefined,
      [
        {
          data: { id: "u-hostile-options", name: "Hostile options" },
          cache: hostileOptions,
        },
      ]
    );
    const hostileValidationError = await hostileValidationOperation.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(hostileValidationError).toBeInstanceOf(CacheConfigurationError);
    if (!(hostileValidationError instanceof CacheConfigurationError)) {
      throw hostileValidationError;
    }
    expect(hostileValidationError).toMatchObject({
      originalCause: expect.any(Error),
    });
    expect(hostileValidationError.originalCause).not.toBe(
      hostileValidationFailure
    );

    const malformedOperation = Reflect.apply(
      configured.user.create,
      undefined,
      [
        {
          data: { id: "u-malformed", name: "Malformed" },
          cache: { autoInvalidate: "yes" },
        },
      ]
    );
    await expect(malformedOperation).rejects.toBeInstanceOf(
      CacheConfigurationError
    );

    const unconfiguredOperation = Reflect.apply(
      unconfigured.user.create,
      undefined,
      [
        {
          data: { id: "u2", name: "Grace" },
          cache: { autoInvalidate: true },
        },
      ]
    );
    await expect(unconfiguredOperation).rejects.toBeInstanceOf(ValidationError);
  });

  test("does not inspect cache options when an earlier request transform fails", async () => {
    const { driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const client = createClient({ schema, driver })
      .$extends({
        name: "request-refusal",
        request: {
          user: {
            create() {
              throw new Error("request refused");
            },
          },
        },
      })
      .$extends(cache({ driver: cacheDriver }));
    let cacheReads = 0;
    const input = Object.defineProperty(
      { data: { id: "u1", name: "Ada" } },
      "cache",
      {
        enumerable: true,
        get() {
          cacheReads += 1;
          return { autoInvalidate: true };
        },
      }
    );

    const operation = Reflect.apply(client.user.create, undefined, [input]);
    expect(cacheReads).toBe(0);
    await expect(operation).rejects.toThrow();
    expect(cacheReads).toBe(0);
    expect(cacheDriver.invalidations).toEqual([]);
  });

  test("stages callback and savepoint invalidation until the outer commit", async () => {
    const { driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const client = officialClient(driver, cacheDriver, "tx");

    await client.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "u1", name: "Ada" },
        cache: { autoInvalidate: true },
      });
      expect(cacheDriver.invalidations).toEqual([]);
      await tx.$transaction(async (nested) => {
        await nested.user.create({
          data: { id: "u2", name: "Grace" },
          cache: { invalidate: ["user:all"] },
        });
      });
      expect(cacheDriver.invalidations).toEqual([]);
    });
    expect(cacheDriver.invalidations).toEqual([
      `clear:${NAMESPACE.tx}:user:`,
      `delete:${NAMESPACE.tx}:user:all,${NAMESPACE.tx}:user:all:reval`,
    ]);

    cacheDriver.invalidations.length = 0;
    await expect(
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "u3", name: "Rollback" },
          cache: { autoInvalidate: true },
        });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(cacheDriver.invalidations).toEqual([]);
  });

  const arrayModes: ReadonlyArray<
    readonly ["fallback" | "native", typeof fallbackFamily]
  > = [
    ["fallback", fallbackFamily],
    ["native", nativeFamily],
  ];
  for (const [mode, family] of arrayModes) {
    test(`${mode} mixed arrays publish every mutation through the outcome rail`, async () => {
      const { driver } = family();
      const cacheDriver = new RecordingCache();
      const client = officialClient(driver, cacheDriver, mode);

      const [before, created, raw] = await client.$transaction([
        client.user.count(),
        client.user.create({
          data: { id: "u1", name: "Ada" },
          cache: { autoInvalidate: true },
        }),
        client.$queryRaw<{ value: number }>`SELECT ${7}::int AS value`,
      ]);

      expect(before).toBe(0);
      expect(created).toMatchObject({ id: "u1" });
      expect(raw).toEqual([{ value: 7 }]);
      expect(cacheDriver.invalidations).toEqual([
        `clear:${NAMESPACE[mode]}:user:`,
      ]);
    });
  }

  test("isolates official namespaces and refuses full keys without effects", async () => {
    const { driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const first = officialClient(driver, cacheDriver, "A");
    const second = officialClient(driver, cacheDriver, "a:b");
    const stringOne = officialClient(driver, cacheDriver, "1");
    const numberOne = officialClient(driver, cacheDriver, 1);
    const loneSurrogate = officialClient(driver, cacheDriver, "\ud800");
    const unversioned = officialClient(driver, cacheDriver);

    await first.$invalidate("video:one");
    await first.$invalidate("video:*");
    await second.$invalidate("video:*");
    await stringOne.$invalidate("video:*");
    await numberOne.$invalidate("video:*");
    await loneSurrogate.$invalidate("video:*");
    await unversioned.$invalidate("video:*");
    expect(cacheDriver.invalidations).toEqual([
      `delete:${NAMESPACE.A}:video:one,${NAMESPACE.A}:video:one:reval`,
      `clear:${NAMESPACE.A}:video:`,
      `clear:${NAMESPACE.colon}:video:`,
      `clear:${NAMESPACE.stringOne}:video:`,
      `clear:${NAMESPACE.numberOne}:video:`,
      `clear:${NAMESPACE.loneSurrogate}:video:`,
      `clear:${NAMESPACE.unversioned}:video:`,
    ]);
    cacheDriver.invalidations.length = 0;

    await first.video.create({
      data: { id: "v1", title: "Exact video" },
      cache: { autoInvalidate: true },
    });
    expect(cacheDriver.invalidations).toEqual([`clear:${NAMESPACE.A}:video:`]);

    cacheDriver.invalidations.length = 0;
    await first.user.create({
      data: { id: "u1", name: "Ada" },
      cache: {},
    });
    await first.$invalidate();
    expect(cacheDriver.invalidations).toEqual([]);
  });

  test("preflights every manual and mutation invalidation target atomically", async () => {
    const { driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const client = officialClient(driver, cacheDriver, "A");
    const targetOrders: ReadonlyArray<readonly [string, string]> = [
      ["video:*", "viborm:vforeign:video:invalid"],
      ["viborm:vforeign:video:invalid", "video:valid"],
    ];

    for (const targets of targetOrders) {
      await expect(client.$invalidate(...targets)).rejects.toBeInstanceOf(
        CacheInvalidKeyError
      );
      expect(cacheDriver.invalidations).toEqual([]);
    }

    for (let index = 0; index < targetOrders.length; index += 1) {
      const failure = await client.user
        .create({
          data: { id: `atomic-${index}`, name: `Atomic ${index}` },
          cache: { invalidate: [...targetOrders[index]!] },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).toBeInstanceOf(CacheConfigurationError);
      expect(failure).toMatchObject({
        meta: expect.objectContaining({
          method: "invalidate",
          commitCertainty: "committed",
        }),
        originalCause: expect.any(Error),
      });
      expect(cacheDriver.invalidations).toEqual([]);
    }
  });

  test("publishes a dispatched native refusal as may-have-committed", async () => {
    const { driver } = nativeFamily();
    const cacheDriver = new RecordingCache();
    const certainties: string[] = [];
    const client = officialClient(driver, cacheDriver, "ambiguous").$extends({
      name: "inspect-ambiguous-cache-outcome",
      query: {
        user: {
          async create({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => {
              certainties.push(certainty);
            });
            return proceed();
          },
        },
      },
    });
    const executeBatch = vi
      .spyOn(driver, "_executeBatch")
      .mockRejectedValueOnce(new Error("provider dispatch failed"));
    cacheDriver.failNextClear(new Error("cache acknowledgement failed"));

    let failure: unknown;
    try {
      failure = await client
        .$transaction([
          client.user.create({
            data: { id: "u1", name: "Ada" },
            cache: { autoInvalidate: true },
          }),
        ])
        .then(
          () => undefined,
          (error: unknown) => error
        );
    } finally {
      executeBatch.mockRestore();
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    const cacheFailure = failure.errors.find(
      (error) => error instanceof CacheConfigurationError
    );
    expect(cacheFailure).toMatchObject({
      meta: expect.objectContaining({
        method: "invalidate",
        model: "user",
        operation: "create",
        commitCertainty: "may-have-committed",
      }),
      originalCause: expect.any(Error),
    });
    expect(cacheDriver.invalidations).toEqual([
      `clear:${NAMESPACE.ambiguous}:user:`,
    ]);
    expect(certainties).toEqual(["may-have-committed"]);
  });

  test("normalizes a hostile invalidation-driver Error after commit", async () => {
    const { driver } = fallbackFamily();
    const cacheDriver = new RecordingCache();
    const client = officialClient(driver, cacheDriver, "one");
    const hostileFailure = new Proxy(
      new Error("private invalidation failure"),
      {
        getPrototypeOf() {
          throw new Error("hostile invalidation error prototype read");
        },
      }
    );
    cacheDriver.failNextClear(hostileFailure);

    const failure = await client.user
      .create({
        data: { id: "hostile-invalidation", name: "Hostile invalidation" },
        cache: { autoInvalidate: true },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(CacheConfigurationError);
    if (!(failure instanceof CacheConfigurationError)) throw failure;
    expect(failure).toMatchObject({
      meta: expect.objectContaining({
        method: "invalidate",
        model: "user",
        operation: "create",
        commitCertainty: "committed",
      }),
      originalCause: expect.any(Error),
    });
    expect(failure.originalCause).not.toBe(hostileFailure);
    expect(cacheDriver.invalidations).toEqual([`clear:${NAMESPACE.one}:user:`]);
  });
});
