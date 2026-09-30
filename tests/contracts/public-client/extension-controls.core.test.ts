/**
 * Declared controls at runtime (extension-capabilities plan v3.1 §2.1, §2.4).
 *
 * A control is an argument an extension declares. Core removes it from the
 * call's arguments and admits it once, before any request handler runs; the
 * declaring extension's handlers read it in `context.controls`, nobody else
 * sees it, and no request patch may name one. The official cache's mutation
 * `cache` argument is the first control (ruling 7): its provider-backed pins
 * are `official-cache-invalidation.test.ts`. A cached read that admitted a
 * control is keyed on it; one that admitted none keeps today's key.
 *
 * Runs on in-memory SQLite. Calls that TypeScript refuses go through
 * `Reflect.apply`, as a JavaScript caller or a held value would.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { CacheEntry } from "@cache";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import {
  ClientInitializationError,
  QueryError,
  ValidationError,
} from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
  deletedById: s.string().nullable(),
});
const schema = { user, post };

/** A schema no database backs: definitions are refused before any I/O. */
const audited = s.model({
  id: s.string().id(),
  note: s.string(),
  stamps: s.dateTime().array(),
  checkedAt: s.dateTime().nullable(),
  payload: s.blob().nullable(),
  ownerId: s.string(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
});
const owner = s.model({
  id: s.string().id(),
  audited: s.toMany(() => audited),
});
const definitionSchema = { audited, owner };

const clients: { $disconnect(): Promise<void> }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

async function seededBase() {
  const base = createClient({ schema, driver: createInMemorySQLite3Driver() });
  clients.push(base);
  await syncLiveSchema(base);
  await base.user.create({ data: { id: "u1", name: "Ada" } });
  await base.post.create({
    data: { id: "p1", title: "live", authorId: "u1" },
  });
  return base;
}

function definitionClient() {
  const client = createClient({
    schema: definitionSchema,
    driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
  });
  clients.push(client);
  return client;
}

/** Apply a definition TypeScript would refuse, as JavaScript would. */
function applyUnchecked(client: object, definition: unknown): object {
  return Reflect.apply(Reflect.get(client, "$extends"), client, [definition]);
}

/** Call one delegate method with arguments TypeScript would refuse. */
function callUnchecked(
  client: object,
  model: string,
  operation: string,
  args: unknown
): Promise<unknown> {
  const delegate = Reflect.get(client, model);
  return Promise.resolve(
    Reflect.apply(Reflect.get(delegate, operation), delegate, [args])
  );
}

async function failure(pending: PromiseLike<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

function refusal(action: () => unknown): ClientInitializationError {
  try {
    action();
  } catch (error) {
    if (error instanceof ClientInitializationError) return error;
    throw error;
  }
  throw new Error("expected the definition to be refused");
}

/** A proxy whose every inspection throws, even `Array.isArray`. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Standard Schema whose validator the test controls. */
function standard<Value>(
  validate: (value: unknown) => unknown
): StandardSchemaV1<Value> {
  return {
    "~standard": {
      version: 1,
      vendor: "extension-controls-test",
      validate: (value) => validate(value) as StandardSchemaV1.Result<Value>,
    },
  };
}

class KeyRecordingCache extends MemoryCache {
  readonly keys: string[] = [];

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.keys.push(key);
    await super.set(key, storageTtl, entry);
  }
}

const NAMED_CONTROL =
  /named control "(reason|deleted)"|returned an unreadable patch/;

const softRows = {
  name: "rows",
  rows: {
    control: "deleted",
    default: "without",
    models: {
      post: {
        without: { root: { deletedAt: null }, related: { deletedAt: null } },
        with: {},
        only: {
          root: { deletedAt: { not: null } },
          related: { deletedAt: null },
        },
      },
    },
  },
} as const;

describe("controls: admission and ownership", () => {
  test("two contributing extensions: each owner's handlers see only their own admitted controls; inputs never carry one", async () => {
    const seen: string[] = [];
    const record = (label: string, context: object) => {
      const input = Reflect.get(context, "input");
      const leaked = ["deleted", "reason", "region"].filter((key) =>
        Reflect.has(input, key)
      );
      seen.push(
        `${label}:${JSON.stringify(Reflect.get(context, "controls") ?? null)}:${leaked.join(",")}`
      );
    };
    // `rows` goes first: it may not follow a model-mapped query handler.
    const db = (await seededBase())
      .$extends({ ...softRows })
      .$extends({
        name: "audit",
        controls: { reason: { schema: standard((value) => ({ value })) } },
        request: {
          post: {
            findMany(context) {
              record("audit-request", context);
              return {};
            },
          },
        },
        query: {
          post: {
            findMany(context) {
              record("audit-query", context);
              return context.proceed();
            },
          },
        },
      })
      .$extends({
        name: "tenant",
        controls: { region: { oneOf: ["eu", "us"], on: "reads" } },
        request(context) {
          record("tenant-request", context);
          return {};
        },
      })
      .$extends({
        name: "bystander",
        request(context) {
          record("bystander-request", context);
          return {};
        },
        query(context) {
          record("bystander-query", context);
          return context.proceed();
        },
      });

    await expect(
      db.post.findMany({
        region: "eu",
        reason: "audit",
        select: { id: true },
      })
    ).resolves.toEqual([{ id: "p1" }]);

    expect(seen).toEqual([
      'audit-request:{"reason":"audit"}:',
      'tenant-request:{"region":"eu"}:',
      "bystander-request:null:",
      'audit-query:{"reason":"audit"}:',
      "bystander-query:null:",
    ]);

    seen.length = 0;
    await db.post.findMany({ select: { id: true } });
    // An absent plain control is not admitted; the rows control is admitted as
    // its default mode.
    expect(seen).toEqual([
      "audit-request:{}:",
      "tenant-request:{}:",
      "bystander-request:null:",
      "audit-query:{}:",
      "bystander-query:null:",
    ]);
  });

  test("the rows extension's own handlers read the admitted mode, default included", async () => {
    const modes: unknown[] = [];
    const db = (await seededBase()).$extends({
      ...softRows,
      query(context) {
        // A raw statement has no controls; a model operation's are typed here.
        if (context.kind === "model") modes.push(context.controls);
        return context.proceed();
      },
    });
    await db.post.findMany();
    await db.post.findMany({ deleted: "only" });
    await db.user.findMany({ deleted: "with" });
    expect(modes).toEqual([
      { deleted: "without" },
      { deleted: "only" },
      { deleted: "with" },
    ]);
  });

  test("a request patch naming a control is refused, its own or another extension's, before any provider work", async () => {
    const base = await seededBase();
    const patches: string[] = [];
    const cases = [
      // The declaring extension patches its own control.
      base.$extends({
        name: "own",
        controls: { reason: { oneOf: ["a", "b"] } },
        request() {
          patches.push("own");
          return { reason: "b" };
        },
      }),
      // An extension applied before the declaring one patches its control.
      base
        .$extends({
          name: "earlier",
          request() {
            patches.push("earlier");
            return Object.defineProperty({}, "reason", {
              enumerable: true,
              get() {
                patches.push("earlier-value-read");
                return "b";
              },
            });
          },
        })
        .$extends({
          name: "declaring",
          controls: { reason: { oneOf: ["a", "b"] } },
        }),
      // A patch whose descriptors cannot be read is still refused whole.
      base
        .$extends({ ...softRows })
        .$extends({
          name: "undescribed",
          request() {
            patches.push("undescribed");
            return new Proxy(
              { title: "t" },
              {
                getOwnPropertyDescriptor() {
                  throw new Error("descriptor trap");
                },
              }
            );
          },
        }),
      // A later extension patches the rows control.
      base
        .$extends({ ...softRows })
        .$extends({
          name: "later",
          request() {
            patches.push("later");
            return { deleted: "with" };
          },
        }),
    ];
    for (const client of cases) {
      const error = await failure(
        client.post.create({
          data: { id: "p-refused", title: "refused", authorId: "u1" },
        })
      );
      expect(error).toBeInstanceOf(QueryError);
      expect(String(error)).toMatch(NAMED_CONTROL);
    }
    expect(patches).toEqual(["own", "earlier", "undescribed", "later"]);
    await expect(
      base.post.findUnique({ where: { id: "p-refused" } })
    ).resolves.toBeNull();
  });

  test("an unplaced control and an undeclared key stay unknown keys; a value outside oneOf is a ValidationError at the control's path", async () => {
    const base = await seededBase();
    const db = base.$extends({
      name: "tenant",
      controls: { region: { oneOf: ["eu", "us"], on: "reads" } },
    });
    const placedOnWrite = await failure(
      callUnchecked(db, "post", "update", {
        where: { id: "p1" },
        data: { title: "t" },
        region: "eu",
      })
    );
    expect(placedOnWrite).toBeInstanceOf(ValidationError);
    const heldTypo = { regoin: "eu" } as const;
    expect(
      await failure(callUnchecked(db, "post", "findMany", heldTypo))
    ).toBeInstanceOf(ValidationError);
    expect(
      await failure(callUnchecked(base, "post", "findMany", { region: "eu" }))
    ).toBeInstanceOf(ValidationError);

    const outside = await failure(
      callUnchecked(db, "post", "findMany", { region: "moon" })
    );
    expect(outside).toBeInstanceOf(ValidationError);
    if (!(outside instanceof ValidationError)) throw outside;
    expect(outside.issues).toEqual([
      { path: "region", message: 'Control "region" must be one of "eu", "us"' },
    ]);
    expect(outside.operation).toBe("findMany");
  });

  test("a schema control: issues are a ValidationError at its path; a throwing, async, malformed or unreadable validator is a QueryError; a VibORMError passes through", async () => {
    const base = await seededBase();
    const typed = new ValidationError({ kind: "registry" }, [
      { path: "x", message: "owned" },
    ]);
    const hostile = new Proxy(new Error("hostile"), {
      getPrototypeOf() {
        throw new Error("prototype read");
      },
    });
    const withValidator = (
      name: string,
      validate: (value: unknown) => unknown
    ) =>
      applyUnchecked(base, {
        name,
        controls: { reason: { schema: standard(validate) } },
      });

    const invalid = await failure(
      callUnchecked(
        withValidator("issues", () => ({ issues: [{ message: "too short" }] })),
        "post",
        "findMany",
        { reason: "x" }
      )
    );
    expect(invalid).toBeInstanceOf(ValidationError);
    if (!(invalid instanceof ValidationError)) throw invalid;
    expect(invalid.issues).toEqual([
      { path: "reason", message: 'Control "reason" too short' },
    ]);

    const cases: ReadonlyArray<
      readonly [string, (value: unknown) => unknown, string]
    > = [
      [
        "throws",
        () => {
          throw new Error("validator bug");
        },
        "validator for post.findMany threw",
      ],
      [
        "throws-hostile",
        () => {
          throw hostile;
        },
        "threw",
      ],
      ["async", async (value) => ({ value }), "returned a promise"],
      ["malformed", () => 42, "returned a malformed result"],
      ["valueless", () => ({}), "returned a malformed result"],
      [
        "unreadable",
        () =>
          new Proxy(
            {},
            {
              has() {
                throw new Error("has trap");
              },
            }
          ),
        "returned an unreadable result",
      ],
    ];
    for (const [name, validate, message] of cases) {
      const error = await failure(
        callUnchecked(withValidator(name, validate), "post", "findMany", {
          reason: "x",
        })
      );
      expect(error, name).toBeInstanceOf(QueryError);
      expect(String(error), name).toContain(message);
    }

    expect(
      await failure(
        callUnchecked(
          withValidator("typed", () => {
            throw typed;
          }),
          "post",
          "findMany",
          { reason: "x" }
        )
      )
    ).toBe(typed);

    const unreadable = await failure(
      callUnchecked(
        withValidator("getter", (value) => ({ value })),
        "post",
        "findMany",
        Object.defineProperty({}, "reason", {
          enumerable: true,
          get() {
            throw new Error("getter");
          },
        })
      )
    );
    expect(unreadable).toBeInstanceOf(QueryError);
    expect(String(unreadable)).toContain(
      'control "reason" of post.findMany could not be read'
    );
  });

  test("arguments that cannot be inspected, and issues that cannot be read, still fail with their class", async () => {
    const base = await seededBase();
    const db = applyUnchecked(base, {
      name: "issues",
      controls: {
        reason: {
          schema: standard((value) => {
            if (value === "fine") return { value };
            if (value === "empty") return { issues: [] };
            if (value === "silent") return { issues: [{}] };
            if (value === "bare") return { issues: ["bare"] };
            return {
              issues: [
                new Proxy(
                  {},
                  {
                    get() {
                      throw new Error("issue trap");
                    },
                  }
                ),
              ],
            };
          }),
        },
      },
    });
    for (const reason of ["empty", "silent", "bare", "hostile"]) {
      const error = await failure(
        callUnchecked(db, "post", "findMany", { reason })
      );
      expect(error, reason).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw error;
      expect(error.issues).toEqual([
        { path: "reason", message: 'Control "reason" is invalid' },
      ]);
    }
    const unlisted = new Proxy(
      { reason: "fine" },
      {
        ownKeys() {
          throw new Error("keys trap");
        },
      }
    );
    const undescribed = new Proxy(
      { reason: "fine", take: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      }
    );
    for (const args of [unlisted, undescribed]) {
      const error = await failure(callUnchecked(db, "post", "findMany", args));
      expect(error).toBeInstanceOf(QueryError);
      expect(String(error)).toContain(
        "arguments of post.findMany could not be inspected for controls"
      );
    }
  });

  test("arguments that are not an object stay core's ValidationError, as on a client without controls", async () => {
    const base = await seededBase();
    const rows = applyUnchecked(base, softRows);
    const plain = applyUnchecked(base, {
      name: "plain",
      controls: { flag: { oneOf: ["a", "b"] } },
    });
    const cached = base.$extends(cache({ driver: new MemoryCache() }));
    const calls: ReadonlyArray<readonly [object, string, string, unknown]> = [
      [rows, "post", "findMany", "str"],
      [rows, "user", "count", 5],
      [plain, "post", "findMany", 5],
      [cached, "user", "create", "str"],
    ];
    for (const [client, model, operation, args] of calls) {
      const label = `${model}.${operation}(${String(args)})`;
      const expected = await failure(
        callUnchecked(base, model, operation, args)
      );
      const error = await failure(
        callUnchecked(client, model, operation, args)
      );
      expect(error, label).toBeInstanceOf(ValidationError);
      expect(String(error), label).toBe(String(expected));
      expect(String(error), label).toContain("Expected object");
    }
  });

  test("a control is admitted once, before request handlers, and memoized across lifecycle entry points", async () => {
    const timeline: string[] = [];
    const db = (await seededBase()).$extends({
      name: "counted",
      controls: {
        reason: {
          schema: standard((value) => {
            timeline.push(`validate:${String(value)}`);
            return { value };
          }),
        },
      },
      request() {
        timeline.push("request");
        return {};
      },
    });
    const operation = db.post.findMany({ reason: "why", select: { id: true } });
    expect(timeline).toEqual([]);
    await Promise.all([operation, operation]);
    await operation;
    expect(timeline).toEqual(["validate:why", "request"]);
  });

  test("an array transaction admits every member's controls before any provider effect", async () => {
    const timeline: string[] = [];
    const base = await seededBase();
    const db = base
      .$extends({
        name: "guarded",
        controls: {
          reason: {
            schema: standard((value) => {
              timeline.push(`validate:${String(value)}`);
              return value === "ok"
                ? { value }
                : { issues: [{ message: "is not ok" }] };
            }),
            on: "writes",
          },
        },
      })
      .$extends({
        name: "statements",
        statement(context) {
          timeline.push(`statement:${String(context.operation)}`);
          return context.statement;
        },
      });
    const error = await failure(
      db.$transaction([
        db.post.create({
          data: { id: "p-first", title: "first", authorId: "u1" },
          reason: "ok",
        }),
        db.post.create({
          data: { id: "p-second", title: "second", authorId: "u1" },
          reason: "bad",
        }),
      ])
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(timeline).toEqual(["validate:ok", "validate:bad"]);
    await expect(base.post.count()).resolves.toBe(1);
  });
});

describe("controls: a defined extension", () => {
  test("keeps its controls, rows and deletion when a client applies it", async () => {
    const seen: unknown[] = [];
    const defined = defineExtension({
      name: "defined",
      controls: {
        mode: { oneOf: ["soft", "hard"] },
        reason: { schema: standard((value) => ({ value })), on: ["findMany"] },
      },
      rows: softRows.rows,
      deletion: {
        removeWhen: { mode: "hard" },
        models: { post: { at: "deletedAt" } },
      },
      query(context) {
        if (context.kind === "model") seen.push(context.controls);
        return context.proceed();
      },
    });
    const db = (await seededBase()).$extends(defined);
    await callUnchecked(db, "post", "findMany", {
      reason: "why",
      deleted: "with",
    });
    await callUnchecked(db, "post", "deleteMany", {
      where: { id: "none" },
      mode: "hard",
    });
    expect(seen).toEqual([
      { reason: "why", deleted: "with" },
      { mode: "hard", deleted: "without" },
    ]);
    expect(
      await failure(callUnchecked(db, "post", "findMany", { deleted: "gone" }))
    ).toBeInstanceOf(ValidationError);
  });
});

describe("controls: placement", () => {
  test("the rows control is on every model's candidate operations and no create; the removeWhen control only on managed deletes", async () => {
    const base = await seededBase();
    // A later extension's every-model control joins the managed model's
    // lists without dropping the model-specific one.
    const db = base
      .$extends({
        ...softRows,
        name: "managed",
        controls: { mode: { oneOf: ["soft", "hard"] } },
        deletion: {
          removeWhen: { mode: "hard" },
          models: { post: { at: "deletedAt" } },
        },
      })
      .$extends({
        name: "later",
        controls: { reason: { oneOf: ["why"], on: "writes" } },
      });
    await expect(db.user.findMany({ deleted: "with" })).resolves.toHaveLength(
      1
    );
    await expect(db.user.count({ deleted: "only" })).resolves.toBe(1);
    expect(
      await failure(
        callUnchecked(db, "user", "create", {
          data: { id: "u2", name: "Grace" },
          deleted: "with",
        })
      )
    ).toBeInstanceOf(ValidationError);
    for (const [model, operation, args] of [
      ["user", "delete", { where: { id: "u1" }, mode: "hard" }],
      ["post", "findMany", { mode: "hard" }],
      ["post", "update", { where: { id: "p1" }, data: {}, mode: "hard" }],
    ] as const) {
      expect(
        await failure(callUnchecked(db, model, operation, args)),
        `${model}.${operation}`
      ).toBeInstanceOf(ValidationError);
    }
    await expect(
      db.post.deleteMany({ where: { id: "none" }, mode: "hard", reason: "why" })
    ).resolves.toEqual({ count: 0 });
  });
});

describe("controls: definitions refused when applied", () => {
  const client = definitionClient;
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      "unknown control member",
      { name: "x", controls: { a: { oneOf: ["1"], of: 1 } } },
      'controls.a has unknown member "of"',
    ],
    [
      "empty oneOf",
      { name: "x", controls: { a: { oneOf: [] } } },
      "controls.a.oneOf must be a non-empty array",
    ],
    [
      "repeated oneOf value",
      { name: "x", controls: { a: { oneOf: ["1", "1"] } } },
      "must hold distinct strings",
    ],
    [
      "oneOf and schema",
      {
        name: "x",
        controls: {
          a: { oneOf: ["1"], schema: standard((value) => ({ value })) },
        },
      },
      'must declare exactly one of "oneOf" or "schema"',
    ],
    [
      "schema without a validator",
      { name: "x", controls: { a: { schema: { "~standard": {} } } } },
      "controls.a.schema must be a Standard Schema",
    ],
    [
      "unknown placement",
      { name: "x", controls: { a: { oneOf: ["1"], on: "everything" } } },
      'controls.a.on must be "reads"',
    ],
    [
      "unknown operation",
      { name: "x", controls: { a: { oneOf: ["1"], on: ["findAll"] } } },
      'controls.a.on names unknown operation "findAll"',
    ],
    [
      "a core argument name",
      { name: "x", controls: { where: { oneOf: ["1"] } } },
      'control "where" takes the name of a core operation argument',
    ],
    [
      "an upsert-only core argument name",
      { name: "x", controls: { targetWhere: { oneOf: ["1"] } } },
      'control "targetWhere" takes the name of a core operation argument',
    ],
    [
      "a rows control named like a core argument",
      {
        name: "x",
        rows: { control: "take", default: "a", models: {} },
      },
      'control "take" takes the name of a core operation argument',
    ],
    [
      "rows.control equal to a controls name",
      {
        name: "x",
        controls: { deleted: { oneOf: ["a"] } },
        rows: { control: "deleted", default: "a", models: {} },
      },
      'control "deleted" is already declared on this client',
    ],
    [
      "unequal mode sets",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { audited: { a: {}, b: {} }, owner: { a: {} } },
        },
      },
      "rows.models.owner must declare the same modes as every other entry (a, b)",
    ],
    [
      "equal-sized but different mode sets",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { audited: { a: {}, b: {} }, owner: { a: {}, c: {} } },
        },
      },
      "rows.models.owner must declare the same modes as every other entry (a, b)",
    ],
    [
      "default outside the modes",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "c",
          models: { audited: { a: {} } },
        },
      },
      'rows.default "c" must be a mode every entry declares',
    ],
    [
      "rows naming an unknown model",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { ghost: { a: {} } },
        },
      },
      'rows.models names unknown model "ghost"',
    ],
    [
      "a row predicate on a relation",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { audited: { a: { related: { owner: null } } } },
        },
      },
      'names relation "audited.owner"; it takes scalar fields only',
    ],
    [
      "a row predicate on an unknown field",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { audited: { a: { root: { gone: null } } } },
        },
      },
      'rows.models.audited.a.root names unknown field "audited.gone"',
    ],
    [
      "a row entry with another purpose",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { audited: { a: { where: {} } } },
        },
      },
      'rows.models.audited.a has unknown member "where"',
    ],
    [
      "a row predicate that is not plain data",
      {
        name: "x",
        rows: {
          control: "deleted",
          default: "a",
          models: { audited: { a: { root: { note: new Map() } } } },
        },
      },
      "rows.models.audited.a.root.note must be plain data",
    ],
    [
      "removeWhen naming no control",
      { name: "x", deletion: { removeWhen: { mode: "hard" }, models: {} } },
      'deletion.removeWhen names "mode", which its controls do not declare',
    ],
    [
      "removeWhen naming a schema control",
      {
        name: "x",
        controls: { mode: { schema: standard((value) => ({ value })) } },
        deletion: { removeWhen: { mode: "hard" }, models: {} },
      },
      'names control "mode", which must declare "oneOf"',
    ],
    [
      "removeWhen value outside oneOf",
      {
        name: "x",
        controls: { mode: { oneOf: ["soft", "hard"] } },
        deletion: { removeWhen: { mode: "purge" }, models: {} },
      },
      'deletion.removeWhen.mode must be one of control "mode"\'s values',
    ],
    [
      "`on` on the removeWhen control",
      {
        name: "x",
        controls: { mode: { oneOf: ["soft", "hard"], on: "writes" } },
        deletion: { removeWhen: { mode: "hard" }, models: {} },
      },
      'control "mode" is placed by deletion.removeWhen and may not declare "on"',
    ],
    [
      "deletion naming an unknown model",
      { name: "x", deletion: { models: { ghost: {} } } },
      'deletion.models names unknown model "ghost"',
    ],
    [
      "at on an unknown field",
      { name: "x", deletion: { models: { audited: { at: "gone" } } } },
      'deletion.models.audited.at names unknown field "audited.gone"',
    ],
    [
      "at on a non-DateTime field",
      { name: "x", deletion: { models: { audited: { at: "note" } } } },
      'names "audited.note", which is not a single DateTime field',
    ],
    [
      "at on a DateTime list",
      { name: "x", deletion: { models: { audited: { at: "stamps" } } } },
      'names "audited.stamps", which is not a single DateTime field',
    ],
    [
      "assign naming a relation",
      {
        name: "x",
        deletion: { models: { audited: { assign: { owner: null } } } },
      },
      'deletion.models.audited.assign names relation "audited.owner"',
    ],
    [
      "assign naming the at field",
      {
        name: "x",
        deletion: {
          models: {
            audited: { at: "checkedAt", assign: { checkedAt: null } },
          },
        },
      },
      'assign names "checkedAt", the field "at" stamps',
    ],
    [
      "an unknown deletion member",
      { name: "x", deletion: { models: {}, eligible: {} } },
      'deletion has unknown member "eligible"',
    ],
    [
      "a member that is not an object",
      { name: "x", rows: 5 },
      "rows must be an object",
    ],
    [
      "a control name that is a symbol",
      { name: "x", controls: { [Symbol("hidden")]: { oneOf: ["a"] } } },
      "controls contains a symbol key",
    ],
    [
      "a rows control that is not a name",
      { name: "x", rows: { control: 5, default: "a", models: {} } },
      "rows.control must be a non-empty string",
    ],
    [
      "a schema that is not an object",
      { name: "x", controls: { a: { schema: 5 } } },
      "controls.a.schema must be a Standard Schema",
    ],
    [
      "a schema without its standard member",
      { name: "x", controls: { a: { schema: {} } } },
      "controls.a.schema must be a Standard Schema",
    ],
    [
      "a oneOf value that is not finite",
      { name: "x", controls: { a: { oneOf: [1, Number.NaN] } } },
      "must hold distinct strings, finite numbers or booleans",
    ],
    [
      "a controls member that is a revoked proxy",
      { name: "x", controls: revokedProxy() },
      "controls could not be read",
    ],
    [
      "rows.models that is a revoked proxy",
      {
        name: "x",
        rows: { control: "deleted", default: "a", models: revokedProxy() },
      },
      "rows.models could not be read",
    ],
    [
      "a control schema that is a revoked proxy",
      { name: "x", controls: { a: { schema: revokedProxy() } } },
      "controls.a.schema could not be read",
    ],
    [
      "an empty removeWhen",
      {
        name: "x",
        controls: { mode: { oneOf: ["hard"] } },
        deletion: { removeWhen: {}, models: { audited: { assign: {} } } },
      },
      "deletion.removeWhen must name a control",
    ],
    [
      "an assigned function",
      {
        name: "x",
        deletion: { models: { audited: { assign: { note: () => "n" } } } },
      },
      "deletion.models.audited.assign.note must be plain data",
    ],
    [
      "an assignment that contains itself",
      (() => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        return {
          name: "x",
          deletion: { models: { audited: { assign: { note: cycle } } } },
        };
      })(),
      "deletion.models.audited.assign.note.self must not contain itself",
    ],
    [
      "an unreadable assignment",
      {
        name: "x",
        deletion: {
          models: {
            audited: {
              assign: Object.defineProperty({}, "note", {
                enumerable: true,
                get() {
                  throw new Error("getter");
                },
              }),
            },
          },
        },
      },
      "deletion.models.audited.assign.note could not be read",
    ],
  ];
  test.each(cases)("%s", (_label, definition, message) => {
    const error = refusal(() => applyUnchecked(client(), definition));
    expect(error.message).toContain(message);
  });

  test("names are one space per chain, and one deletion entry per model", () => {
    const base = definitionClient();
    const first = applyUnchecked(base, {
      name: "first",
      controls: { mode: { oneOf: ["a"] } },
      deletion: { models: { audited: { at: "checkedAt" } } },
    });
    expect(
      refusal(() =>
        applyUnchecked(first, {
          name: "second",
          rows: { control: "mode", default: "a", models: {} },
        })
      ).message
    ).toContain('control "mode" is already declared on this client');
    expect(
      refusal(() =>
        applyUnchecked(first, {
          name: "third",
          deletion: { models: { audited: { assign: { note: "gone" } } } },
        })
      ).message
    ).toContain(
      'deletion names model "audited", which extension "first" already manages'
    );
  });

  test("rows cannot follow a result consumer", () => {
    const consumer = definitionClient().$extends({
      name: "consumer",
      model: { audited: () => ({ ping: () => "pong" }) },
    });
    expect(
      refusal(() =>
        applyUnchecked(consumer, {
          name: "late-rows",
          rows: { control: "deleted", default: "a", models: {} },
        })
      ).message
    ).toContain("declares rows, which cannot follow");
  });

  test("a definition is read once: getters run once, proxies are contained, and later mutation changes nothing", async () => {
    const reads: string[] = [];
    const values = ["eu", "us"];
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const definition = {
      name: "hostile",
      get controls() {
        reads.push("controls");
        return {
          get region() {
            reads.push("region");
            return { oneOf: values, on: "reads" };
          },
        };
      },
      deletion: {
        models: { post: { at: "deletedAt", assign: { deletedById: "x" } } },
      },
    };
    const base = await seededBase();
    const db = applyUnchecked(base, definition);
    expect(reads).toEqual(["controls", "region"]);
    values.push("moon");
    expect(
      await failure(callUnchecked(db, "post", "findMany", { region: "moon" }))
    ).toBeInstanceOf(ValidationError);

    const bytes = new Uint8Array([1, 2]);
    const literals = appendResolvedExtension(
      undefined,
      {
        name: "literals",
        controls: { level: { oneOf: [1, true, "x"] } },
        // An undefined member is absent, as it is in any argument.
        deletion: {
          models: { audited: { assign: { payload: bytes, note: undefined } } },
        },
      },
      definitionSchema
    );
    expect(literals.controls?.operations.findMany?.[0]?.declaration).toEqual({
      oneOf: [1, true, "x"],
    });
    expect(Object.keys(literals.deletion?.audited?.assign ?? {})).toEqual([
      "payload",
    ]);
    const copiedBytes = literals.deletion?.audited?.assign.payload;
    expect(copiedBytes).toEqual(new Uint8Array([1, 2]));
    expect(copiedBytes).not.toBe(bytes);

    const chain = appendResolvedExtension(
      undefined,
      {
        name: "snapshot",
        deletion: {
          models: { post: { at: "deletedAt", assign: { deletedById: stamp } } },
        },
      },
      schema
    );
    const assigned = chain.deletion?.post?.assign.deletedById;
    expect(assigned).toBeInstanceOf(Date);
    expect(assigned).not.toBe(stamp);
    stamp.setTime(1);
    expect(assigned).toEqual(new Date("2026-01-01T00:00:00.000Z"));

    const trapped = new Proxy(
      { name: "trapped", controls: {} },
      {
        get(target, key) {
          if (key === "controls") throw new Error("trap");
          return Reflect.get(target, key);
        },
      }
    );
    expect(
      refusal(() => applyUnchecked(definitionClient(), trapped)).message
    ).toContain('member "controls" could not be read');
  });
});

