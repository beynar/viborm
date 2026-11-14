import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ClientInitializationError, PendingOperationError } from "@errors";
import { lookupResolvedExtensionHandlers } from "@extensions/handlers";
import {
  around,
  call,
  createClient,
  extension as extExtension,
  methods as extMethods,
  s,
  statement,
  target,
  unit,
} from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { appendResolvedExtension } from "@tests/fixtures/host-definition";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
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
  it("precompiles one exact application-ordered lookup of first and second moments", () => {
    const wrap =
      () =>
      <R>(run: () => Promise<R>) =>
        run();
    const first = appendResolvedExtension(
      undefined,
      extExtension("A", around(wrap, target("item", "findMany"))),
      schema
    );
    const second = appendResolvedExtension(
      first,
      extExtension("B", around(wrap)),
      schema
    );
    const chain = appendResolvedExtension(
      second,
      extExtension("C", around(wrap, target("item", "findMany"))),
      schema
    );
    const order = (
      component: "request" | "query",
      model: string | undefined,
      operation: string
    ) =>
      lookupResolvedExtensionHandlers(chain, component, model, operation)?.map(
        ({ extension }) => extension
      );
    expect(order("request", "item", "findMany")).toEqual(["A", "B", "C"]);
    expect(order("query", "item", "findMany")).toEqual(["A", "B", "C"]);
    // The lookup is the precompiled array itself.
    expect(
      lookupResolvedExtensionHandlers(chain, "query", "item", "findMany")
    ).toBe(lookupResolvedExtensionHandlers(chain, "query", "item", "findMany"));
    expect(order("request", "audit", "findMany")).toEqual(["B"]);
    // A raw statement reaches both moments of a part without a target.
    expect(order("query", undefined, "$queryRaw")).toEqual(["B"]);
    expect(order("request", undefined, "$queryRaw")).toEqual(["B"]);
    expect(Object.isFrozen(chain)).toBe(true);

    const genericOnly = appendResolvedExtension(
      undefined,
      { name: "generic-only", query: async () => [] },
      schema
    );
    expect(genericOnly.hasQueryHandlers).toBe(true);
    expect(genericOnly.query!.global).toHaveLength(1);
    expect(Object.keys(genericOnly.query!.models)).toEqual([]);
    expect(
      lookupResolvedExtensionHandlers(genericOnly, "query", "item", "findMany")
    ).toBe(genericOnly.query!.global);
    expect(
      lookupResolvedExtensionHandlers(
        genericOnly,
        "query",
        undefined,
        "$queryRaw"
      )
    ).toBe(genericOnly.query!.global);

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
    const root = new TestQueryEngine(driver, registry);
    const chain = appendResolvedExtension(
      undefined,
      { name: "derived" },
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
    // The route holds the one resolved index and schema registry.
    expect(derived.route).toBe(root.route);
    expect(transaction.clientId).toBe(root.clientId);
    expect(transaction.scopeId).not.toBe(derived.scopeId);
    expect(transaction.driver).toBe(transactionDriver);
    expect(transaction.route).toBe(root.route);
  });

  it("derives an immutable view while sharing schema and driver identity", () => {
    const base = baseClient();
    const definition = extExtension(
      "identity",
      extMethods((_scope) => {
        const own = {
          client: () => ({ $identity: () => "derived" }),
          models: {
            item: (delegate: typeof base.item) => ({
              byName: (name: string) => delegate.findMany({ where: { name } }),
            }),
          },
        };
        return { ...own.client(), ...own.models };
      })
    );

    const derived = base.$extends(definition);

    expect(derived).not.toBe(base);
    expect(derived.$schema).toBe(base.$schema);
    expect(derived.$driver).toBe(base.$driver);
    expect(derived.$identity()).toBe("derived");
    expect(transactionOperation(derived.item.byName("Ada")).scopeId).toBe(
      transactionOperation(derived.item.findMany()).scopeId
    );
    // An extension is an immutable value.
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("requires unique non-empty names and exact runtime maps", () => {
    const base = baseClient();
    const once = base.$extends(extExtension("once"));

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
      extExtension(
        "handlers",
        call(() => undefined, target("item", "findMany")),
        around(() => (run) => run(), target("item", "findMany")),
        unit((u, next) => next(statement(u)), ["statement"], {
          rewrites: true,
        }),
        unit((_u, next) => next())
      ),
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
    expect(withMethods.observation).toBe(withHandlers.observation);
  });

  // A root view `$extends` returns runs every factory at once, where an
  // extension's faults belong; a transaction view runs each on first use of
  // what it returns, so a view costs the factories it uses (Permissions plan K6(d)).
  it("runs factories once for each concrete root and transaction view", async () => {
    const base = baseClient();
    let clientRuns = 0;
    let modelRuns = 0;
    const derived = base.$extends(
      extExtension(
        "factory-counts",
        extMethods((scope) => {
          const own = {
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
            models: {
              item(delegate) {
                modelRuns += 1;
                return {
                  activeScope: () =>
                    transactionOperation(delegate.findMany()).scopeId,
                };
              },
            },
          };
          return { ...own.client?.(scope), ...own.models };
        })
      )
    );

    expect([clientRuns, modelRuns]).toEqual([1, 1]);
    expect(derived.$activeScope()).toBe(derived.item.activeScope());

    await derived.$transaction(async (tx) => {
      expect([clientRuns, modelRuns]).toEqual([1, 1]);
      expect(tx.$activeScope()).toBe(tx.item.activeScope());
      expect([clientRuns, modelRuns]).toEqual([2, 2]);
      await expect(
        tx.$transaction([tx.$capturedRoot()])
      ).rejects.toBeInstanceOf(PendingOperationError);
      await tx.$transaction(async (nested) => {
        expect(nested.$activeScope()).toBe(nested.item.activeScope());
        expect([clientRuns, modelRuns]).toEqual([3, 3]);
      });
    });
  });

  it("refuses collisions atomically and leaves the prior view usable", () => {
    const base = baseClient();
    const valid = base.$extends(
      extExtension(
        "valid",
        extMethods((_scope) => {
          const own = {
            client: () => ({ $valid: () => true }),
            models: { item: () => ({ valid: () => true }) },
          };
          return { ...own.client(), ...own.models };
        })
      )
    );

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

  it("uses distinct operation scopes for base and every derived view", async () => {
    const base = baseClient();
    const first = base.$extends(extExtension("first"));
    const second = base.$extends(extExtension("second"));

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
});
