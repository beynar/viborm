import { createOfficialCacheScope } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { createOfficialCacheNamespace } from "@cache/key";
import { PendingOperation as ClientPendingOperation } from "@client/exports";
import {
  CacheConfigurationError,
  InvalidTransactionInputError,
  PendingOperationError,
  ValidationError,
} from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import {
  executePreparedQuery,
  TransactionWriteOutcomes,
  type WriteOutcomeNotifications,
  type WriteOutcomeRegistration,
} from "@extensions/query";
import { prepareMutationCacheWriteOutcome } from "@query-engine/cache-flow";
import { PendingExecution } from "@query-engine/pending-execution";
import {
  attachPendingCacheExecution,
  PendingOperation,
  type PrepareWriteOutcomeRegistration,
} from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  readTransactionOperation,
  type TransactionOperationCapability,
  type TransactionOperationOwner,
} from "@query-engine/transaction-operation";
import { hydrateSchemaNames, s } from "@schema";
import { PendingOperation as RootPendingOperation } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import {
  readTestTransactionOperation,
  type TestTransactionOperationView,
} from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it, vi } from "vitest";

const VALID_UPDATE_ARGS = {
  where: { id: "user-1" },
  data: { name: "Updated" },
};

const OFFICIAL_CACHE_NAMESPACE = createOfficialCacheNamespace({
  version: "pending-operation-contract",
  dialect: "postgresql",
  namespace: "public",
});
const OFFICIAL_CACHE_SCOPE = createOfficialCacheScope(OFFICIAL_CACHE_NAMESPACE);
const USER_CACHE_PREFIX = `${OFFICIAL_CACHE_NAMESPACE}:user:`;
const NO_VALIDATED_PAYLOAD_PATTERN = /exposes no validated payload/;
const UNKNOWN_OPERATION_PATTERN = /Unknown operation 'missing'/;

class RecordingMemoryCache extends MemoryCache {
  readonly clearedPrefixes: string[] = [];
  private readonly clearFailure: Error | undefined;

  constructor(clearFailure?: Error) {
    super();
    this.clearFailure = clearFailure;
  }

  protected override async clear(prefix: string): Promise<void> {
    this.clearedPrefixes.push(prefix);
    if (this.clearFailure) throw this.clearFailure;
    return super.clear(prefix);
  }
}