describe("controls: the official cache", () => {
  test("its control comes from the cache, whatever controls a definition carrying its query spells", async () => {
    const official = cache({ driver: new MemoryCache() });
    const placedOn = (definition: unknown) =>
      appendResolvedExtension(undefined, definition, schema).controls
        ?.operations.create;
    const forgedCalls: unknown[] = [];
    const forged = {
      name: official.name,
      query: official.query,
      controls: {
        cache: {
          schema: standard((value) => {
            forgedCalls.push(value);
            return { value };
          }),
          on: "writes",
        },
        extra: { oneOf: ["x"] },
      },
    };
    for (const definition of [
      official,
      { name: official.name, query: official.query },
      forged,
    ]) {
      const placed = placedOn(definition);
      expect(placed?.map((control) => control.name)).toEqual(["cache"]);
      expect(placed?.[0]?.declaration).toBe(official.controls.cache);
    }

    const base = await seededBase();
    for (const definition of [
      {
        name: official.name,
        query: cache({ driver: new MemoryCache() }).query,
      },
      { ...forged, query: cache({ driver: new MemoryCache() }).query },
    ]) {
      const db = applyUnchecked(base, definition);
      const id = `u-${String(forgedCalls.length)}-${String(Math.random())}`;
      await expect(
        callUnchecked(db, "user", "create", {
          data: { id, name: "Cached" },
          cache: { autoInvalidate: true },
        })
      ).resolves.toMatchObject({ id });
      const refused = await failure(
        callUnchecked(db, "user", "create", {
          data: { id: `${id}-bad`, name: "Bad" },
          cache: { autoInvalidate: "yes" },
        })
      );
      expect(String(refused)).toContain("Invalid mutation cache options");
    }
    expect(forgedCalls).toEqual([]);
  });
});

