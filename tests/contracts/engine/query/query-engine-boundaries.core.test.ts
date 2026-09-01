import { cacheInvalidationSchema } from "@cache";
import { createOfficialCacheScope } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { createOfficialCacheNamespace } from "@cache/key";
import type { Driver, QueryExecutionContext, QueryResult } from "@drivers";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { instrumentation } from "@instrumentation/extension";
import { markErrorLogged } from "@instrumentation/logged-errors";
import {
  createCacheExecutionOptions,
  executeCachedResultOperation,
  invalidateManualCache,
  isCacheManagedExecution,
  prepareMutationCacheInput,
  prepareMutationCacheWriteOutcome,
  validateCacheableOperation,
} from "@query-engine/cache-flow";
import {
  createCorrelationId,
  createOperationExecutionContext,
  createPendingOperationContext,
  createPendingOperationInstrumentationFacts,
  createRawOperationInstrumentationFacts,
  observeTransactionBatchPhase,
} from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { executeSkippableWrite } from "@query-engine/skippable-write";
import {
  readTransactionOperation,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import { validate } from "@query-engine/validator";
import { hydrateSchemaNames, s } from "@schema";
import { type Sql, sql } from "@sql";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { afterEach, describe, expect, test, vi } from "vitest";

const MISSING_OPERATION_SCHEMA_PATTERN =
  /Schema not found for operation: missing/;

const CACHE_NAMESPACE = createOfficialCacheNamespace({
  version: "query-engine-boundaries",
  dialect: "postgresql",
  namespace: "public",
});

class RecordingMemoryCache extends MemoryCache {
  readonly clearedPrefixes: string[] = [];
  clearFailure: unknown;

  protected override async clear(prefix: string): Promise<void> {
    this.clearedPrefixes.push(prefix);
    if (this.clearFailure !== undefined) throw this.clearFailure;
    return super.clear(prefix);
  }
}

class SkippablePlanningDriver extends PlanningDriver {
  executionFailure: Error | undefined;
  transactionCount = 0;
  executionCount = 0;

  override async withTransaction<T>(
    execute: (driver: Driver<null, null>) => Promise<T>
  ): Promise<T> {
    this.transactionCount += 1;
    return execute(this);
  }

  override async _execute<T = Record<string, unknown>>(
    _statement: Sql,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.executionCount += 1;
    if (this.executionFailure !== undefined) throw this.executionFailure;
    return { rows: [], rowCount: 1 };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("query-engine cache boundaries", () => {
  test("extracts mutation cache options without changing ordinary descriptors", () => {
    const symbolKey = Symbol("source");
    const input: Record<PropertyKey, unknown> = {};
    Object.defineProperties(input, {
      where: {
        value: { id: "user-1" },
        enumerable: true,
        writable: false,
      },
      cache: {
        get: () => ({ autoInvalidate: true, invalidate: ["posts:*"] }),
        enumerable: false,
      },
    });
    Object.defineProperty(input, symbolKey, {
      value: "kept",
      enumerable: false,
    });

    const prepared = prepareMutationCacheInput("update", input);

    expect(prepared.options).toEqual({
      autoInvalidate: true,
      invalidate: ["posts:*"],
    });
    expect(Object.isFrozen(prepared.options)).toBe(true);
    expect(Reflect.ownKeys(prepared.args)).toEqual(["where", symbolKey]);
    expect(Object.getOwnPropertyDescriptor(prepared.args, "where")).toEqual(
      Object.getOwnPropertyDescriptor(input, "where")
    );
    // `PreparedMutationCacheInput.args` is a `Record<string, unknown>`; the
    // symbol-keyed property it copied verbatim is read through the intrinsic.
    expect(Reflect.get(prepared.args, symbolKey)).toBe("kept");
  });

  test("preserves identity when no client-owned cache option is present", () => {
    const readInput = { where: { id: "user-1" }, cache: { bypass: true } };
    const writeInput = { where: { id: "user-1" }, data: { name: "next" } };

    expect(prepareMutationCacheInput("findMany", readInput)).toEqual({
      args: readInput,
      options: undefined,
    });
    expect(prepareMutationCacheInput("update", writeInput)).toEqual({
      args: writeInput,
      options: undefined,
    });
  });

  test("reports hostile reflection, access, and validation at the cache boundary", () => {
    const reflectionFailure = new Error("reflection failed");
    const hostileInput = new Proxy(
      {},
      {
        ownKeys() {
          throw reflectionFailure;
        },
      }
    );
    expect(() => prepareMutationCacheInput("update", hostileInput)).toThrow(
      CacheConfigurationError
    );

    const readFailure = new Error("cache getter failed");
    const accessorInput = {
      get cache(): unknown {
        throw readFailure;
      },
    };
    expect(() => prepareMutationCacheInput("delete", accessorInput)).toThrow(
      CacheConfigurationError
    );

    expect(() =>
      prepareMutationCacheInput("create", {
        data: { id: "user-1" },
        cache: { autoInvalidate: "yes" },
      })
    ).toThrow(CacheConfigurationError);

    expect(
      prepareMutationCacheInput("create", {
        data: { id: "user-1" },
        cache: undefined,
      })
    ).toEqual({ args: { data: { id: "user-1" } }, options: undefined });
  });

  // `instanceof` walks the LEFT operand's prototype chain, so every predicate
  // the cache boundary points at a caught value is itself a throw site once that
  // value is a Proxy with a hostile `getPrototypeOf` trap. The two tests below
  // pin both predicates on that path — `isError` (reached with no seam at all)
  // and `isCacheConfigurationError` — because an escaping trap replaces the
  // typed cache failure with the attacker's raw exception.
  test("a hostile getPrototypeOf trap cannot replace the cache-read refusal", () => {
    const trapFailure = new Error("getPrototypeOf trap fired");
    let trapCalls = 0;
    const hostileThrown = new Proxy(trapFailure, {
      getPrototypeOf() {
        trapCalls += 1;
        throw trapFailure;
      },
    });

    let thrown: unknown;
    try {
      prepareMutationCacheInput("delete", {
        get cache(): unknown {
          throw hostileThrown;
        },
      });
    } catch (error) {
      thrown = error;
    }

    // Production code really did consult the hostile prototype chain, so the
    // assertions below cannot pass vacuously.
    expect(trapCalls).toBeGreaterThan(0);
    expect(thrown).toBeInstanceOf(CacheConfigurationError);
    expect(thrown).not.toBe(trapFailure);
    const failure = thrown as CacheConfigurationError;
    expect(failure.message).toBe(
      "Mutation cache options for 'delete' could not be read."
    );
    expect(failure.code).toBe(VibORMErrorCode.CACHE_CONFIGURATION);
  });

  test("a hostile getPrototypeOf trap cannot replace the cache-validation refusal", () => {
    const trapFailure = new Error("getPrototypeOf trap fired");
    let trapCalls = 0;
    const hostileThrown = new Proxy(trapFailure, {
      getPrototypeOf() {
        trapCalls += 1;
        throw trapFailure;
      },
    });
    const hostileParseOutput = {
      autoInvalidate: false,
      get invalidate(): unknown {
        throw hostileThrown;
      },
    };

    // `parse()` contains everything thrown INSIDE validation, so the only value
    // `parseMutationCacheOptions` can catch that it did not itself create is one
    // it reads back OUT of the parse result. Substituting the Standard Schema
    // validator puts the hostile value on exactly that seam; every line of
    // cache-flow.ts below it — the catch, the classifier, the wrapper — runs
    // unmodified.
    const standard = cacheInvalidationSchema["~standard"] as unknown as {
      validate: (value: unknown) => unknown;
    };
    const originalValidate = standard.validate;
    standard.validate = () => ({ value: hostileParseOutput });

    let thrown: unknown;
    try {
      prepareMutationCacheInput("update", {
        where: { id: "user-1" },
        cache: { autoInvalidate: true },
      });
    } catch (error) {
      thrown = error;
    } finally {
      standard.validate = originalValidate;
    }

    expect(trapCalls).toBeGreaterThan(0);
    expect(thrown).toBeInstanceOf(CacheConfigurationError);
    expect(thrown).not.toBe(trapFailure);
    const failure = thrown as CacheConfigurationError;
    expect(failure.message).toBe(
      "Mutation cache options for 'update' could not be validated."
    );
    expect(failure.code).toBe(VibORMErrorCode.CACHE_CONFIGURATION);
  });

  test("normalizes cache execution options and cacheability", () => {
    const attributes = { "db.system.name": "postgresql" };
    const waitUntil = vi.fn();

    expect(
      createCacheExecutionOptions(undefined, waitUntil, attributes)
    ).toEqual({
      ttlMs: 300_000,
      swr: false,
      bypass: false,
      key: undefined,
      waitUntil,
      dbAttributes: attributes,
    });
    expect(
      createCacheExecutionOptions(
        { ttl: 1000, swr: true, bypass: true, key: "mine" },
        undefined,
        attributes
      )
    ).toMatchObject({ ttlMs: 1000, swr: 2000, bypass: true, key: "mine" });
    expect(
      createCacheExecutionOptions(
        { ttl: "2 seconds", swr: "3 seconds" },
        undefined,
        attributes
      )
    ).toMatchObject({ ttlMs: 2000, swr: 5000 });
    expect(() =>
      createCacheExecutionOptions({ ttl: "never" }, undefined, attributes)
    ).toThrow(CacheConfigurationError);

    for (const operation of [
      "findFirst",
      "findMany",
      "findUnique",
      "findUniqueOrThrow",
      "findFirstOrThrow",
      "count",
      "aggregate",
      "groupBy",
      "exist",
    ]) {
      expect(() => validateCacheableOperation(operation)).not.toThrow();
    }
    expect(() => validateCacheableOperation("create")).toThrow(
      CacheOperationNotCacheableError
    );
    expect(isCacheManagedExecution(undefined)).toBe(false);
    expect(isCacheManagedExecution({ skipSpan: true })).toBe(true);
    expect(isCacheManagedExecution({ skipSpan: false })).toBe(false);
  });

  test("delegates cached reads and explicit invalidation through the official scope", async () => {
    const cache = new RecordingMemoryCache();
    const scope = createOfficialCacheScope(CACHE_NAMESPACE);
    const executor = vi.fn(() => Promise.resolve({ id: "user-1" }));
    const codec = {
      snapshot: (value: unknown) => value,
      materialize: (value: unknown) => value,
    };
    const options = createCacheExecutionOptions({ ttl: 1000 }, undefined, {
      "db.system.name": "postgresql",
    });

    await expect(
      executeCachedResultOperation(
        cache,
        "user",
        "findUnique",
        { where: { id: "user-1" } },
        executor,
        options,
        codec,
        scope
      )
    ).resolves.toEqual({ id: "user-1" });
    await expect(
      executeCachedResultOperation(
        cache,
        "user",
        "findUnique",
        { where: { id: "user-1" } },
        executor,
        options,
        codec,
        scope
      )
    ).resolves.toEqual({ id: "user-1" });
    expect(executor).toHaveBeenCalledOnce();

    await invalidateManualCache(cache, ["user:*"], undefined, scope);
    expect(cache.clearedPrefixes).toContain(`${CACHE_NAMESPACE}:user:`);
  });

  test("registers mutation invalidation only for writes and preserves failure evidence", async () => {
    const cache = new RecordingMemoryCache();
    const scope = createOfficialCacheScope(CACHE_NAMESPACE);
    const context = { model: "user", operation: "update" };
    const readOptions = vi.fn(() => ({ autoInvalidate: true }));

    expect(
      prepareMutationCacheWriteOutcome(
        cache,
        "user",
        "findMany",
        readOptions,
        context,
        scope
      )
    ).toBeUndefined();
    expect(readOptions).not.toHaveBeenCalled();

    const registration = prepareMutationCacheWriteOutcome(
      cache,
      "user",
      "update",
      readOptions,
      context,
      scope
    );
    if (registration === undefined) throw new Error("Expected cache listener");
    await registration.listener({ certainty: "committed" });
    expect(cache.clearedPrefixes).toContain(`${CACHE_NAMESPACE}:user:`);

    cache.clearFailure = "storage offline";
    await expect(
      registration.listener({ certainty: "committed" })
    ).rejects.toMatchObject({
      name: "CacheConfigurationError",
      meta: {
        method: "invalidate",
        model: "user",
        operation: "update",
        commitCertainty: "committed",
      },
      originalCause: expect.objectContaining({
        message: "Underlying error details redacted",
        name: "Error",
      }),
    });
  });
});

describe("query-engine operation attribution", () => {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const schema = { user };
  hydrateSchemaNames(schema);

  test("creates immutable pending attribution with stable client and scope identity", () => {
    const clientId = Symbol("client");
    const scopeId = Symbol("scope");
    const pending = createPendingOperationContext(
      "user",
      "findMany",
      undefined,
      clientId,
      scopeId
    );

    expect(pending).toEqual({
      clientId,
      scopeId,
      attribution: expect.objectContaining({
        model: "user",
        operation: "findMany",
        correlationId: expect.any(String),
      }),
    });
    expect(Object.isFrozen(pending)).toBe(true);
  });

  test("publishes official span and failure-log facts for model and raw operations", () => {
    const extension = instrumentation({
      tracing: true,
      logging: { error: true, cache: true },
    });
    const chain = appendResolvedExtension(undefined, extension, schema);
    const driver = new PlanningDriver("postgresql");
    const modelContext = createOperationExecutionContext(
      "user",
      "findMany",
      undefined,
      chain
    );
    const rawContext = createOperationExecutionContext(
      "$raw",
      "$queryRaw",
      undefined,
      chain
    );

    const modelReader = createPendingOperationInstrumentationFacts(
      driver,
      modelContext,
      "user",
      "findMany",
      "findMany",
      "users",
      false
    );
    const rawReader = createRawOperationInstrumentationFacts(
      driver,
      rawContext,
      "$queryRaw"
    );
    if (modelReader === undefined || rawReader === undefined) {
      throw new Error("Expected official instrumentation facts");
    }
    const modelFacts = modelReader();
    const rawFacts = rawReader();
    if (modelFacts?.kind !== "operation" || rawFacts?.kind !== "operation") {
      throw new Error("Expected operation facts");
    }

    expect(modelFacts.spanOptions).toMatchObject({
      attributes: {
        "db.collection.name": "users",
        "db.operation.name": "findMany",
      },
    });
    expect(rawFacts.spanOptions).toMatchObject({
      attributes: { "db.operation.name": "$queryRaw" },
    });
    expect(
      modelFacts.complete({ status: "success", durationMs: 1 })
    ).toBeUndefined();

    const failure = new Error("query failed");
    expect(
      modelFacts.complete({ status: "failure", durationMs: 7, failure })
    ).toMatchObject({
      kind: "operation",
      errorLogEvent: {
        model: "user",
        operation: "findMany",
        duration: 7,
      },
    });
    markErrorLogged(failure);
    expect(
      modelFacts.complete({ status: "failure", durationMs: 8, failure })
    ).toBeUndefined();
  });

  test("does not publish facts without the official observing chain", () => {
    const driver = new PlanningDriver("postgresql");
    const context = createOperationExecutionContext("user", "findMany");
    expect(
      createPendingOperationInstrumentationFacts(
        driver,
        context,
        "user",
        "findMany",
        "findMany",
        "users",
        false
      )
    ).toBeUndefined();
    expect(
      createRawOperationInstrumentationFacts(driver, context, "$queryRaw")
    ).toBeUndefined();
  });

  test("normalizes native batch preparation failures with operation attribution", async () => {
    const driver = new PlanningDriver("postgresql", { driverName: "recorder" });
    const context = createOperationExecutionContext("user", "createMany");
    const providerFailure = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "users_pkey",
    });

    await expect(
      observeTransactionBatchPhase(context, driver, () => "prepared")
    ).resolves.toBe("prepared");
    await expect(
      observeTransactionBatchPhase(context, driver, () => {
        throw providerFailure;
      })
    ).rejects.toMatchObject({
      name: "UniqueConstraintError",
      meta: expect.objectContaining({
        driver: "recorder",
        model: "user",
        operation: "createMany",
      }),
    });
  });
});

describe("query-engine registry and validation routing", () => {
  test("indexes models by public and mapped table names and preserves engine scope facts", () => {
    const user = s
      .model({ id: s.string().id(), name: s.string() })
      .map("mapped_users");
    const schema = { user };
    hydrateSchemaNames(schema);
    const schemas = createSchemaRegistry(schema);
    const registry = createModelRegistry(schema, schemas);
    const driver = new PlanningDriver("postgresql", {
      maxBindParametersPerStatement: 32,
    });
    const engine = new QueryEngine(driver, registry);

    expect(registry.get("user")).toBe(user);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.getByTableName("mapped_users")).toBe(user);
    expect(registry.getByTableName("users")).toBeUndefined();
    expect(engine.adapter).toBe(driver.adapter);
    expect(engine.relations).toBe(registry.relations);
    expect(engine.schemaRegistry).toBe(schemas);
    expect(engine.maxBindParametersPerStatement).toBe(32);

    const boundDriver = new PlanningDriver("mysql");
    const bound = engine.bind(boundDriver);
    expect(bound.clientId).toBe(engine.clientId);
    expect(bound.scopeId).not.toBe(engine.scopeId);
    expect(bound.driver).toBe(boundDriver);
    expect(bound.registry).toBe(registry);
  });

  test("routes each mutation family to its one public operation schema", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const registry = createSchemaRegistry(schema);

    expect(
      validate(registry, user, "create", {
        data: { id: "user-1", name: "first" },
      })
    ).toEqual({ data: { id: "user-1", name: "first" } });
    expect(
      validate(registry, user, "update", {
        where: { id: "user-1" },
        data: { name: "next" },
      })
    ).toEqual({
      where: { id: "user-1" },
      data: { name: { set: "next" } },
      select: undefined,
      include: undefined,
      omit: undefined,
    });
    expect(
      validate(registry, user, "delete", { where: { id: "user-1" } })
    ).toEqual({ where: { id: "user-1" } });
    expect(
      validate(registry, user, "upsert", {
        where: { id: "user-1" },
        create: { id: "user-1", name: "created" },
        update: { name: "updated" },
      })
    ).toEqual({
      where: { id: "user-1" },
      create: { id: "user-1", name: "created" },
      update: { name: { set: "updated" } },
      select: undefined,
      include: undefined,
      omit: undefined,
      setWhere: undefined,
      targetWhere: undefined,
    });
  });
});