function createOperation<T>(
  operation: "findMany" | "update" = "findMany",
  args: Record<string, unknown> = {},
  prepareWriteOutcome?: PrepareWriteOutcomeRegistration
): PendingOperation<T> {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const schema = { user };
  hydrateSchemaNames(schema);
  const engine = new QueryEngine(
    new PlanningDriver("postgresql"),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  return engine.prepare<T>(
    user,
    operation,
    args,
    undefined,
    undefined,
    prepareWriteOutcome
  );
}

function createControlledOperation<T>(
  value: T,
  operation: "findMany" | "update" = "findMany",
  prepareWriteOutcome?: PrepareWriteOutcomeRegistration
): { operation: PendingOperation<T>; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(() => Promise.resolve(value));
  return {
    operation: attachPendingCacheExecution(
      createOperation<T>(
        operation,
        operation === "update" ? VALID_UPDATE_ARGS : {},
        prepareWriteOutcome
      ),
      () => execute()
    ),
    execute,
  };
}

function capability(operation: unknown): TestTransactionOperationView {
  const value = readTestTransactionOperation(operation);
  if (value === undefined) throw new Error("Expected pending operation");
  return value;
}

function ownerOf(
  operation: object
): TransactionOperationOwner<TransactionOperationCapability> {
  const owner = readTransactionOperation(operation);
  if (owner === undefined) throw new Error("Expected transaction owner");
  return owner;
}

describe("PendingOperation frozen public contract", () => {
  it("keeps construction and authority state behind the module factory", () => {
    const operation = createOperation<unknown>();
    const operationCapability = capability(operation);

    expect(Object.isFrozen(operation)).toBe(true);
    const prototype = Reflect.getPrototypeOf(operation);
    if (prototype === null) throw new Error("Expected operation prototype");
    expect(Object.isFrozen(prototype)).toBe(true);
    const originalThen = Reflect.get(prototype, "then");
    expect(typeof originalThen).toBe("function");
    expect(Reflect.defineProperty(prototype, "then", { value: vi.fn() })).toBe(
      false
    );
    expect(Reflect.get(prototype, "then")).toBe(originalThen);
    expect(Reflect.get(PendingOperation, "create")).toBeUndefined();
    for (const name of [
      "resolveArgs",
      "resolveWriteOutcomeRegistration",
      "resolveOperation",
      "statementOperation",
      "executor",
      "resolveSinglePlan",
      "getPromise",
      "observeLogicalOperation",
      "runExecution",
      "observationNotification",
      "runCoreExecution",
      "run",
      "wrapExecution",
    ]) {
      const helper = Reflect.get(operation, name);
      expect(helper).toBeUndefined();
      expect(() => {
        if (typeof helper !== "function") {
          throw new TypeError("Private helper is not callable");
        }
        Reflect.apply(helper, operation, []);
      }).toThrow(TypeError);
    }
    for (const key of [
      "engine",
      "model",
      "args",
      "modelName",
      "operation",
      "options",
      "execution",
      "operationExecutor",
      "context",
    ]) {
      expect(Reflect.set(operation, key, "forged")).toBe(false);
      expect(Reflect.defineProperty(operation, key, { value: "forged" })).toBe(
        false
      );
    }
    expect(capability(operation).clientId).toBe(operationCapability.clientId);
    expect(capability(operation).scopeId).toBe(operationCapability.scopeId);

    const reflectedConstructor = Reflect.get(operation, "constructor");
    if (typeof reflectedConstructor !== "function") {
      throw new Error("Expected PendingOperation constructor");
    }
    expect(() => Reflect.construct(reflectedConstructor, [])).toThrow(
      InvalidTransactionInputError
    );
  });

  it("preserves client identity and mints transaction scope identity", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    const engine = new QueryEngine(new PlanningDriver("postgresql"), registry);
    const transactionDriver = new PlanningDriver("postgresql");
    const transactionEngine = engine.bind(transactionDriver);

    expect(transactionEngine.clientId).toBe(engine.clientId);
    expect(transactionEngine.scopeId).not.toBe(engine.scopeId);
    expect(transactionEngine.driver).toBe(transactionDriver);
    expect(transactionEngine.registry).toBe(registry);
  });

  it("defers validation and execution until an execution or preparation method is used", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const engine = new QueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );

    let operation: PendingOperation<unknown> | undefined;
    expect(() => {
      // A schema-invalid payload (id must be a string): the engine constructs the
      // deferred operation without validating, so creation does not throw.
      operation = engine.prepare(user, "create", { data: { id: 123 } });
    }).not.toThrow();

    if (operation === undefined) throw new Error("Expected pending operation");
    expect(() => capability(operation).prepare()).toThrow(ValidationError);
    await expect(operation).rejects.toBeInstanceOf(ValidationError);
  });

  it("memoizes one execution across then, catch, finally, and execute", async () => {
    const { operation, execute } = createControlledOperation(42);
    const finalized = vi.fn();

    await expect(
      Promise.all([
        operation.then((value) => value),
        operation.catch(() => -1),
        operation.finally(finalized),
        Promise.resolve(operation),
      ])
    ).resolves.toEqual([42, 42, 42, 42]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveBeenCalledTimes(1);
  });

  it("memoizes executeWith for the same driver", async () => {
    const driver = new PlanningDriver("postgresql");
    const { operation, execute } = createControlledOperation(42);

    const first = capability(operation).executeWith(driver);
    const second = capability(operation).executeWith(driver);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects default execution after driver-bound execution", () => {
    const { operation } = createControlledOperation(42);
    capability(operation).executeWith(new PlanningDriver("postgresql"));
    expect(() => operation.then((value) => value)).toThrow(
      PendingOperationError
    );
  });

  it("rejects driver-bound execution after default execution", () => {
    const { operation } = createControlledOperation(42);
    operation.then((value) => value);
    expect(() =>
      capability(operation).executeWith(new PlanningDriver("postgresql"))
    ).toThrow(PendingOperationError);
  });

  it("rejects a second, different driver", () => {
    const { operation } = createControlledOperation(42);
    capability(operation).executeWith(new PlanningDriver("postgresql"));
    expect(() =>
      capability(operation).executeWith(new PlanningDriver("postgresql"))
    ).toThrow(PendingOperationError);
  });

  it("prepares directly and as a bulk batch without executing", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const driver = new PlanningDriver("postgresql");
    const engine = new QueryEngine(
      driver,
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const direct = engine.prepare(user, "findMany", {});
    const bulk = engine.prepare(user, "createMany", {
      data: [{ id: "user-1", name: "Arnaud" }],
    });

    const directCapability = capability(direct);
    expect(directCapability.prepare(driver)).toMatchObject({
      sql: expect.any(String),
      params: expect.any(Array),
      context: directCapability.context,
    });
    await expect(capability(bulk).prepareBatch(driver)).resolves.toMatchObject({
      queries: expect.any(Array),
      parseResult: expect.any(Function),
    });
  });

  it("preserves raw arguments, identity, attribution, and result parsing", () => {
    const args = { where: { id: "user-1" } };
    const operation = createOperation<Array<{ id: string; name: string }>>(
      "findMany",
      args
    );
    const raw = {
      rows: [{ id: "user-1", name: "Arnaud" }],
      rowCount: 1,
    };
    const operationCapability = capability(operation);

    expect(operation.getArgs()).toBe(args);
    expect(operationCapability.model).toBe("user");
    expect(operationCapability.operation).toBe("findMany");
    expect(typeof operationCapability.clientId).toBe("symbol");
    expect(typeof operationCapability.scopeId).toBe("symbol");
    expect(Object.isFrozen(operationCapability.context)).toBe(true);
    expect(operationCapability.context).toBe(capability(operation).context);
    expect(operationCapability.parseResult(raw)).toEqual(raw.rows);
  });

  it("the internal cache execution attachment is immutable and composes", async () => {
    const source = vi.fn(() => Promise.resolve(42));
    const original = attachPendingCacheExecution(
      createOperation<number>(),
      () => source()
    );
    const wrapper = vi.fn(async (execute: () => Promise<number>) => {
      const value = await execute();
      return value + 1;
    });
    const wrapped = attachPendingCacheExecution(original, wrapper);

    expect(wrapped).not.toBe(original);
    await expect(
      capability(wrapped).executeWith(new PlanningDriver("postgresql"))
    ).resolves.toBe(43);
    expect(wrapper).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledOnce();
    expect(original.getArgs()).toBe(wrapped.getArgs());
    expect(capability(original).context).toBe(capability(wrapped).context);
    expect(capability(original).clientId).toBe(capability(wrapped).clientId);
    expect(capability(original).scopeId).toBe(capability(wrapped).scopeId);
  });

  it("publishes mutation cache invalidation after successful execution", async () => {
    const cache = new RecordingMemoryCache();
    const prepareWriteOutcome: PrepareWriteOutcomeRegistration = (context) =>
      prepareMutationCacheWriteOutcome(
        cache,
        "user",
        "update",
        () => ({ autoInvalidate: true }),
        context,
        OFFICIAL_CACHE_SCOPE
      );
    const mutation = createControlledOperation(
      42,
      "update",
      prepareWriteOutcome
    ).operation;

    await expect(mutation).resolves.toBe(42);
    expect(cache.clearedPrefixes).toEqual([USER_CACHE_PREFIX]);

    expect(
      prepareMutationCacheWriteOutcome(
        cache,
        "user",
        "findMany",
        () => ({ autoInvalidate: true }),
        capability(mutation).context,
        OFFICIAL_CACHE_SCOPE
      )
    ).toBeUndefined();
  });

  it("preserves mutation failures without invalidating cache", async () => {
    const failure = new Error("mutation failed");
    const cache = new RecordingMemoryCache();
    const mutation = attachPendingCacheExecution(
      createOperation<number>("update", VALID_UPDATE_ARGS, (context) =>
        prepareMutationCacheWriteOutcome(
          cache,
          "user",
          "update",
          () => ({ autoInvalidate: true }),
          context,
          OFFICIAL_CACHE_SCOPE
        )
      ),
      () => Promise.reject(failure)
    );

    const caught = await mutation.catch((error) => error);
    expect(caught).toBe(failure);
    expect(cache.clearedPrefixes).toEqual([]);
  });

  it("publishes package registrations for every direct committed segment", async () => {
    const cache = new RecordingMemoryCache();
    const context = capability(createOperation("update")).context;
    const registration = prepareMutationCacheWriteOutcome(
      cache,
      "user",
      "update",
      () => ({ autoInvalidate: true }),
      context,
      OFFICIAL_CACHE_SCOPE
    );

    await expect(
      executePreparedQuery(
        undefined,
        undefined,
        async (notifications) => {
          await notifications?.committed();
          await notifications?.committed();
          return 42;
        },
        true,
        undefined,
        undefined,
        registration
      )
    ).resolves.toBe(42);
    expect(cache.clearedPrefixes).toEqual([
      USER_CACHE_PREFIX,
      USER_CACHE_PREFIX,
    ]);
  });

  it("owns cache invalidation failures instead of leaking a raw error", async () => {
    const failure = new Error("cache transport failed");
    const cache = new RecordingMemoryCache(failure);
    const mutation = createControlledOperation(42, "update", (context) =>
      prepareMutationCacheWriteOutcome(
        cache,
        "user",
        "update",
        () => ({ autoInvalidate: true }),
        context,
        OFFICIAL_CACHE_SCOPE
      )
    ).operation;

    const caught = await mutation.catch((error) => error);
    expect(caught).toBeInstanceOf(CacheConfigurationError);
    if (!(caught instanceof CacheConfigurationError)) throw caught;
    expect(caught).toMatchObject({
      meta: {
        method: "invalidate",
        model: "user",
        operation: "update",
        commitCertainty: "committed",
      },
    });
    expect(caught.originalCause).toBeInstanceOf(Error);
    expect(cache.clearedPrefixes).toEqual([USER_CACHE_PREFIX]);
  });

  it("keeps PendingOperation as the root and client runtime export", () => {
    expect(RootPendingOperation).toBe(PendingOperation);
    expect(ClientPendingOperation).toBe(PendingOperation);
  });
});