describe("controls: the cache key", () => {
  async function cachedPair(order: "cache-first" | "rows-first") {
    const recorder = new KeyRecordingCache();
    const base = await seededBase();
    const official = cache({ driver: recorder, version: "v" });
    const db =
      order === "cache-first"
        ? base.$extends(official).$extends({ ...softRows })
        : base.$extends({ ...softRows }).$extends(official);
    return { recorder, db, base };
  }

  test("a read is keyed on its resolved mode: absent and explicit default share one key", async () => {
    const { recorder, db } = await cachedPair("cache-first");
    const reader = db.$withCache({ ttl: 60_000 });
    await reader.post.findMany();
    await reader.post.findMany({ deleted: "without" });
    await reader.post.findMany({ deleted: "with" });
    await reader.post.findMany({ deleted: "only" });
    expect(recorder.keys).toHaveLength(3);
    expect(new Set(recorder.keys).size).toBe(3);
  });

  test("equal declarations give equal keys, in either extension order and across two clients", async () => {
    const first = await cachedPair("cache-first");
    const second = await cachedPair("rows-first");
    for (const { db } of [first, second]) {
      await db.$withCache().post.findMany({ deleted: "only" });
      await db.$withCache().user.findMany();
    }
    expect(first.recorder.keys).toHaveLength(2);
    expect(second.recorder.keys).toEqual(first.recorder.keys);
  });

  test("a read that admits no control keeps today's key byte for byte", async () => {
    const plain = new KeyRecordingCache();
    const declared = new KeyRecordingCache();
    const base = await seededBase();
    await base
      .$extends(cache({ driver: plain, version: "v" }))
      .$withCache()
      .post.findMany({ where: { title: "live" } });
    const db = base
      .$extends(cache({ driver: declared, version: "v" }))
      .$extends({
        name: "writes-only",
        controls: { reason: { oneOf: ["a"], on: "writes" } },
      })
      .$extends({
        name: "absent",
        controls: { region: { oneOf: ["eu"], on: "reads" } },
      });
    await db.$withCache().post.findMany({ where: { title: "live" } });
    await db
      .$withCache()
      .post.findMany({ where: { title: "live" }, region: "eu" });
    expect(declared.keys[0]).toBe(plain.keys[0]);
    expect(declared.keys[1]).not.toBe(plain.keys[0]);
  });

  test("a control value that is not plain data bypasses the cache", async () => {
    const recorder = new KeyRecordingCache();
    const db = (await seededBase())
      .$extends(cache({ driver: recorder, version: "v" }))
      .$extends({
        name: "instance",
        controls: {
          scope: {
            schema: standard<string>((value) => ({
              value: new Map([[value, 1]]),
            })),
            on: "reads",
          },
        },
      });
    await expect(
      db.$withCache().post.findMany({ scope: "x", select: { id: true } })
    ).resolves.toEqual([{ id: "p1" }]);
    expect(recorder.keys).toEqual([]);
  });
});