describe("skippable write savepoint semantics", () => {
  test("returns the successful savepoint result unchanged", async () => {
    const driver = new SkippablePlanningDriver("postgresql");
    const result = await executeSkippableWrite(
      driver,
      sql.raw`INSERT INTO users DEFAULT VALUES`,
      { model: "user", operation: "createMany" }
    );

    expect(result).toEqual({ rows: [], rowCount: 1 });
    expect(driver.transactionCount).toBe(1);
    expect(driver.executionCount).toBe(1);
  });

  test("converts only a typed unique conflict to the skipped-row result", async () => {
    const duplicateDriver = new SkippablePlanningDriver("postgresql");
    duplicateDriver.executionFailure = new UniqueConstraintError("duplicate");
    await expect(
      executeSkippableWrite(duplicateDriver, sql.raw`INSERT DUPLICATE`, {
        operation: "createMany",
      })
    ).resolves.toEqual({ rows: [], rowCount: 0 });

    const unrelatedFailure = new Error("connection lost");
    const failingDriver = new SkippablePlanningDriver("postgresql");
    failingDriver.executionFailure = unrelatedFailure;
    await expect(
      executeSkippableWrite(failingDriver, sql.raw`INSERT FAILS`, {
        operation: "createMany",
      })
    ).rejects.toBe(unrelatedFailure);
  });
});

describe("coverage low value", () => {
  test("uses the correlation fallback when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Date, "now").mockReturnValue(1234);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(createCorrelationId()).toBe("ya-i");
  });

  test("refuses unregistered and hostile transaction-operation candidates", () => {
    expect(() => transactionOperationOwner(Object.freeze({}))).toThrow();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype denied");
        },
      }
    );
    expect(readTransactionOperation(hostile)).toBeUndefined();
  });

  test("reports an operation name that has no registered validation schema", () => {
    const model = s.model({ id: s.string().id() });
    const schema = { model };
    hydrateSchemaNames(schema);
    const registry = createSchemaRegistry(schema);

    expect(() =>
      Reflect.apply(validate, undefined, [registry, model, "missing", {}])
    ).toThrow(MISSING_OPERATION_SCHEMA_PATTERN);
  });

  test("refuses a query engine registry without an operation schema owner", () => {
    expect(() =>
      Reflect.construct(QueryEngine, [
        new PlanningDriver("postgresql"),
        Object.freeze({}),
      ])
    ).toThrow("Schema registry is required for query engine");
  });
});
