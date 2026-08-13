import { MemoryCache } from "@cache/drivers/memory";
import { PendingOperation as ClientPendingOperation } from "@client/exports";
import { PgDriver } from "@drivers/pg";
import {
  CacheConfigurationError,
  PendingOperationError,
  ValidationError,
} from "@errors";
import { withMutationCacheInvalidation } from "@query-engine/cache-flow";
import { PendingOperation } from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { QueryMetadata } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import { PendingOperation as RootPendingOperation } from "@src/index";
import { createSchemaRegistry } from "@validation";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

function createOperation<T>(
  operation: "findMany" | "update" = "findMany",
  args: Record<string, unknown> = {}
): PendingOperation<T> {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const schema = { user };
  hydrateSchemaNames(schema);
  const engine = new QueryEngine(
    new PgDriver(),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  return engine.prepare<T>(user, operation, args);
}

function createControlledOperation<T>(
  value: T,
  operation: "findMany" | "update" = "findMany"
): { operation: PendingOperation<T>; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(() => Promise.resolve(value));
  return {
    operation: createOperation<T>(operation).wrapExecutor(execute),
    execute,
  };
}

describe("PendingOperation frozen public contract", () => {
  it("preserves client identity and mints transaction scope identity", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    const engine = new QueryEngine(new PgDriver(), registry);
    const transactionDriver = new PgDriver();
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
      new PgDriver(),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );

    let operation: PendingOperation<unknown> | undefined;
    expect(() => {
      // A schema-invalid payload (id must be a string): the engine constructs the
      // deferred operation without validating, so creation does not throw.
      operation = engine.prepare(user, "create", { data: { id: 123 } });
    }).not.toThrow();

    expect(() => operation?.prepare()).toThrow(ValidationError);
    await expect(operation?.execute()).rejects.toBeInstanceOf(ValidationError);
  });

  it("memoizes one execution across then, catch, finally, and execute", async () => {
    const { operation, execute } = createControlledOperation(42);
    const finalized = vi.fn();

    await expect(
      Promise.all([
        operation.then((value) => value),
        operation.catch(() => -1),
        operation.finally(finalized),
        operation.execute(),
      ])
    ).resolves.toEqual([42, 42, 42, 42]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveBeenCalledTimes(1);
  });

  it("memoizes executeWith for the same driver", async () => {
    const driver = new PgDriver();
    const { operation, execute } = createControlledOperation(42);

    const first = operation.executeWith(driver);
    const second = operation.executeWith(driver);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects default execution after driver-bound execution", () => {
    const { operation } = createControlledOperation(42);
    operation.executeWith(new PgDriver());
    expect(() => operation.execute()).toThrow(PendingOperationError);
  });

  it("rejects driver-bound execution after default execution", () => {
    const { operation } = createControlledOperation(42);
    operation.execute();
    expect(() => operation.executeWith(new PgDriver())).toThrow(
      PendingOperationError
    );
  });

  it("rejects a second, different driver", () => {
    const { operation } = createControlledOperation(42);
    operation.executeWith(new PgDriver());
    expect(() => operation.executeWith(new PgDriver())).toThrow(
      PendingOperationError
    );
  });

  it("prepares directly and as a bulk batch without executing", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const driver = new PgDriver();
    const engine = new QueryEngine(
      driver,
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const direct = engine.prepare(user, "findMany", {});
    const bulk = engine.prepare(user, "createMany", {
      data: [{ id: "user-1", name: "Arnaud" }],
    });

    expect(direct.prepare(driver)).toMatchObject({
      sql: expect.any(String),
      params: expect.any(Array),
      context: direct.getExecutionContext(),
    });
    await expect(bulk.prepareBatch(driver)).resolves.toMatchObject({
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

    expect(operation.getArgs()).toBe(args);
    expect(operation.getModel()).toBe("user");
    expect(operation.getOperation()).toBe("findMany");
    expect(typeof operation.getClientId()).toBe("symbol");
    expect(typeof operation.getScopeId()).toBe("symbol");
    expect(Object.isFrozen(operation.context)).toBe(true);
    expect(operation.getExecutionContext()).toBe(operation.context.attribution);
    expect(operation.parseResult(raw)).toEqual(raw.rows);
  });

  it("wrapExecutor returns an immutable operation and composes wrappers", async () => {
    const source = vi.fn(() => Promise.resolve(42));
    const original = createOperation<number>().wrapExecutor(source);
    const wrapper = vi.fn(async (execute: () => Promise<number>) => {
      const value = await execute();
      return value + 1;
    });
    const wrapped = original.wrapExecutor(wrapper);

    expect(wrapped).not.toBe(original);
    await expect(wrapped.executeWith(new PgDriver())).resolves.toBe(43);
    expect(wrapper).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledOnce();
    expect(original.getArgs()).toBe(wrapped.getArgs());
    expect(original.getExecutionContext()).toBe(wrapped.getExecutionContext());
    expect(original.getClientId()).toBe(wrapped.getClientId());
    expect(original.getScopeId()).toBe(wrapped.getScopeId());
  });

  it("decorates only mutations with cache invalidation after successful execution", async () => {
    const cache = new MemoryCache();
    const invalidate = vi.spyOn(cache, "_invalidate");
    const mutation = createControlledOperation(42, "update").operation;
    const decorated = withMutationCacheInvalidation(
      mutation,
      cache,
      "user",
      "update",
      undefined
    );

    expect(decorated).not.toBe(mutation);
    await expect(decorated.execute()).resolves.toBe(42);
    expect(invalidate).toHaveBeenCalledWith(
      "user",
      undefined,
      mutation.getExecutionContext()
    );

    const read = createControlledOperation(42).operation;
    expect(
      withMutationCacheInvalidation(read, cache, "user", "findMany", undefined)
    ).toBe(read);
  });

  it("preserves mutation failures without invalidating cache", async () => {
    const failure = new Error("mutation failed");
    const cache = new MemoryCache();
    const invalidate = vi.spyOn(cache, "_invalidate");
    const mutation = createOperation<number>("update").wrapExecutor(() =>
      Promise.reject(failure)
    );
    const decorated = withMutationCacheInvalidation(
      mutation,
      cache,
      "user",
      "update",
      undefined
    );

    const caught = await decorated.execute().catch((error) => error);
    expect(caught).toBe(failure);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("owns cache invalidation failures instead of leaking a raw error", async () => {
    const cache = new MemoryCache();
    const failure = new Error("cache transport failed");
    vi.spyOn(cache, "_invalidate").mockRejectedValue(failure);
    const mutation = createControlledOperation(42, "update").operation;
    const decorated = withMutationCacheInvalidation(
      mutation,
      cache,
      "user",
      "update",
      undefined
    );

    const caught = await decorated.execute().catch((error) => error);
    expect(caught).toBeInstanceOf(CacheConfigurationError);
    expect(caught).toMatchObject({
      meta: { method: "invalidate", model: "user", operation: "update" },
    });
  });

  it("keeps PendingOperation as the root and client runtime export", () => {
    expect(RootPendingOperation).toBe(PendingOperation);
    expect(ClientPendingOperation).toBe(PendingOperation);
    expectTypeOf<QueryMetadata<number>>().toEqualTypeOf<
      PendingOperation<number>
    >();
  });
});
