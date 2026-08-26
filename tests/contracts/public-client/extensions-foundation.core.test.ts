import { PGliteDriver } from "@drivers/pglite";
import { ClientInitializationError, PendingOperationError } from "@errors";
import {
  appendResolvedExtension,
  lookupResolvedExtensionHandlers,
} from "@extensions/chain";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createClient, defineExtension, s } from "@src/index";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { afterEach, describe, expect, it } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const audit = s.model({ id: s.string().id() });
const schema = { item, audit };

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function baseClient() {
  const client = createClient({ schema, driver: new PGliteDriver() });
  clients.push(client);
  return client;
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

function applyUnsafe(client: object, definition: unknown): object {
  const extend = Reflect.get(client, "$extends");
  return Reflect.apply(extend, client, [definition]);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("client extension foundation", () => {
  it("precompiles one exact application-ordered request and query lookup", () => {
    const requestA = () => ({});
    const requestB = () => ({});
    const requestC = () => ({});
    const queryA = async () => [];
    const queryB = async () => [];
    const queryC = async () => [];

    const first = appendResolvedExtension(
      undefined,
      {
        name: "A",
        request: { item: { findMany: requestA } },
        query: { item: { findMany: queryA } },
      },
      schema
    );
    const second = appendResolvedExtension(
      first,
      { name: "B", request: requestB, query: queryB },
      schema
    );
    const chain = appendResolvedExtension(
      second,
      {
        name: "C",
        request: { item: { findMany: requestC } },
        query: { item: { findMany: queryC } },
      },
      schema
    );

    const request = lookupResolvedExtensionHandlers(
      chain,
      "request",
      "item",
      "findMany"
    );
    const query = lookupResolvedExtensionHandlers(
      chain,
      "query",
      "item",
      "findMany"
    );
    expect(request?.map(({ extension }) => extension)).toEqual(["A", "B", "C"]);
    expect(request?.map(({ handler }) => handler)).toEqual([
      requestA,
      requestB,
      requestC,
    ]);
    expect(query?.map(({ extension }) => extension)).toEqual(["A", "B", "C"]);
    expect(query?.map(({ handler }) => handler)).toEqual([
      queryA,
      queryB,
      queryC,
    ]);
    expect(
      lookupResolvedExtensionHandlers(chain, "request", "item", "findMany")
    ).toBe(request);
    expect(
      lookupResolvedExtensionHandlers(chain, "query", "item", "findMany")
    ).toBe(query);
    expect(
      lookupResolvedExtensionHandlers(
        chain,
        "request",
        "audit",
        "findMany"
      )?.map(({ extension }) => extension)
    ).toEqual(["B"]);
    expect(
      lookupResolvedExtensionHandlers(
        chain,
        "query",
        undefined,
        "$queryRaw"
      )?.map(({ extension }) => extension)
    ).toEqual(["B"]);
    expect(
      lookupResolvedExtensionHandlers(chain, "request", undefined, "$queryRaw")
    ).toBeUndefined();
    expect(Object.isFrozen(chain)).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(query)).toBe(true);

    const genericOnly = appendResolvedExtension(
      undefined,
      { name: "generic-only", query: queryB },
      schema
    );
    expect(genericOnly.hasQueryHandlers).toBe(true);
    expect(genericOnly.query.global).toHaveLength(1);
    expect(Object.keys(genericOnly.query.models)).toEqual([]);
    expect(Object.keys(genericOnly.query.raw)).toEqual([]);
    expect(
      lookupResolvedExtensionHandlers(genericOnly, "query", "item", "findMany")
    ).toBe(genericOnly.query.global);
    expect(
      lookupResolvedExtensionHandlers(
        genericOnly,
        "query",
        undefined,
        "$queryRaw"
      )
    ).toBe(genericOnly.query.global);

    const emptyQuery = appendResolvedExtension(
      undefined,
      { name: "empty-query", query: {} },
      schema
    );
    const emptyModelQuery = appendResolvedExtension(
      undefined,
      { name: "empty-model-query", query: { item: {} } },
      schema
    );
    expect(emptyQuery.hasQueryHandlers).toBe(false);
    expect(emptyModelQuery.hasQueryHandlers).toBe(false);
  });

  it("threads the exact chain through derived and transaction engine scopes", () => {
    baseClient();
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    const driver = new PGliteDriver();
    const root = new QueryEngine(driver, registry);
    const chain = appendResolvedExtension(
      undefined,
      { name: "derived", request: () => ({}) },
      schema
    );
    const siblingChain = appendResolvedExtension(
      undefined,
      { name: "sibling", query: async () => [] },
      schema
    );

    const derived = root.bind(driver, chain);
    const transactionDriver = new PGliteDriver();
    const transaction = derived.bind(transactionDriver);
    const sibling = root.bind(driver, siblingChain);

    expect(root.extensionChain).toBeUndefined();
    expect(derived.extensionChain).toBe(chain);
    expect(transaction.extensionChain).toBe(chain);
    expect(sibling.extensionChain).toBe(siblingChain);
    expect(sibling.extensionChain).not.toBe(chain);
    expect(derived.clientId).toBe(root.clientId);
    expect(derived.scopeId).not.toBe(root.scopeId);
    expect(derived.driver).toBe(driver);
    expect(derived.registry).toBe(root.registry);
    expect(derived.relations).toBe(root.relations);
    expect(transaction.clientId).toBe(root.clientId);
    expect(transaction.scopeId).not.toBe(derived.scopeId);
    expect(transaction.driver).toBe(transactionDriver);
    expect(transaction.registry).toBe(root.registry);
    expect(transaction.relations).toBe(root.relations);
  });

  it("derives an immutable view while sharing schema and driver identity", () => {
    const base = baseClient();
    const definition = {
      name: "identity",
      client: () => ({ $identity: () => "derived" }),
      model: {
        item: (delegate: typeof base.item) => ({
          byName: (name: string) => delegate.findMany({ where: { name } }),
        }),
      },
    };

    const derived = base.$extends(definition);

    expect(derived).not.toBe(base);
    expect(derived.$schema).toBe(base.$schema);
    expect(derived.$driver).toBe(base.$driver);
    expect(derived.$identity()).toBe("derived");
    expect(transactionOperation(derived.item.byName("Ada")).scopeId).toBe(
      transactionOperation(derived.item.findMany()).scopeId
    );
    expect(Object.isFrozen(definition)).toBe(false);
    expect(Object.isFrozen(definition.model)).toBe(false);
  });

  it("snapshots reusable definitions without freezing caller-owned objects", () => {
    const base = baseClient();
    const methods = { $version: () => 1 };
    const definition = { name: "snapshot", client: () => methods };
    const reusable = defineExtension(definition);

    expect(Object.isFrozen(definition)).toBe(false);
    expect(Object.isFrozen(methods)).toBe(false);

    const derived = base.$extends(reusable);
    definition.name = "changed";
    methods.$version = () => 2;

    expect(derived.$version()).toBe(1);
  });

  it("requires unique non-empty names and exact runtime maps", () => {
    const base = baseClient();
    const once = base.$extends({ name: "once" });

    for (const definition of [
      {},
      { name: " " },
      { name: "unknown-envelope", cliet: () => ({}) },
      { name: "unknown-model", model: { ghost: () => ({}) } },
      {
        name: "unknown-operation",
        query: { item: { findManny: () => Promise.resolve(null) } },
      },
    ]) {
      expect(() => applyUnsafe(base, definition)).toThrow(
        ClientInitializationError
      );
    }
    expect(() => applyUnsafe(once, { name: "once" })).toThrow(
      ClientInitializationError
    );
  });

  it("wraps hostile definition and factory-result access with extension identity", () => {
    const base = baseClient();
    const hostileDefinition = Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        throw new Error("hostile name");
      },
    });

    expect(() => applyUnsafe(base, hostileDefinition)).toThrow(
      ClientInitializationError
    );

    try {
      applyUnsafe(base, {
        name: "hostile-methods",
        client: () =>
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("hostile ownKeys");
              },
            }
          ),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ClientInitializationError);
      if (!(error instanceof ClientInitializationError)) throw error;
      expect(error.message).toContain('Extension "hostile-methods"');
      expect(error.originalCause).toBeInstanceOf(Error);
    }
  });

  it("runs factories once for each concrete root and transaction view", async () => {
    const base = baseClient();
    let clientRuns = 0;
    let modelRuns = 0;
    const derived = base.$extends({
      name: "factory-counts",
      client(scope) {
        clientRuns += 1;
        return {
          $activeScope: () =>
            transactionOperation(scope.item.findMany()).scopeId,
          // Capturing the external root is the documented author-controlled
          // escape: the host can bind only the supplied scope.
          $capturedRoot: () => base.item.findMany(),
        };
      },
      model: {
        item(delegate) {
          modelRuns += 1;
          return {
            activeScope: () =>
              transactionOperation(delegate.findMany()).scopeId,
          };
        },
      },
    });

    expect([clientRuns, modelRuns]).toEqual([1, 1]);
    expect(derived.$activeScope()).toBe(derived.item.activeScope());

    await derived.$transaction(async (tx) => {
      expect([clientRuns, modelRuns]).toEqual([2, 2]);
      expect(tx.$activeScope()).toBe(tx.item.activeScope());
      await expect(
        tx.$transaction([tx.$capturedRoot()])
      ).rejects.toBeInstanceOf(PendingOperationError);
      await tx.$transaction(async (nested) => {
        expect([clientRuns, modelRuns]).toEqual([3, 3]);
        expect(nested.$activeScope()).toBe(nested.item.activeScope());
      });
    });
  });

  it("refuses collisions atomically and leaves the prior view usable", () => {
    const base = baseClient();
    const valid = base.$extends({
      name: "valid",
      client: () => ({ $valid: () => true }),
      model: { item: () => ({ valid: () => true }) },
    });

    for (const definition of [
      { name: "non-function", client: () => ({ $bad: 1 }) },
      { name: "missing-dollar", client: () => ({ bad: () => true }) },
      { name: "core", client: () => ({ $transaction: () => true }) },
      { name: "prior-client", client: () => ({ $valid: () => false }) },
      { name: "core-model", model: { item: () => ({ findMany: () => true }) } },
      { name: "then-model", model: { item: () => ({ then: () => true }) } },
      { name: "prior-model", model: { item: () => ({ valid: () => false }) } },
    ]) {
      expect(() => applyUnsafe(valid, definition)).toThrow(
        ClientInitializationError
      );
      expect(valid.$valid()).toBe(true);
      expect(valid.item.valid()).toBe(true);
    }
  });

  it("does not grant contributed methods dynamic sibling authority", () => {
    const derived = applyUnsafe(baseClient(), {
      name: "no-dynamic-this",
      client: () => ({
        $first() {
          return this.$second();
        },
        $second: () => "client sibling",
      }),
      model: {
        item: () => ({
          first() {
            return this.second();
          },
          second: () => "model sibling",
        }),
      },
    });

    const clientMethod = Reflect.get(derived, "$first");
    expect(() => Reflect.apply(clientMethod, derived, [])).toThrow(TypeError);

    const delegate = Reflect.get(derived, "item");
    const modelMethod = Reflect.get(delegate, "first");
    expect(() => Reflect.apply(modelMethod, delegate, [])).toThrow(TypeError);
  });

  it("uses distinct operation scopes for base and every derived view", async () => {
    const base = baseClient();
    const first = base.$extends({ name: "first" });
    const second = base.$extends({ name: "second" });

    expect(transactionOperation(base.item.findMany()).clientId).toBe(
      transactionOperation(first.item.findMany()).clientId
    );
    expect(transactionOperation(base.item.findMany()).scopeId).not.toBe(
      transactionOperation(first.item.findMany()).scopeId
    );

    await expect(
      first.$transaction([base.item.findMany()])
    ).rejects.toBeInstanceOf(PendingOperationError);
    await expect(
      first.$transaction([second.item.findMany()])
    ).rejects.toBeInstanceOf(PendingOperationError);
  });
});
