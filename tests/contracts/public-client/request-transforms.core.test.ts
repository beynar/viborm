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
import { s } from "@schema";
import {
  around,
  call,
  extension,
  target as extTarget,
  methods,
  models,
  target,
  watch,
} from "@src/index";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test } from "vitest";

function _captureQueryError(action: () => unknown): QueryError {
  try {
    action();
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("Expected a QueryError");
}

function _requireTransformedInput(input: object | undefined): object {
  if (input === undefined) throw new Error("Expected transformed input");
  return input;
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

const _projectionCases: readonly {
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
  test("shows a GeoPoint distance projection to an extension, which reads it", async () => {
    let sawSelect = false;
    const client = integratedClient().$extends(
      extension(
        "point-distance-projection",
        call(
          (c) => {
            sawSelect = Object.hasOwn(c.args, "select");
            c.set({});
          },
          extTarget("entry", "findMany")
        )
      )
    );

    await expect(
      client.entry.findMany({
        select: {
          location: {
            _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
          },
        },
      })
    ).resolves.toEqual([]);
    expect(sawSelect).toBe(true);
  });

  test("stays lazy and resolves one application-ordered patch chain once", async () => {
    const calls: string[] = [];
    const base = integratedClient();
    const client = base
      .$extends(
        extension(
          "A",
          call(
            (c) => {
              calls.push("A");
              expect(c.args.take).toBeUndefined();
              c.set({ take: 3 });
            },
            extTarget("entry", "findMany")
          )
        )
      )
      .$extends(
        extension(
          "B",
          call((c) => {
            if (c.operation !== "findMany") {
              c.set({});
              return;
            }
            calls.push("B");
            expect(c.args.take).toBe(3);
            c.set({ skip: 1 });
          }, target(models))
        )
      )
      .$extends(
        extension(
          "C",
          call(
            (c) => {
              calls.push("C");
              expect(c.args.skip).toBe(1);
              c.set({ where: { category: "patched" } });
            },
            extTarget("entry", "findMany")
          )
        )
      );

    const delegate = client.entry;
    const method = delegate.findMany;
    const operation = method({ where: { category: "caller" } });
    expect(calls).toEqual([]);

    transactionOperation(operation).prepare();
    operation.buildStatement();
    transactionOperation(operation).prepare();
    expect(calls).toEqual(["A", "B", "C"]);

    const awaited = client.entry.findMany();
    expect(calls).toEqual(["A", "B", "C"]);
    await awaited;
    expect(calls).toEqual(["A", "B", "C", "A", "B", "C"]);
  });

  test("runs before the unique guard and the existing validation owner", () => {
    const client = integratedClient().$extends(
      extension(
        "unique-and-validation",
        call((c) => {
          if (c.operation === "findUnique") {
            c.set({ where: { id: "from-request" } });
            return;
          }
          if (c.operation === "findMany") {
            c.set({ take: "not-a-number" });
            return;
          }
          c.set({});
        }, target(models))
      )
    );

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
    const client = integratedClient().$extends(
      extension(
        "empty-unique",
        call((c) => {
          c.set({ where: {}, unknownPatchedKey: true });
        }, target(models))
      )
    );
    const operation = client.entry.findUnique({ where: { id: "caller" } });

    expect(() => transactionOperation(operation).prepare()).toThrow(
      "whereUnique requires at least one unique discriminator"
    );
  });

  test("leaves unknown patched keys to core operation validation", () => {
    const client = integratedClient().$extends(
      extension(
        "unknown-patch",
        call((c) => {
          c.set({ unknownPatchedKey: true });
        }, target(models))
      )
    );
    const operation = client.entry.findMany();

    expect(() => transactionOperation(operation).prepare()).toThrow(
      ValidationError
    );
  });

  test("applies client default omit after request preparation", () => {
    let handlerInput: Readonly<Record<string, unknown>> | undefined;
    const client = integratedClient()
      .$extends(defaultOmit({ entry: { secret: true } }))
      .$extends(
        extension(
          "omit-order",
          call((c) => {
            handlerInput = c.args;
            c.set({ take: 1 });
          }, target(models))
        )
      );

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
    const client = integratedClient().$extends(
      extension(
        "caller-preservation",
        call(
          (c) => {
            c.set({ take: 2 });
          },
          extTarget("entry", "findMany")
        )
      )
    );

    transactionOperation(client.entry.findMany(args)).prepare();

    expect(args).toEqual({ where, select });
    expect(args.where).toBe(where);
    expect(args.select).toBe(select);
    expect(Object.getOwnPropertyDescriptors(args)).toEqual(descriptors);
  });

  test("shows every result-shape key and refuses a patch of one, through the public client", () => {
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
    const client = integratedClient().$extends(
      extension(
        "projection-attacker",
        call((c) => {
          const keys = protectedKeys.get(c.operation);
          if (!keys) {
            c.set({});
            return;
          }
          seen.add(c.operation);
          // The call's own shape keys are shown as it passed them.
          expect(keys.some((key) => Object.hasOwn(c.args, key))).toBe(true);
          expect(() => c.set(protectedPatch(c.operation))).toThrow(
            "decides the result's shape"
          );
        }, target(models))
      )
    );

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

  test("runs through array prepare admission, and once for a raw statement when it has no target", async () => {
    let requestCalls = 0;
    const client = integratedClient().$extends(
      extension(
        "array-admission",
        call((c) => {
          requestCalls += 1;
          if (c.kind === "model") c.set({});
        })
      )
    );
    const operation = client.entry.findMany();
    expect(requestCalls).toBe(0);

    await expect(client.$transaction([operation])).resolves.toEqual([[]]);
    expect(requestCalls).toBe(1);
    await expect(client.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    expect(requestCalls).toBe(2);
    const raw = client.$executeRawUnsafe("DELETE FROM entry");
    await expect(client.$transaction([raw])).resolves.toEqual([0]);
    expect(requestCalls).toBe(3);
  });

  test("a raw statement shows its input, refuses a patch and a watch, and reaches no targeted part", async () => {
    const seen: unknown[] = [];
    const client = integratedClient()
      .$extends(
        extension(
          "targeted",
          call(() => {
            seen.push("targeted");
          }, extTarget(models)),
          around(() => {
            seen.push("around targeted");
          }, extTarget("entry"))
        )
      )
      .$extends(
        extension(
          "raw",
          call((c) => {
            seen.push([c.kind, c.model, c.operation, c.args]);
          })
        )
      );
    await client.$queryRawUnsafe("SELECT $1", 1);
    expect(seen).toEqual([
      ["raw", undefined, "$queryRawUnsafe", { sql: "SELECT $1", params: [1] }],
    ]);

    const patching = integratedClient().$extends(
      extension(
        "patching",
        call((c) => c.set({ take: 1 }), target(models))
      )
    );
    await expect(patching.$queryRawUnsafe("SELECT 1")).rejects.toThrow(
      'Extension "patching" request handler for $queryRawUnsafe set no model call\'s arguments.'
    );

    const watching = integratedClient().$extends(
      extension(
        "watching",
        around((c) => {
          watch(c, { wants: () => true, rows: () => undefined });
        })
      )
    );
    const refusal = await watching.$executeRawUnsafe("DELETE FROM entry").then(
      () => undefined,
      (error: unknown) => error
    );
    // A raw statement writes no rows to tell: the registration is refused.
    expect(refusal).toBeInstanceOf(QueryError);
    expect(refusal).toMatchObject({
      message:
        'Extension "watching" request handler for $executeRawUnsafe threw.',
    });
  });

  test("an around without a target runs its first moment once for a raw statement, its second around it", async () => {
    const seen: string[] = [];
    const client = integratedClient().$extends(
      extension(
        "both",
        around((c) => {
          seen.push(`first ${c.operation}`);
          return (run) => {
            seen.push("second");
            return run();
          };
        })
      )
    );
    await expect(client.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    await expect(
      client.$transaction([client.$queryRawUnsafe("SELECT 2")])
    ).resolves.toEqual([[]]);
    expect(seen).toEqual([
      "first $queryRawUnsafe",
      "second",
      "first $queryRawUnsafe",
      "second",
    ]);
  });

  test("a target naming a model or an operation the client lacks is refused at $extends", () => {
    const base = integratedClient();
    expect(() =>
      base.$extends(
        extension(
          "unknown-model",
          call(() => undefined, extTarget("nobody" as never))
        )
      )
    ).toThrow(
      'Extension "unknown-model" target names unknown model or operation "nobody".'
    );
    expect(() =>
      base.$extends(
        extension(
          "unknown-operation",
          call(() => undefined, extTarget("entry", "findAll" as never))
        )
      )
    ).toThrow(
      'Extension "unknown-operation" target names unknown model or operation "findAll".'
    );
  });

  test("memoizes a request failure across wrapped lifecycle entry points", async () => {
    const cause = new Error("request refused");
    let calls = 0;
    const client = integratedClient()
      .$extends(cache({ driver: new MemoryCache() }))
      .$extends(
        extension(
          "memoized-failure",
          call(
            (_c) => {
              calls += 1;
              throw cause;
            },
            extTarget("entry", "create")
          )
        )
      );
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
    const extended = base.$extends(
      extension(
        "client-only",
        methods((_scope) => ({ $ready: () => true }))
      )
    );

    expect(base.entry.findMany(args).getArgs()).toBe(args);
    expect(extended.entry.findMany(args).getArgs()).toBe(args);
  });
});
