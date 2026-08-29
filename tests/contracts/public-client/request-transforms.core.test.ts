import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import type { Operations } from "@client/types";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { QueryError, ValidationError } from "@errors";
import {
  applyRequestTransforms,
  type RequestTransform,
} from "@extensions/request";
import { s } from "@schema";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { afterEach, describe, expect, test, vi } from "vitest";

type FindManyInput = {
  where?: { published?: boolean };
  take?: number;
  skip?: number;
  select?: { id?: boolean };
  include?: { author?: boolean };
  omit?: { secret?: boolean };
};

function captureQueryError(action: () => unknown): QueryError {
  try {
    action();
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("Expected a QueryError");
}

function requireTransformedInput(input: object | undefined): object {
  if (input === undefined) throw new Error("Expected transformed input");
  return input;
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

describe("standalone request transforms", () => {
  test("the no-handler path returns by identity without inspecting input", () => {
    const input = new Proxy(
      { where: { published: true } },
      {
        ownKeys() {
          throw new Error("the no-handler path inspected input");
        },
        getOwnPropertyDescriptor() {
          throw new Error("the no-handler path inspected a descriptor");
        },
      }
    );

    expect(applyRequestTransforms("post", "findMany", input, undefined)).toBe(
      input
    );
    expect(applyRequestTransforms("post", "findMany", input, [])).toBe(input);
    expect(
      applyRequestTransforms("post", "findMany", undefined, undefined)
    ).toBeUndefined();
  });

  test("an empty patch materializes the captured caller input after one protected inspection", () => {
    const shape = { id: true };
    let ownKeyReads = 0;
    let descriptorReads = 0;
    const callerInput = new Proxy(
      { where: { published: true }, select: shape },
      {
        ownKeys(target) {
          ownKeyReads += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );
    const handler = vi.fn(({ input }) => {
      expect(input).toEqual({ where: { published: true } });
      expect(Object.hasOwn(input, "select")).toBe(false);
      expect(Object.isFrozen(input)).toBe(true);
      return Object.freeze({});
    });

    const transformed = applyRequestTransforms(
      "post",
      "findMany",
      callerInput,
      [{ extension: "no-op", handler }]
    );
    const readsAfterTransform = { ownKeyReads, descriptorReads };
    expect(transformed).not.toBe(callerInput);
    expect(transformed).toEqual({
      where: { published: true },
      select: shape,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(readsAfterTransform).toEqual({
      ownKeyReads: 1,
      descriptorReads: 2,
    });
    expect(callerInput.select).toBe(shape);
  });

  test("an empty patch cannot authorize closed-over caller mutation", () => {
    const select = { id: true };
    const include = { author: true };
    const callerInput: Record<string, unknown> = {};
    Object.defineProperties(callerInput, {
      where: {
        configurable: true,
        enumerable: true,
        value: { published: true },
        writable: false,
      },
      take: {
        configurable: true,
        enumerable: false,
        get: () => 3,
      },
      select: {
        configurable: true,
        enumerable: true,
        value: select,
        writable: false,
      },
      include: {
        configurable: true,
        enumerable: false,
        value: include,
        writable: true,
      },
    });
    const originalKeys = Reflect.ownKeys(callerInput);
    const originalDescriptors = Object.getOwnPropertyDescriptors(callerInput);

    const transformed = requireTransformedInput(
      applyRequestTransforms("post", "findMany", callerInput, [
        {
          extension: "closed-over-mutator",
          handler() {
            Reflect.deleteProperty(callerInput, "where");
            Object.defineProperty(callerInput, "take", {
              configurable: true,
              enumerable: true,
              value: 99,
              writable: true,
            });
            Object.defineProperty(callerInput, "select", {
              configurable: true,
              enumerable: true,
              value: { compromised: true },
              writable: true,
            });
            Reflect.deleteProperty(callerInput, "include");
            Reflect.set(callerInput, "injected", true);
            return {};
          },
        },
      ])
    );

    expect(Reflect.ownKeys(transformed)).toEqual(originalKeys);
    expect(Object.getOwnPropertyDescriptors(transformed)).toEqual(
      originalDescriptors
    );
    expect(Reflect.get(transformed, "select")).toBe(select);
    expect(Reflect.get(transformed, "include")).toBe(include);
    expect(Reflect.has(transformed, "injected")).toBe(false);
    expect(Reflect.has(callerInput, "where")).toBe(false);
    expect(Reflect.get(callerInput, "take")).toBe(99);
    expect(Reflect.has(callerInput, "injected")).toBe(true);
  });

  test("absent input is immutable and patches compose once in application order", () => {
    const calls: string[] = [];
    const first = vi.fn(({ input }) => {
      calls.push("first");
      expect(input).toEqual({});
      expect(Object.isFrozen(input)).toBe(true);
      return { take: 2 };
    });
    const second = vi.fn(({ input }) => {
      calls.push("second");
      expect(input).toEqual({ take: 2 });
      expect(Object.isFrozen(input)).toBe(true);
      return { skip: 1 };
    });
    const transforms: RequestTransform<"findMany", FindManyInput>[] = [
      { extension: "first", handler: first },
      { extension: "second", handler: second },
    ];

    expect(
      applyRequestTransforms("post", "findMany", undefined, transforms)
    ).toEqual({ take: 2, skip: 1 });
    expect(calls).toEqual(["first", "second"]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  test("later transforms see earlier shallow patches without caller mutation", () => {
    const callerWhere = { published: false };
    const callerInput: FindManyInput = {
      where: callerWhere,
      take: 5,
    };
    const transforms: RequestTransform<"findMany", FindManyInput>[] = [
      {
        extension: "tenant",
        handler({ input }) {
          expect(input.where).toBe(callerWhere);
          return { where: { published: true } };
        },
      },
      {
        extension: "pagination",
        handler({ input }) {
          expect(input.where).toEqual({ published: true });
          expect(input.take).toBe(5);
          return { take: 2 };
        },
      },
    ];

    expect(
      applyRequestTransforms("post", "findMany", callerInput, transforms)
    ).toEqual({ where: { published: true }, take: 2 });
    expect(callerInput).toEqual({ where: callerWhere, take: 5 });
    expect(callerInput.where).toBe(callerWhere);
  });
});

const projectionCases: readonly {
  readonly operation: Operations;
  readonly keys: readonly string[];
}[] = [
  { operation: "findFirst", keys: ["select", "include", "omit"] },
  { operation: "findMany", keys: ["select", "include", "omit"] },
  { operation: "findUnique", keys: ["select", "include", "omit"] },
  {
    operation: "findUniqueOrThrow",
    keys: ["select", "include", "omit"],
  },
  {
    operation: "findFirstOrThrow",
    keys: ["select", "include", "omit"],
  },
  { operation: "create", keys: ["select", "include", "omit"] },
  { operation: "update", keys: ["select", "include", "omit"] },
  { operation: "delete", keys: ["select", "include", "omit"] },
  { operation: "upsert", keys: ["select", "include", "omit"] },
  { operation: "count", keys: ["select"] },
  {
    operation: "aggregate",
    keys: ["_count", "_avg", "_sum", "_min", "_max"],
  },
  {
    operation: "groupBy",
    keys: ["by", "_count", "_avg", "_sum", "_min", "_max"],
  },
  { operation: "createMany", keys: ["select", "omit"] },
  { operation: "updateMany", keys: ["select", "omit"] },
  { operation: "deleteMany", keys: ["select", "omit"] },
];

describe("the operation-specific result-shape projector", () => {
  test.each(projectionCases)("$operation detaches and restores $keys", ({
    operation,
    keys,
  }) => {
    const input: Record<string, unknown> = { ordinary: "caller" };
    const originals = new Map<string, object>();
    for (const key of keys) {
      const descriptor = { family: operation, key };
      originals.set(key, descriptor);
      Object.defineProperty(input, key, {
        configurable: true,
        enumerable: true,
        value: descriptor,
        writable: true,
      });
    }

    const transformed = requireTransformedInput(
      applyRequestTransforms("entry", operation, input, [
        {
          extension: "projection-attack",
          handler({ input: visibleInput }) {
            for (const key of keys) {
              expect(Object.hasOwn(visibleInput, key)).toBe(false);
              expect(Reflect.get(visibleInput, key)).toBeUndefined();
            }
            const patch = {
              ordinary: "patched",
              added: true,
            };
            for (const key of keys) {
              Reflect.set(patch, key, { malicious: key });
            }
            return patch;
          },
        },
      ])
    );

    expect(transformed).toMatchObject({ ordinary: "patched", added: true });
    for (const key of keys) {
      expect(Reflect.get(transformed, key)).toBe(originals.get(key));
      expect(Reflect.get(input, key)).toBe(originals.get(key));
    }
  });

  test("projection accessors and nested objects are unreachable and restored exactly", () => {
    const select = { id: true };
    const include = { author: { select: { id: true } } };
    const omit = { secret: true };
    const readInclude = vi.fn(() => include);
    const callerInput: FindManyInput = { where: { published: true } };
    Object.defineProperty(callerInput, "select", {
      configurable: false,
      enumerable: true,
      value: select,
      writable: false,
    });
    Object.defineProperty(callerInput, "include", {
      configurable: true,
      enumerable: true,
      get: readInclude,
    });
    Object.defineProperty(callerInput, "omit", {
      configurable: true,
      enumerable: false,
      value: omit,
      writable: true,
    });
    const originalKeys = Reflect.ownKeys(callerInput);
    const originalDescriptors = Object.getOwnPropertyDescriptors(callerInput);

    const transform: RequestTransform<"findMany", FindManyInput> = {
      extension: "hostile",
      handler({ input }) {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.hasOwn(input, "select")).toBe(false);
        expect(Object.hasOwn(input, "include")).toBe(false);
        expect(Object.hasOwn(input, "omit")).toBe(false);

        const patch = { take: 3 };
        Object.defineProperty(patch, "select", {
          enumerable: true,
          get() {
            throw new Error("a protected patch getter was invoked");
          },
        });
        return patch;
      },
    };

    const transformed = requireTransformedInput(
      applyRequestTransforms("post", "findMany", callerInput, [transform])
    );

    expect(readInclude).not.toHaveBeenCalled();
    expect(Reflect.ownKeys(callerInput)).toEqual(originalKeys);
    expect(Reflect.ownKeys(transformed)).toEqual([...originalKeys, "take"]);
    expect(Reflect.get(transformed, "select")).toBe(select);
    expect(Reflect.get(transformed, "omit")).toBe(omit);
    expect(readInclude).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(transformed, "select")).toEqual(
      originalDescriptors.select
    );
    expect(Object.getOwnPropertyDescriptor(transformed, "include")).toEqual(
      originalDescriptors.include
    );
    expect(Object.getOwnPropertyDescriptor(transformed, "omit")).toEqual(
      originalDescriptors.omit
    );
    expect(Reflect.get(transformed, "include")).toBe(include);
    expect(readInclude).toHaveBeenCalledOnce();
  });

  test("hostile input descriptor enumeration fails at the named boundary", () => {
    const cause = new Error("ownKeys exploded");
    const input = new Proxy(
      {},
      {
        ownKeys() {
          throw cause;
        },
      }
    );

    const error = captureQueryError(() =>
      applyRequestTransforms("post", "findMany", input, [
        {
          extension: "hostile-input",
          handler: () => ({}),
        },
      ])
    );

    expect(error.message).toContain('Extension "hostile-input"');
    expect(error.message).toContain("could not inspect request input");
    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.meta).toEqual({
      model: "post",
      operation: "findMany",
    });
  });
});

describe("request-transform failures", () => {
  test("a thrown Error is attributed to the named extension with its cause", () => {
    const cause = new Error("tenant lookup failed");
    const error = captureQueryError(() =>
      applyRequestTransforms("post", "findMany", {}, [
        {
          extension: "tenant",
          handler() {
            throw cause;
          },
        },
      ])
    );

    expect(error.message).toContain('Extension "tenant"');
    expect(error.meta).toMatchObject({
      model: "post",
      operation: "findMany",
    });
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  test("a non-Error throw gets one deterministic cause", () => {
    const error = captureQueryError(() =>
      applyRequestTransforms("post", "findMany", {}, [
        {
          extension: "hostile-throw",
          handler() {
            // biome-ignore lint/style/useThrowOnlyError: hostile JavaScript can throw any value.
            throw { toString: null };
          },
        },
      ])
    );

    expect(error.originalCause).toBeInstanceOf(Error);
  });

  test("a hostile Error proxy cannot escape the named request boundary", () => {
    const hostileFailure = new Proxy(new Error("private request failure"), {
      getPrototypeOf() {
        throw new Error("hostile request prototype read");
      },
    });
    const error = captureQueryError(() =>
      applyRequestTransforms("post", "findMany", {}, [
        {
          extension: "hostile-request-error",
          handler() {
            throw hostileFailure;
          },
        },
      ])
    );

    expect(error.message).toContain('Extension "hostile-request-error"');
    expect(error.message).toContain("request handler for post.findMany threw");
    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.originalCause).not.toBe(hostileFailure);
  });

  test("promise and non-record outputs fail at the named extension boundary", () => {
    const promiseError = captureQueryError(() =>
      applyRequestTransforms<"findMany", FindManyInput>(
        "post",
        "findMany",
        {},
        [
          {
            extension: "async-request",
            // @ts-expect-error - runtime falsifier for hostile JavaScript
            handler() {
              return Promise.resolve({ take: 1 });
            },
          },
        ]
      )
    );
    expect(promiseError.message).toContain('Extension "async-request"');
    expect(promiseError.message).toContain("returned a promise");
    expect(promiseError.originalCause).toBeInstanceOf(Error);

    const nonRecordError = captureQueryError(() =>
      applyRequestTransforms<"findMany", FindManyInput>(
        "post",
        "findMany",
        {},
        [
          {
            extension: "primitive-request",
            // @ts-expect-error - runtime falsifier for hostile JavaScript
            handler() {
              return 1;
            },
          },
        ]
      )
    );
    expect(nonRecordError.message).toContain('Extension "primitive-request"');
    expect(nonRecordError.message).toContain("returned a non-record patch");
    expect(nonRecordError.originalCause).toBeInstanceOf(Error);
  });
});

describe("validation ownership", () => {
  test("an unknown ordinary key survives transforms and fails at core validation", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const registry = createSchemaRegistry({ user });
    type HostileInput = { where?: { id?: string }; unknownKey?: boolean };

    const transformed = applyRequestTransforms<"findMany", HostileInput>(
      "user",
      "findMany",
      {},
      [
        {
          extension: "unknown-key",
          handler() {
            return { unknownKey: true };
          },
        },
      ]
    );

    expect(transformed).toMatchObject({ unknownKey: true });
    expect(() => registry.validate("user", "findMany", transformed)).toThrow(
      ValidationError
    );
  });
});

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  entries: s.toMany(() => entry),
});
const entry = s.model({
  id: s.string().id(),
  secret: s.string(),
  views: s.int(),
  category: s.string(),
  location: s.point().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const integratedSchema = { author, entry };

class RequestTransformDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter("public", true);
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  constructor() {
    super("postgresql", "request-transform-test");
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to close.
  }

  protected async execute<T>(
    _client: object,
    _sql: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn({});
  }
}

const integratedClients: Array<{ $disconnect(): Promise<void> }> = [];

function integratedClient() {
  const client = createClient({
    schema: integratedSchema,
    driver: new RequestTransformDriver(),
  });
  integratedClients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of integratedClients.splice(0)) {
    await client.$disconnect();
  }
});

describe("public request-transform integration", () => {
  test("protects a GeoPoint distance projection through an extension", async () => {
    let sawDetachedSelect = false;
    const client = integratedClient().$extends({
      name: "point-distance-projection",
      request: {
        entry: {
          findMany({ input }) {
            sawDetachedSelect = !Object.hasOwn(input, "select");
            return {};
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        select: {
          location: {
            _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
          },
        },
      })
    ).resolves.toEqual([]);
    expect(sawDetachedSelect).toBe(true);
  });

  test("stays lazy and resolves one application-ordered patch chain once", async () => {
    const calls: string[] = [];
    const base = integratedClient();
    const client = base
      .$extends({
        name: "A",
        request: {
          entry: {
            findMany({ input }) {
              calls.push("A");
              expect(input.take).toBeUndefined();
              return { take: 3 };
            },
          },
        },
      })
      .$extends({
        name: "B",
        request({ operation, input }) {
          if (operation !== "findMany") return {};
          calls.push("B");
          expect(input.take).toBe(3);
          return { skip: 1 };
        },
      })
      .$extends({
        name: "C",
        request: {
          entry: {
            findMany({ input }) {
              calls.push("C");
              expect(input.skip).toBe(1);
              return { where: { category: "patched" } };
            },
          },
        },
      });

    const delegate = client.entry;
    const method = delegate.findMany;
    const operation = method({ where: { category: "caller" } });
    expect(calls).toEqual([]);

    transactionOperation(operation).prepare();
    operation.buildStatement();
    operation.cacheKeyArgs();
    transactionOperation(operation).prepare();
    expect(calls).toEqual(["A", "B", "C"]);

    const awaited = client.entry.findMany();
    expect(calls).toEqual(["A", "B", "C"]);
    await awaited;
    expect(calls).toEqual(["A", "B", "C", "A", "B", "C"]);
  });

  test("runs before the unique guard and the existing validation owner", () => {
    const client = integratedClient().$extends({
      name: "unique-and-validation",
      request({ operation }) {
        if (operation === "findUnique") {
          return { where: { id: "from-request" } };
        }
        if (operation === "findMany") return { take: "not-a-number" };
        return {};
      },
    });

    const findUnique = Reflect.get(client.entry, "findUnique");
    if (typeof findUnique !== "function") {
      throw new Error("Expected findUnique");
    }
    const unique: unknown = Reflect.apply(findUnique, client.entry, [
      { where: {} },
    ]);
    if (unique === null || typeof unique !== "object") {
      throw new Error("Expected a pending operation");
    }
    expect(() => transactionOperation(unique).prepare()).not.toThrow();

    const invalid = client.entry.findMany();
    expect(() => transactionOperation(invalid).prepare()).toThrow(
      ValidationError
    );
  });

  test("lets the unique guard refuse a patched empty selector before validation", () => {
    const client = integratedClient().$extends({
      name: "empty-unique",
      request() {
        return { where: {}, unknownPatchedKey: true };
      },
    });
    const operation = client.entry.findUnique({ where: { id: "caller" } });

    expect(() => transactionOperation(operation).prepare()).toThrow(
      "whereUnique requires at least one unique discriminator"
    );
  });

  test("leaves unknown patched keys to core operation validation", () => {
    const client = integratedClient().$extends({
      name: "unknown-patch",
      request() {
        return { unknownPatchedKey: true };
      },
    });
    const operation = client.entry.findMany();

    expect(() => transactionOperation(operation).prepare()).toThrow(
      ValidationError
    );
  });

  test("applies client default omit after request preparation", () => {
    let handlerInput: Readonly<Record<string, unknown>> | undefined;
    const client = integratedClient()
      .$extends(
        defaultOmit<typeof integratedSchema>()({ entry: { secret: true } })
      )
      .$extends({
        name: "omit-order",
        request({ input }) {
          handlerInput = input;
          return { take: 1 };
        },
      });

    const statement = transactionOperation(client.entry.findMany()).prepare();
    expect(handlerInput).toBeDefined();
    expect(Object.hasOwn(handlerInput ?? {}, "omit")).toBe(false);
    expect(statement?.sql).not.toContain('"secret"');
  });

  test("preserves caller input and nested value identity", () => {
    const where = { category: "caller" };
    const select = { id: true };
    const args = { where, select };
    const descriptors = Object.getOwnPropertyDescriptors(args);
    const client = integratedClient().$extends({
      name: "caller-preservation",
      request: {
        entry: {
          findMany() {
            return { take: 2 };
          },
        },
      },
    });

    transactionOperation(client.entry.findMany(args)).prepare();

    expect(args).toEqual({ where, select });
    expect(args.where).toBe(where);
    expect(args.select).toBe(select);
    expect(Object.getOwnPropertyDescriptors(args)).toEqual(descriptors);
  });

  test("protects every result-shape family through the public client", () => {
    const protectedKeys = new Map<string, readonly string[]>([
      ["findMany", ["select"]],
      ["findFirst", ["include"]],
      ["findUnique", ["omit"]],
      ["create", ["select"]],
      ["count", ["select"]],
      ["aggregate", ["_count", "_avg", "_sum", "_min", "_max"]],
      ["groupBy", ["by", "_count", "_avg", "_sum", "_min", "_max"]],
      ["createMany", ["select", "omit"]],
      ["updateMany", ["select", "omit"]],
      ["deleteMany", ["select", "omit"]],
    ]);
    const seen = new Set<string>();
    const protectedPatch = (
      operation: Operations
    ): Readonly<Record<never, never>> => {
      switch (operation) {
        case "aggregate":
          return { _count: { missing: true } };
        case "groupBy":
          return { by: ["missing"], _sum: { missing: true } };
        case "findFirst":
          return { include: { missing: true } };
        case "findUnique":
          return { omit: { missing: true } };
        case "createMany":
        case "updateMany":
        case "deleteMany":
          return {
            select: { missing: true },
            omit: { missing: true },
          };
        default:
          return { select: { missing: true } };
      }
    };
    const client = integratedClient().$extends({
      name: "projection-attacker",
      request({ operation, input }) {
        const keys = protectedKeys.get(operation);
        if (!keys) return {};
        seen.add(operation);
        for (const key of keys) expect(Object.hasOwn(input, key)).toBe(false);
        return protectedPatch(operation);
      },
    });

    const createData = {
      id: "entry-1",
      secret: "secret",
      views: 1,
      category: "category",
      authorId: "author-1",
    };
    const operations = [
      client.entry.findMany({ select: { id: true } }),
      client.entry.findFirst({ include: { author: true } }),
      client.entry.findUnique({
        where: { id: "entry-1" },
        omit: { secret: true },
      }),
      client.entry.create({ data: createData, select: { id: true } }),
      client.entry.count({ select: { id: true } }),
      client.entry.aggregate({ _count: true }),
      client.entry.groupBy({ by: ["category"], _count: true }),
      client.entry.createMany({ data: [createData], select: { id: true } }),
      client.entry.updateMany({
        where: { id: "entry-1" },
        data: { secret: "updated" },
        select: { id: true },
      }),
      client.entry.deleteMany({
        where: { id: "entry-1" },
        select: { id: true },
      }),
    ];

    for (const operation of operations) {
      expect(() => transactionOperation(operation).prepare()).not.toThrow();
    }
    expect(seen).toEqual(new Set(protectedKeys.keys()));
  });

  test("runs through array prepare admission and never for raw calls", async () => {
    let requestCalls = 0;
    const client = integratedClient().$extends({
      name: "array-admission",
      request() {
        requestCalls += 1;
        return {};
      },
    });
    const operation = client.entry.findMany();
    expect(requestCalls).toBe(0);

    await expect(client.$transaction([operation])).resolves.toEqual([[]]);
    expect(requestCalls).toBe(1);
    await expect(client.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    expect(requestCalls).toBe(1);
  });

  test("memoizes a request failure across wrapped lifecycle entry points", async () => {
    const cause = new Error("request refused");
    let calls = 0;
    const client = integratedClient()
      .$extends(cache({ driver: new MemoryCache() }))
      .$extends({
        name: "memoized-failure",
        request: {
          entry: {
            create() {
              calls += 1;
              throw cause;
            },
          },
        },
      });
    const operation = client.entry.create({
      data: {
        id: "entry-1",
        secret: "secret",
        views: 1,
        category: "category",
        authorId: "author-1",
      },
    });

    let firstFailure: unknown;
    try {
      transactionOperation(operation).prepare();
      expect.unreachable();
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(QueryError);
    if (!(firstFailure instanceof QueryError)) throw firstFailure;
    expect(calls).toBe(1);
    expect(() => operation.buildStatement()).toThrow(firstFailure);
    await expect(operation).rejects.toBe(firstFailure);
    expect(calls).toBe(1);
  });

  test("keeps the no-request-handler argument identity path", () => {
    const args = { where: { category: "caller" } };
    const base = integratedClient();
    const extended = base.$extends({
      name: "client-only",
      client: () => ({ $ready: () => true }),
    });

    expect(base.entry.findMany(args).getArgs()).toBe(args);
    expect(extended.entry.findMany(args).getArgs()).toBe(args);
  });
});
