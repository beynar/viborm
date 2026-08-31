import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ClientInitializationError, PendingOperationError } from "@errors";
import {
  appendResolvedExtension,
  lookupResolvedExtensionHandlers,
} from "@extensions/chain";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createClient, defineExtension, s } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { afterEach, describe, expect, it } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const audit = s.model({ id: s.string().id() });
const schema = { item, audit };

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function baseClient() {
  const client = createClient({
    schema,
    driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
  });
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
    const driver = new PlanningDriver("postgresql");
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
    const transactionDriver = new PlanningDriver("postgresql");
    const transaction = derived.bind(transactionDriver);
    const sibling = root.bind(driver, siblingChain);

    expect(root.extensionChain).toBeUndefined();
    expect(derived.extensionChain).toBe(chain);
    expect(transaction.extensionChain).toBe(chain);
    expect(sibling.extensionChain).toBe(siblingChain);
    expect(sibling.extensionChain).not.toBe(chain);
    expect(derived.clientId).toBe(root.clientId);
    expect(derived.scopeId).not.toBe(root.scopeId);
    // Driver identity is also what proves the `$extends()` leg of the
    // namespace contract: the adapter reference and the migration attestation
    // are immutable own properties of this exact driver, so a derived view
    // that holds the same object holds the same two facts. If `$extends` ever
    // rebinds to a different driver, this is the assertion that must be
    // revisited before the namespace witnesses in namespace-options are.
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
      { name: 1 },
      { name: " " },
      { name: "unknown-envelope", cliet: () => ({}) },
      { name: "unknown-model", model: { ghost: () => ({}) } },
      {
        name: "unknown-query-model",
        query: { ghost: { findMany: () => Promise.resolve(null) } },
      },
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

  it("rejects malformed capability maps at the definition boundary", () => {
    const base = baseClient();
    const symbol = Symbol("hostile member");
    const malformed: ReadonlyArray<readonly [unknown, string]> = [
      [null, "Client extension must be an object"],
      [[], "Client extension must be an object"],
      [
        { name: "symbol-envelope", [symbol]: () => undefined },
        "unknown member",
      ],
      [
        { name: "request-primitive", request: 1 },
        "request must be a function or model map",
      ],
      [
        { name: "request-symbol-model", request: { [symbol]: {} } },
        "request contains a non-string model key",
      ],
      [
        { name: "request-operation-map", request: { item: 1 } },
        "request.item must be an operation map",
      ],
      [
        {
          name: "request-symbol-operation",
          request: { item: { [symbol]: () => ({}) } },
        },
        "request.item contains a non-string operation key",
      ],
      [
        {
          name: "request-handler",
          request: { item: { findMany: 1 } },
        },
        "request.item.findMany must be a function",
      ],
      [{ name: "model-primitive", model: 1 }, "model must be a model map"],
      [
        { name: "model-symbol", model: { [symbol]: () => ({}) } },
        "model contains a non-string model key",
      ],
      [
        { name: "model-factory", model: { item: 1 } },
        "model.item must be a function",
      ],
      [
        { name: "statement-handler", statement: 1 },
        "statement must be a function",
      ],
      [{ name: "observe-handler", observe: 1 }, "observe must be a function"],
      [{ name: "client-factory", client: 1 }, "client must be a function"],
    ];

    for (const [definition, message] of malformed) {
      expect(() => applyUnsafe(base, definition)).toThrow(message);
    }
  });

  it("attributes hostile nested definition inspection to its extension", () => {
    const base = baseClient();
    const nestedValues: unknown[] = [
      {
        name: "request-map-keys",
        request: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("request keys failed");
            },
          }
        ),
      },
      {
        name: "request-model-read",
        request: Object.defineProperty({}, "item", {
          enumerable: true,
          get() {
            throw new Error("request model failed");
          },
        }),
      },
      {
        name: "request-operation-keys",
        request: {
          item: new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("operation keys failed");
              },
            }
          ),
        },
      },
      {
        name: "request-operation-read",
        request: {
          item: Object.defineProperty({}, "findMany", {
            enumerable: true,
            get() {
              throw new Error("operation failed");
            },
          }),
        },
      },
    ];

    for (const definition of nestedValues) {
      try {
        applyUnsafe(base, definition);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ClientInitializationError);
        if (!(error instanceof ClientInitializationError)) throw error;
        expect(error.message).toContain("Extension ");
        expect(error.originalCause).toBeInstanceOf(Error);
      }
    }
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

  it("normalizes factory failures and hostile method records", () => {
    const base = baseClient();
    const methodSymbol = Symbol("hostile method");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const definitions = [
      {
        name: "client-factory-throw",
        client() {
          // biome-ignore lint/style/useThrowOnlyError: hostile JavaScript can throw any value.
          throw "client factory failed";
        },
      },
      {
        name: "model-factory-throw",
        model: {
          item() {
            throw new Error("model factory failed");
          },
        },
      },
      {
        name: "revoked-factory-throw",
        client() {
          // biome-ignore lint/style/useThrowOnlyError: hostile JavaScript can throw any value.
          throw revoked.proxy;
        },
      },
      { name: "client-result", client: () => 1 },
      { name: "model-result", model: { item: () => 1 } },
      {
        name: "client-symbol-method",
        client: () => ({ [methodSymbol]: () => undefined }),
      },
      {
        name: "model-symbol-method",
        model: { item: () => ({ [methodSymbol]: () => undefined }) },
      },
      {
        name: "client-method-read",
        client: () =>
          Object.defineProperty({}, "$broken", {
            enumerable: true,
            get() {
              throw new Error("client method failed");
            },
          }),
      },
      {
        name: "model-method-read",
        model: {
          item: () =>
            Object.defineProperty({}, "broken", {
              enumerable: true,
              get() {
                throw new Error("model method failed");
              },
            }),
        },
      },
    ];

    for (const definition of definitions) {
      expect(() => applyUnsafe(base, definition)).toThrow(
        ClientInitializationError
      );
    }
  });

  it("reuses unchanged compiled lookups across method-only extensions", () => {
    const withHandlers = appendResolvedExtension(
      undefined,
      {
        name: "handlers",
        request: { item: { findMany: () => ({}) } },
        query: { item: { findMany: async () => [] } },
        statement: ({ statement }: { statement: unknown }) => statement,
        observe: () => undefined,
      },
      schema
    );
    const withMethods = appendResolvedExtension(
      withHandlers,
      {
        name: "methods-only",
        client: () => ({ $ready: () => true }),
      },
      schema
    );

    expect(withMethods.request).toBe(withHandlers.request);
    expect(withMethods.query).toBe(withHandlers.query);
    expect(withMethods.statement).toBe(withHandlers.statement);
    expect(withMethods.observe).toBe(withHandlers.observe);
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
      { name: "raw", client: () => ({ $queryRaw: () => true }) },
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

describe("coverage low value", () => {
  it("returns no handlers for an absent compiled chain", () => {
    expect(
      lookupResolvedExtensionHandlers(undefined, "query", "item", "findMany")
    ).toBeUndefined();
  });

  it("attributes an unreadable root definition before its name exists", () => {
    const definition = new Proxy(
      { name: "unreadable" },
      {
        ownKeys() {
          throw new Error("definition keys are unreadable");
        },
      }
    );

    try {
      applyUnsafe(baseClient(), definition);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ClientInitializationError);
      expect(error).toMatchObject({
        message: "Client extension members could not be inspected.",
      });
    }
  });
});