describe("pending execution ownership", () => {
  it("memoizes default and same-driver execution while excluding the other authority", async () => {
    const execution = new PendingExecution<number>("user", "findMany");
    const run = vi.fn(() => Promise.resolve(42));
    const first = execution.executeDefault(run);
    const second = execution.executeDefault(run);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(() =>
      execution.executeWith(new PlanningDriver("postgresql"), run)
    ).toThrow(PendingOperationError);
  });

  it("memoizes one driver and refuses a different driver or default execution", async () => {
    const driver = new PlanningDriver("postgresql");
    const execution = new PendingExecution<number>("user", "findMany");
    const run = vi.fn(() => Promise.resolve(42));
    const first = execution.executeWith(driver, run);
    const second = execution.executeWith(driver, run);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(() => execution.executeDefault(run)).toThrow(PendingOperationError);
    expect(() =>
      execution.executeWith(new PlanningDriver("postgresql"), run)
    ).toThrow(PendingOperationError);
  });

  it("reserves exactly one driver for an array coordinator and runs its child once", async () => {
    const driver = new PlanningDriver("postgresql");
    const execution = new PendingExecution<number>("user", "findMany");
    const run = vi.fn(() => Promise.resolve(42));
    execution.reserveWith(driver);

    const first = execution.executeReserved(run);
    const second = execution.executeReserved(run);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(() => execution.executeWith(driver, run)).toThrow(
      PendingOperationError
    );
  });

  it("refuses reservation after either execution authority was selected", () => {
    const driver = new PlanningDriver("postgresql");
    const defaultExecution = new PendingExecution<number>("user", "findMany");
    defaultExecution.executeDefault(() => Promise.resolve(1));
    expect(() => defaultExecution.reserveWith(driver)).toThrow(
      PendingOperationError
    );

    const driverExecution = new PendingExecution<number>("user", "findMany");
    driverExecution.executeWith(driver, () => Promise.resolve(1));
    expect(() => driverExecution.reserveWith(driver)).toThrow(
      PendingOperationError
    );
    expect(() =>
      driverExecution.reserveWith(new PlanningDriver("postgresql"))
    ).toThrow(PendingOperationError);
  });
});

describe("pending operation transaction coordination", () => {
  it("publishes the exact operation authority through the registered owner", async () => {
    const read = createOperation<unknown>();
    const write = createOperation<unknown>("update", VALID_UPDATE_ARGS);
    const readOwner = ownerOf(read);
    const writeOwner = ownerOf(write);

    expect(readOwner.clientId(read)).toBe(capability(read).clientId);
    expect(readOwner.scopeId(read)).toBe(capability(read).scopeId);
    expect(readOwner.model(read)).toBe("user");
    expect(readOwner.operation(read)).toBe("findMany");
    expect(readOwner.context(read)).toBe(capability(read).context);
    expect(readOwner.isWrite(read)).toBe(false);
    expect(writeOwner.isWrite(write)).toBe(true);
    expect(readOwner.requiresInterception(read)).toBe(false);
    expect(readOwner.hasObservation(read)).toBe(false);
    await expect(
      readOwner.observe(read, () => Promise.resolve("child"))
    ).resolves.toBe("child");
  });

  it("resolves request preparation once and rethrows the same preparation failure", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const engine = new QueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const prepareInput = vi.fn(() => ({ where: { id: "user-1" } }));
    const prepared = engine.prepare(
      user,
      "findMany",
      {},
      undefined,
      prepareInput
    );
    const preparedOwner = ownerOf(prepared);

    preparedOwner.prepareAdmission(prepared);
    preparedOwner.prepareAdmission(prepared);
    expect(prepareInput).toHaveBeenCalledOnce();

    const failure = new Error("request preparation failed");
    const failInput = vi.fn(() => {
      throw failure;
    });
    const failed = engine.prepare(user, "findMany", {}, undefined, failInput);
    const failedOwner = ownerOf(failed);
    expect(() => failedOwner.prepareAdmission(failed)).toThrow(failure);
    expect(() => failedOwner.prepareAdmission(failed)).toThrow(failure);
    expect(failInput).toHaveBeenCalledOnce();
  });

  it("stages one package listener and coordinates it through an array child", async () => {
    const listener = vi.fn();
    const registration: WriteOutcomeRegistration = Object.freeze({
      extension: "package-listener",
      failurePolicy: "boundary-owned",
      listener,
    });
    const prepareRegistration = vi.fn(() => registration);
    const operation = createOperation<unknown>(
      "update",
      VALID_UPDATE_ARGS,
      prepareRegistration
    );
    const owner = ownerOf(operation);
    const outcomes = new TransactionWriteOutcomes();

    expect(owner.requiresInterception(operation)).toBe(true);
    owner.prepareAdmission(operation);
    owner.stagePackageWriteOutcomes(operation, outcomes);
    owner.stagePackageWriteOutcomes(operation, outcomes);
    expect(prepareRegistration).toHaveBeenCalledOnce();

    const child = vi.fn(async (notifications?: WriteOutcomeNotifications) => {
      await notifications?.committed();
      return "child";
    });
    await expect(
      owner.startInterception(operation, child, outcomes, {})
    ).resolves.toBe("child");
    outcomes.confirm([registration]);
    await outcomes.publishCommitted();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("runs query interception and observation through the owner without provider work", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const queryHandler = vi.fn(
      async (context: { proceed(): Promise<unknown> }) => context.proceed()
    );
    const observer = vi.fn((_unit: unknown, proceed: () => Promise<unknown>) =>
      proceed()
    );
    const chain = appendResolvedExtension(
      appendResolvedExtension(
        undefined,
        { name: "query-owner", query: queryHandler },
        schema
      ),
      { name: "observer-owner", observe: observer },
      schema
    );
    const engine = new QueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema)),
      undefined,
      undefined,
      chain
    );
    const source = engine.prepare<unknown>(user, "findMany", {});
    const operation = attachPendingCacheExecution(source, () =>
      Promise.resolve("executed")
    );
    const owner = ownerOf(operation);

    expect(owner.requiresInterception(operation)).toBe(true);
    expect(owner.hasObservation(operation)).toBe(true);
    await expect(
      owner.startInterception(
        operation,
        () => Promise.resolve("intercepted"),
        new TransactionWriteOutcomes(),
        {}
      )
    ).resolves.toBe("intercepted");
    expect(queryHandler).toHaveBeenCalledOnce();
    await expect(
      owner.observe(operation, () => Promise.resolve("observed"))
    ).resolves.toBe("observed");
    await expect(
      owner.executeWith(operation, new PlanningDriver("postgresql"))
    ).resolves.toBe("executed");
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("requires observed coordination for request-only array transforms", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const chain = appendResolvedExtension(
      appendResolvedExtension(
        undefined,
        { name: "request-owner", request: () => ({}) },
        schema
      ),
      { name: "observer-owner", observe: () => undefined },
      schema
    );
    const engine = new QueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema)),
      undefined,
      undefined,
      chain
    );
    const operation = engine.prepare(user, "findMany", {});

    expect(ownerOf(operation).requiresInterception(operation)).toBe(true);
  });

  it("exposes canonical cache input only for read operations", () => {
    const read = createOperation<unknown>("findMany", {
      where: { name: { equals: "Arnaud" } },
    });
    const write = createOperation<unknown>("update", VALID_UPDATE_ARGS);

    expect(read.cacheKeyArgs()).toEqual({
      where: { name: { equals: "Arnaud" } },
    });
    expect(() => write.cacheKeyArgs()).toThrow(NO_VALIDATED_PAYLOAD_PATTERN);
  });

  it("normalizes OrThrow operation identity and refuses unknown routed names", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const engine = new QueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const orThrow = engine.prepare(user, "findFirstOrThrow", {});

    expect(ownerOf(orThrow).operation(orThrow)).toBe("findFirst");
    expect(() =>
      Reflect.apply(engine.prepare, engine, [
        user,
        "missing",
        {},
      ]).buildStatement()
    ).toThrow(UNKNOWN_OPERATION_PATTERN);
  });
});
