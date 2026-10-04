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
import { placeControls } from "@extensions/controls";
import { defineExtension } from "@extensions/definition";
import { bindRows, callRows } from "@extensions/rows";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { s } from "@schema";
import { Decimal } from "@src/index";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  audit,
  optimisticLock,
  tenancy as tenancyRecipe,
} from "@tests/fixtures/extension-recipes";
import { failure } from "@tests/fixtures/failure";
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

/** A schema no database backs: a refused chain order does no I/O. */
const audited = s.model({ id: s.string().id() });
const definitionSchema = { audited };

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

function refusal(action: () => unknown): ClientInitializationError {
  try {
    action();
  } catch (error) {
    if (error instanceof ClientInitializationError) return error;
    throw error;
  }
  throw new Error("expected the definition to be refused");
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

  test("an unplaced control and an undeclared key stay unknown keys; a value outside oneOf, compared by identity, is a ValidationError at the control's path", async () => {
    const base = await seededBase();
    const db = base.$extends({
      name: "tenant",
      controls: {
        region: { oneOf: ["eu", "us"], on: "reads" },
        level: { oneOf: [2, 3], on: "reads" },
      },
    });
    await expect(db.post.findMany({ level: 2 })).resolves.toHaveLength(1);
    expect(
      await failure(callUnchecked(db, "post", "findMany", { level: "2" }))
    ).toBeInstanceOf(ValidationError);
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

  test("a callable Standard Schema (ArkType's shape) is admitted, and validates the control", async () => {
    const base = await seededBase();
    const schema = Object.assign(
      (value: unknown) => value,
      standard<string>((value) =>
        value === "why" ? { value } : { issues: [{ message: "is not why" }] }
      )
    );
    const db = base.$extends(
      defineExtension({ name: "callable", controls: { reason: { schema } } })
    );
    await expect(db.post.findMany({ reason: "why" })).resolves.toHaveLength(1);
    const invalid = await failure(db.post.findMany({ reason: "because" }));
    expect(invalid).toBeInstanceOf(ValidationError);
    if (!(invalid instanceof ValidationError)) throw invalid;
    expect(invalid.issues).toEqual([
      { path: "reason", message: 'Control "reason" is not why' },
    ]);
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

  // Plan §2.3: each removeWhen control is placed only on its own managed
  // model's deletes, whichever extension declares it and in either order.
  const managing = {
    name: "managing",
    controls: { mode: { oneOf: ["soft", "hard"] } },
    deletion: {
      removeWhen: { mode: "hard" },
      models: { post: { at: "deletedAt" } },
    },
  } as const;
  const purging = {
    name: "purging",
    controls: { purge: { oneOf: ["no", "yes"] } },
    deletion: {
      removeWhen: { purge: "yes" },
      models: { user: { at: "removedAt" } },
    },
  } as const;
  for (const [first, second] of [
    [managing, purging],
    [purging, managing],
  ] as const) {
    test(`two extensions' removeWhen controls stay on their own model's deletes (${first.name} first)`, async () => {
      const removable = s.model({
        id: s.string().id(),
        removedAt: s.dateTime().nullable(),
        posts: s.toMany(() => removablePost),
      });
      const removablePost = s.model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .toOne(() => removable)
          .fields("authorId")
          .references("id"),
        deletedAt: s.dateTime().nullable(),
      });
      const base = createClient({
        schema: { user: removable, post: removablePost },
        driver: createInMemorySQLite3Driver(),
      });
      clients.push(base);
      await syncLiveSchema(base);
      const db = applyUnchecked(applyUnchecked(base, first), second);
      const none = { where: { id: "none" } };
      for (const [model, args] of [
        ["post", { ...none, purge: "yes" }],
        ["user", { ...none, mode: "hard" }],
      ] as const) {
        expect(
          await failure(callUnchecked(db, model, "deleteMany", args)),
          model
        ).toBeInstanceOf(ValidationError);
      }
      await expect(
        callUnchecked(db, "post", "deleteMany", { ...none, mode: "hard" })
      ).resolves.toEqual({ count: 0 });
      await expect(
        callUnchecked(db, "user", "deleteMany", { ...none, purge: "yes" })
      ).resolves.toEqual({ count: 0 });
    });
  }
});

describe("controls: required", () => {
  const REQUIRED = [
    { path: "tenant", message: 'Control "tenant" is required' },
  ];

  test("an extension that names no model asks for a required control on every model: a call that does not pass it is refused at its path on every operation it is placed on, before it writes; passed, it is admitted", async () => {
    const base = await seededBase();
    const db = base.$extends({
      name: "tenant",
      controls: { tenant: { oneOf: ["acme"], required: true } },
    });
    for (const model of ["user", "post"]) {
      for (const operation of ROUTED_OPERATIONS) {
        for (const args of [{}, { tenant: undefined }]) {
          const refused = await failure(
            callUnchecked(db, model, operation, args)
          );
          expect(refused, `${model}.${operation}`).toBeInstanceOf(
            ValidationError
          );
          expect((refused as ValidationError).issues).toEqual(REQUIRED);
        }
      }
    }
    expect(
      await failure(
        callUnchecked(db, "user", "create", {
          data: { id: "u2", name: "Grace" },
        })
      )
    ).toBeInstanceOf(ValidationError);
    expect(await base.user.count()).toBe(1);
    await expect(
      db.user.create({
        data: { id: "u2", name: "Grace" },
        tenant: "acme",
        select: { id: true },
      })
    ).resolves.toEqual({ id: "u2" });
  });

  test("where a required control is not placed nothing is asked: a writes control on a read, a removeWhen control off its managed deletes, the rows control", async () => {
    const db = (await seededBase())
      .$extends({
        name: "audit",
        controls: { actor: { oneOf: ["ann"], required: true, on: "writes" } },
      })
      .$extends({
        ...softRows,
        name: "managed",
        controls: { mode: { oneOf: ["soft", "hard"], required: true } },
        deletion: {
          removeWhen: { mode: "hard" },
          models: { post: { at: "deletedAt" } },
        },
      });
    await expect(db.post.findMany({ select: { id: true } })).resolves.toEqual([
      { id: "p1" },
    ]);
    expect(
      await failure(
        callUnchecked(db, "post", "update", {
          where: { id: "p1" },
          data: { title: "x" },
        })
      )
    ).toBeInstanceOf(ValidationError);
    await expect(
      db.user.deleteMany({ where: { id: "none" }, actor: "ann" })
    ).resolves.toEqual({ count: 0 });
    const unmoded = await failure(
      callUnchecked(db, "post", "deleteMany", {
        where: { id: "none" },
        actor: "ann",
      })
    );
    expect((unmoded as ValidationError).issues).toEqual([
      { path: "mode", message: 'Control "mode" is required' },
    ]);
  });

  test("a required control is asked for only on the models its extension names in rows, data or deletion, each alone enough; an extension that names none asks on every model (owner ruling, 2026-10-01)", () => {
    const required = (definition: Parameters<typeof placeControls>[0]) =>
      placeControls(definition).map(({ name, required: on }) => [
        name,
        on === true || on === undefined ? on : [...on].sort(),
      ]);
    expect(required(tenancyRecipe(["post", "user"]))).toEqual([
      ["tenant", ["post", "user"]],
      ["scope", undefined],
    ]);
    expect(required(audit(["post"]))).toEqual([["actor", ["post"]]]);
    expect(required(optimisticLock(["post"]))).toEqual([
      ["expectedVersion", undefined],
      ["versionCheck", undefined],
    ]);
    expect(
      required({
        name: "managed",
        controls: { mode: { oneOf: ["soft", "hard"], required: true } },
        deletion: {
          removeWhen: { mode: "hard" },
          models: { post: { at: "deletedAt" } },
        },
      })
    ).toEqual([["mode", ["post"]]]);
    // Rows alone name the model: the control is asked there only.
    expect(
      required({
        name: "scoped",
        controls: { tenant: { oneOf: ["acme"], required: true } },
        rows: {
          control: "scope",
          default: "tenant",
          models: {
            post: {
              tenant: { root: { tenantId: { control: "tenant" } } },
              all: {},
            },
          },
        },
      })
    ).toEqual([
      ["tenant", ["post"]],
      ["scope", undefined],
    ]);
    expect(
      required({
        name: "audit",
        controls: { actor: { oneOf: ["ann"], required: true, on: "writes" } },
      })
    ).toEqual([["actor", true]]);
  });

  test("tenancy asks for a tenant on the model it manages and audit for an actor on its writes; a model they do not name is not asked, still accepts both values and checks them", async () => {
    const note = s.model({
      id: s.string().id(),
      body: s.string(),
      tenantId: s.string().nullable(),
      createdBy: s.string().nullable(),
      updatedBy: s.string().nullable(),
    });
    const tag = s.model({ id: s.string().id(), label: s.string() });
    const base = createClient({
      schema: { note, tag },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    const db = base.$extends(tenancyRecipe(["note"])).$extends(audit(["note"]));
    const issues = async (pending: Promise<unknown>) => {
      const refused = await failure(pending);
      expect(refused).toBeInstanceOf(ValidationError);
      return (refused as ValidationError).issues;
    };
    // The managed model: every operation asks for the tenant, every write
    // for the actor too.
    for (const operation of ROUTED_OPERATIONS) {
      expect(
        await issues(callUnchecked(db, "note", operation, {})),
        operation
      ).toEqual([{ path: "tenant", message: 'Control "tenant" is required' }]);
    }
    expect(
      await issues(
        callUnchecked(db, "note", "create", {
          data: { id: "n1", body: "x" },
          tenant: "acme",
        })
      )
    ).toEqual([{ path: "actor", message: 'Control "actor" is required' }]);
    await expect(
      db.note.create({
        data: { id: "n1", body: "x" },
        tenant: "acme",
        actor: "ann",
      })
    ).resolves.toMatchObject({ tenantId: "acme", createdBy: "ann" });
    await expect(
      db.note.findMany({ tenant: "acme", select: { id: true } })
    ).resolves.toEqual([{ id: "n1" }]);
    // The other model: nothing is asked, on any operation.
    for (const operation of ROUTED_OPERATIONS) {
      const outcome = await callUnchecked(db, "tag", operation, {}).then(
        () => undefined,
        (error: unknown) => error
      );
      const paths =
        outcome instanceof ValidationError
          ? outcome.issues.map((issue) => issue.path)
          : [];
      expect(paths, operation).not.toContain("tenant");
      expect(paths, operation).not.toContain("actor");
    }
    await expect(
      db.tag.create({ data: { id: "t1", label: "a" }, select: { id: true } })
    ).resolves.toEqual({ id: "t1" });
    await expect(
      db.tag.update({
        where: { id: "t1" },
        data: { label: "b" },
        select: { label: true },
      })
    ).resolves.toEqual({ label: "b" });
    await expect(db.tag.findMany({ select: { id: true } })).resolves.toEqual([
      { id: "t1" },
    ]);
    // There both values are still accepted where `on` places them, checked,
    // and change nothing.
    await expect(
      db.tag.create({
        data: { id: "t2", label: "c" },
        tenant: "acme",
        actor: "ann",
        select: { id: true },
      })
    ).resolves.toEqual({ id: "t2" });
    await expect(
      db.tag.findMany({ tenant: "globex", select: { id: true } })
    ).resolves.toEqual([{ id: "t1" }, { id: "t2" }]);
    expect(
      await issues(callUnchecked(db, "tag", "findMany", { tenant: 1 }))
    ).toEqual([expect.objectContaining({ path: "tenant" })]);
    expect(
      await issues(callUnchecked(db, "tag", "findMany", { actor: "ann" }))
    ).toEqual([expect.objectContaining({ path: "actor" })]);
  });
  test("an extension that names a model in rows alone asks for its required control there, and nowhere else", async () => {
    const note = s.model({
      id: s.string().id(),
      tenantId: s.string().nullable(),
    });
    const tag = s.model({ id: s.string().id() });
    const base = createClient({
      schema: { note, tag },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    const db = base.$extends(
      defineExtension({
        name: "scoped",
        controls: { tenant: { oneOf: ["acme"], required: true } },
        rows: {
          control: "scope",
          default: "tenant",
          models: {
            note: {
              tenant: { root: { tenantId: { control: "tenant" } } },
              all: {},
            },
          },
        },
      })
    );
    const refused = await failure(callUnchecked(db, "note", "findMany", {}));
    expect((refused as ValidationError).issues).toEqual([
      { path: "tenant", message: 'Control "tenant" is required' },
    ]);
    await expect(
      db.note.findMany({ tenant: "acme", select: { id: true } })
    ).resolves.toEqual([]);
    await expect(db.tag.findMany({ select: { id: true } })).resolves.toEqual(
      []
    );
  });
});

describe("controls: rows bound to the call", () => {
  const WRITTEN = new Date("2026-01-01T00:00:00.000Z");
  const live = { deletedAt: null };
  const tenantRoot = {
    AND: [
      { tenantId: { control: "tenant" } },
      {
        OR: [
          { authorId: { in: [{ control: "author" }, "u0"] } },
          { NOT: { deletedById: { control: "by" } } },
        ],
      },
    ],
    title: { in: ["a", "b"] },
    deletedAt: { lt: WRITTEN },
  };
  const tenantRelated = { tenantId: { control: "tenant" } };
  const tenancy = {
    control: "scope",
    default: "tenant",
    models: {
      post: {
        tenant: { root: tenantRoot, related: tenantRelated },
        all: {},
      },
    },
  } as const;
  const soft = {
    control: "deleted",
    default: "without",
    models: { post: { without: { root: live }, with: {} } },
  } as const;
  const deletion = {
    post: { extension: "managed", at: "deletedAt", assign: {} },
  } as const;

  test("a reference at any depth takes the call's value, null included; everything else is kept as written", () => {
    const binding = bindRows([tenancy, soft], undefined);
    // Every combination takes the default domain, which names all three.
    expect(binding.references).toEqual(
      Array.from({ length: 4 }, () => ["tenant", "author", "by"])
    );
    const facts = callRows(binding, "post", {
      scope: "tenant",
      deleted: "without",
      tenant: "acme",
      author: "u1",
      by: null,
    });
    const [bound, kept] = facts.domain.root.get("post")!;
    expect(bound).toEqual({
      AND: [
        { tenantId: "acme" },
        {
          OR: [
            { authorId: { in: ["u1", "u0"] } },
            { NOT: { deletedById: null } },
          ],
        },
      ],
      title: { in: ["a", "b"] },
      deletedAt: { lt: WRITTEN },
    });
    expect(bound!.title).toBe(tenantRoot.title);
    expect(bound!.deletedAt).toBe(tenantRoot.deletedAt);
    expect(kept).toBe(live);
    expect(facts.domain.related.get("post")).toEqual([{ tenantId: "acme" }]);
    // A combination whose predicates name no control is v3.1's own domain.
    const all = callRows(binding, "post", { scope: "all", tenant: "acme" });
    expect(all.domain).toBe(binding.physical[1]!.domain);
  });

  test("a control the call did not pass drops each predicate that names it: that predicate filters nothing, the others stay", () => {
    const binding = bindRows([tenancy, soft], undefined);
    const absent = callRows(binding, "post", { tenant: "acme" });
    expect(absent.domain.root.get("post")).toEqual([live]);
    expect(absent.domain.related.get("post")).toEqual([{ tenantId: "acme" }]);
    const none = callRows(binding, "post", undefined);
    expect(none.domain.root.get("post")).toEqual([live]);
    expect(none.domain.related.has("post")).toBe(false);
  });

  test("a required control the call did not pass matches nothing on the model it is required on, at any depth", () => {
    // Required on `post`: a call that did not pass it reached `post` through a
    // model it is not required on, and must read none of its rows.
    const controls = {
      all: [{ name: "author", required: new Set(["post"]) }],
    } as unknown as Parameters<typeof bindRows>[3];
    const binding = bindRows([tenancy, soft], undefined, undefined, controls);
    const facts = callRows(binding, "post", { tenant: "acme", by: "u2" });
    const nothing = { OR: [] };
    // `author` sits in an `in` list inside the root predicate's `AND`.
    expect(facts.domain.root.get("post")).toEqual([nothing, live]);
    // The related predicate names only `tenant`, which the call passed.
    expect(facts.domain.related.get("post")).toEqual([{ tenantId: "acme" }]);
  });

  test("one object passed as two controls binds both, memoized like two equal objects", () => {
    const binding = bindRows([tenancy], undefined);
    const shared = { team: "red" };
    const facts = callRows(binding, "post", {
      tenant: "acme",
      author: shared,
      by: shared,
    });
    const [bound] = facts.domain.root.get("post")!;
    expect(JSON.stringify(bound)).toContain('"authorId":{"in":[{"team":"red"}');
    expect(
      callRows(binding, "post", {
        tenant: "acme",
        author: { team: "red" },
        by: { team: "red" },
      })
    ).toBe(facts);
  });

  test("a value that cannot be copied (a Proxy) is bound for its call alone", () => {
    const binding = bindRows([tenancy], undefined);
    const proxied = new Proxy({ tenant: "acme" }, {});
    const facts = callRows(binding, "post", {
      tenant: proxied,
      author: "u1",
      by: null,
    });
    expect(facts.domain.related.get("post")).toEqual([{ tenantId: proxied }]);
    expect(binding.bound.size).toBe(0);
  });

  test("a model's own AND, OR or NOT field is a field at its filter, a combinator elsewhere", () => {
    const logical = s.model({
      id: s.int().id(),
      AND: s.string(),
      OR: s.string(),
      NOT: s.string(),
    });
    const rows = {
      control: "scope",
      default: "picked",
      models: {
        logical: {
          picked: {
            root: {
              AND: { control: "a" },
              OR: { control: "o" },
              NOT: { control: "n" },
            },
          },
        },
        post: {
          picked: { root: { AND: [{ title: { control: "a" } }] } },
        },
      },
    } as const;
    const binding = bindRows([rows], undefined, undefined, undefined, {
      ...schema,
      logical,
    });
    expect(binding.references[0]).toEqual(["a", "o", "n"]);
    const values = { a: "x", o: "y", n: "z" };
    expect(
      callRows(binding, "logical", values).domain.root.get("logical")
    ).toEqual([{ AND: "x", OR: "y", NOT: "z" }]);
    // `post` declares no such field: there `AND` combines filters.
    expect(callRows(binding, "post", values).domain.root.get("post")).toEqual([
      { AND: [{ title: "x" }] },
    ]);
  });

  test("the same values give the same facts; the 257th distinct value evicts the oldest", () => {
    const binding = bindRows([tenancy], undefined);
    const call = (tenant: string, scope = "tenant") =>
      callRows(binding, "post", { tenant, scope });
    const first = call("t0");
    expect(call("t0")).toBe(first);
    expect(call("t0").domain).toBe(first.domain);
    expect(call("t1")).not.toBe(first);
    expect(call("t0", "all")).not.toBe(first);
    const kept = [first, binding.bound.get([...binding.bound.keys()][1]!)];
    for (let index = 2; index < 255; index++) call(`t${index}`);
    expect(binding.bound.size).toBe(256);
    expect(call("t0")).toBe(kept[0]);
    call("t255");
    expect(binding.bound.size).toBe(256);
    expect(call("t0")).not.toBe(first);
    expect(call("t1")).not.toBe(kept[1]);
  });

  test("the lock's version takes room beside the tenant: each new version on one client pushes tenants out; a client of its own leaves them", () => {
    const tenanted = appendResolvedExtension(
      undefined,
      tenancyRecipe(["post"]),
      schema
    );
    const locked = appendResolvedExtension(
      tenanted,
      optimisticLock(["post"]),
      schema
    );
    const binding = locked.callRows!;
    // Every combination takes both default domains, which name both values.
    expect(binding.references.map((names) => [...names].sort())).toEqual(
      Array.from({ length: 4 }, () => ["expectedVersion", "tenant"])
    );
    const read = callRows(binding, "post", { tenant: "acme" }).domain;
    expect(callRows(binding, "post", { tenant: "acme" }).domain).toBe(read);
    for (let version = 0; version < 256; version++) {
      callRows(binding, "post", { tenant: "acme", expectedVersion: version });
    }
    expect(binding.bound.size).toBe(256);
    const again = callRows(binding, "post", { tenant: "acme" }).domain;
    expect(again).not.toBe(read);
    expect(again).toEqual(read);
    // The client the lock was applied to keeps its own memo: its tenant stays.
    const tenantOnly = tenanted.callRows!;
    expect(tenantOnly).not.toBe(binding);
    const kept = callRows(tenantOnly, "post", { tenant: "acme" }).domain;
    expect(binding.bound.size).toBe(256);
    expect(tenantOnly.bound.size).toBe(1);
    expect(callRows(tenantOnly, "post", { tenant: "acme" }).domain).toBe(kept);
  });

  test("a chain whose predicates name no control keeps its precomputed facts: nothing is bound or kept", () => {
    const binding = bindRows([soft], undefined);
    expect(binding.references).toEqual([[], []]);
    expect(callRows(binding, "post", { deleted: "with" })).toBe(
      binding.physical[1]
    );
    expect(binding.bound.size).toBe(0);
  });

  test("a filter is never a reference, at the top or as an item of AND, OR and NOT: `control` there is a field", () => {
    const named = { control: "x" };
    const field = {
      control: "kind",
      default: "a",
      models: {
        post: {
          a: {
            root: named,
            related: { AND: [named], OR: [named], NOT: named },
          },
        },
      },
    } as const;
    const binding = bindRows([field], undefined);
    expect(binding.references).toEqual([[]]);
    const facts = callRows(binding, "post", { x: "value" });
    expect(facts).toBe(binding.physical[0]);
    expect(facts.domain.root.get("post")).toEqual([named]);
    expect(facts.domain.related.get("post")).toEqual([
      { AND: [named], OR: [named], NOT: named },
    ]);
    // Under such a filter, a field's value is still one.
    const nested = bindRows(
      [
        {
          ...field,
          models: {
            post: { a: { root: { NOT: { control: { control: "x" } } } } },
          },
        },
      ],
      undefined
    );
    expect(nested.references).toEqual([["x"]]);
    expect(
      callRows(nested, "post", { x: "value" }).domain.root.get("post")
    ).toEqual([{ NOT: { control: "value" } }]);
  });

  test("a combination binds only when its predicates or the default ones name a control", () => {
    // The default mode names nothing: its calls keep the precomputed facts.
    const optIn = {
      control: "scope",
      default: "all",
      models: { post: { all: {}, tenant: { related: tenantRelated } } },
    } as const;
    const binding = bindRows([optIn], undefined);
    expect(binding.references).toEqual([[], ["tenant"]]);
    expect(callRows(binding, "post", { tenant: "acme" })).toBe(
      binding.physical[0]
    );
    expect(binding.bound.size).toBe(0);
    // Tenancy's `all` names nothing, but its default domain does: two
    // tenants keep two entries, one domain, each its own default domain.
    const tenancyBinding = bindRows([tenancy], undefined);
    const acme = callRows(tenancyBinding, "post", {
      scope: "all",
      tenant: "acme",
    });
    const globex = callRows(tenancyBinding, "post", {
      scope: "all",
      tenant: "globex",
    });
    expect(tenancyBinding.bound.size).toBe(2);
    expect(acme.domain).toBe(globex.domain);
    expect(acme.domain).toBe(tenancyBinding.physical[1]!.domain);
    expect(globex.defaults.related.get("post")).toEqual([
      { tenantId: "globex" },
    ]);
  });

  test("a value no key spells by its content is bound for its call alone", () => {
    const binding = bindRows([tenancy], undefined);
    const tenant = new Map([["id", "acme"]]);
    const first = callRows(binding, "post", { tenant });
    expect(first.domain.related.get("post")).toEqual([{ tenantId: tenant }]);
    expect(first.domain.related.get("post")![0]!.tenantId).toBe(tenant);
    expect(callRows(binding, "post", { tenant })).not.toBe(first);
    expect(binding.bound.size).toBe(0);
  });

  test("a remembered domain holds its own copy of the values it was bound from: a Date or an array the caller mutates after its call never reaches a later call with equal values (F1)", async () => {
    const owner = s.model({
      id: s.string().id(),
      entries: s.toMany(() => entry),
    });
    const entry = s.model({
      id: s.string().id(),
      day: s.dateTime(),
      tenantId: s.string(),
      ownerId: s.string(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    });
    const base = createClient({
      schema: { owner, entry },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    const JANUARY_1 = "2026-01-01T00:00:00.000Z";
    const JANUARY_2 = "2026-01-02T00:00:00.000Z";
    await base.owner.create({ data: { id: "o1" } });
    await base.entry.createMany({
      data: [
        { id: "d1", day: new Date(JANUARY_1), tenantId: "acme" },
        { id: "d2", day: new Date(JANUARY_2), tenantId: "acme" },
        { id: "t1", day: new Date(JANUARY_1), tenantId: "globex" },
        { id: "t2", day: new Date(JANUARY_1), tenantId: "initech" },
      ].map((row) => ({ ...row, ownerId: "o1" })),
    });
    // Valid Standard Schemas that return the caller's value unchanged.
    const given = standard((value) => ({ value }));
    const db = base.$extends(
      defineExtension({
        name: "dated",
        controls: { day: { schema: given }, tenants: { schema: given } },
        rows: {
          control: "view",
          default: "scoped",
          models: {
            entry: {
              scoped: {
                root: { day: { control: "day" } },
                related: { tenantId: { in: { control: "tenants" } } },
              },
              all: {},
            },
          },
        },
      })
    );
    const ids = async (args: Record<string, unknown>) =>
      (
        (await callUnchecked(db, "entry", "findMany", {
          ...args,
          select: { id: true },
          orderBy: { id: "asc" },
        })) as { id: string }[]
      ).map(({ id }) => id);
    const relatedIds = async (args: Record<string, unknown>) =>
      (
        (await callUnchecked(db, "owner", "findUnique", {
          ...args,
          where: { id: "o1" },
          select: { entries: { select: { id: true }, orderBy: { id: "asc" } } },
        })) as { entries: { id: string }[] }
      ).entries.map(({ id }) => id);

    // A Date mutated after its call.
    const day = new Date(JANUARY_1);
    expect(await ids({ day, tenants: ["acme"] })).toEqual(["d1", "t1", "t2"]);
    day.setTime(Date.parse(JANUARY_2));
    expect(await ids({ day: new Date(JANUARY_1), tenants: ["acme"] })).toEqual([
      "d1",
      "t1",
      "t2",
    ]);
    expect(await ids({ day, tenants: ["acme"] })).toEqual(["d2"]);
    // An array mutated after its call, before a later call first reads the
    // related predicate it was bound into.
    const tenants = ["globex"];
    expect(await ids({ day: new Date(JANUARY_1), tenants })).toEqual([
      "d1",
      "t1",
      "t2",
    ]);
    tenants.splice(0, 1, "initech");
    expect(
      await relatedIds({ day: new Date(JANUARY_1), tenants: ["globex"] })
    ).toEqual(["t1"]);
    expect(await relatedIds({ day: new Date(JANUARY_1), tenants })).toEqual([
      "t2",
    ]);
    // The reference-free mode is untouched.
    expect(await ids({ view: "all" })).toEqual(["d1", "d2", "t1", "t2"]);
    expect(await relatedIds({ view: "all" })).toEqual(["d1", "d2", "t1", "t2"]);
  });

  test("a memo hit still returns the one domain for equal values, bound from its own copy of them", () => {
    const dated = {
      control: "scope",
      default: "tenant",
      models: {
        post: {
          tenant: {
            root: {
              deletedAt: { control: "day" },
              authorId: { in: { control: "authors" } },
            },
          },
          all: {},
        },
      },
    } as const;
    const binding = bindRows([dated], undefined);
    const day = new Date("2026-01-01T00:00:00.000Z");
    const authors = ["u1"];
    const first = callRows(binding, "post", { day, authors });
    const [where] = first.domain.root.get("post")!;
    expect(where).toEqual({ deletedAt: day, authorId: { in: authors } });
    expect(where!.deletedAt).not.toBe(day);
    expect((where!.authorId as { in: unknown }).in).not.toBe(authors);
    const again = callRows(binding, "post", {
      day: new Date("2026-01-01T00:00:00.000Z"),
      authors: ["u1"],
    });
    expect(again).toBe(first);
    expect(again.domain).toBe(first.domain);
    expect(binding.bound.size).toBe(1);
    // The combination whose own predicates name nothing keeps its domain.
    expect(callRows(binding, "post", { scope: "all", day }).domain).toBe(
      binding.physical[1]!.domain
    );
  });

  test("a tombstoning call's default domain takes the same values; a physical one is kept apart", () => {
    const binding = bindRows([tenancy], deletion);
    const operator = callRows(binding, "post", {
      tenant: "acme",
      scope: "all",
    });
    expect(operator.domain.related.has("post")).toBe(false);
    expect(operator.defaults.related.get("post")).toEqual([
      { tenantId: "acme" },
    ]);
    expect(operator.tombstones).toBe(binding.tombstoning[1]!.tombstones);
    const own = callRows(binding, "post", { tenant: "acme" });
    expect(own.defaults).toBe(own.domain);
    const physical = bindRows([tenancy], {
      post: { ...deletion.post, removeWhen: { mode: "hard" } },
    });
    const removing = callRows(physical, "post", {
      tenant: "acme",
      mode: "hard",
    });
    expect(removing.tombstones).toBeUndefined();
    expect(callRows(physical, "post", { tenant: "acme" }).tombstones).toBe(
      physical.tombstoning[0]!.tombstones
    );
  });
});

describe("data: fields an extension writes", () => {
  // Plan v4 §2.2. The engine's sites are witnessed on real databases
  // (tests/contracts/engine/write/extension-data-behavior.ts); here, how a
  // chain holds the declarations and how a call's values are put in.
  const audit = {
    post: {
      create: { createdBy: { control: "actor" }, source: "api" },
      update: { version: { increment: 1 } },
    },
    user: { update: { name: "touched" } },
  };

  test("a stamp's control takes the call's value, put in per call; a field whose control the call did not pass is not written", () => {
    const binding = bindRows(undefined, undefined, audit);
    expect(binding.references).toEqual([[]]);
    expect(binding.bindsStamps).toBe(true);
    const facts = callRows(binding, "post", { actor: "ann" });
    const post = facts.stamps!.get("post")!;
    expect(post.create).toEqual({ createdBy: "ann", source: "api" });
    expect(post.update).toBe(audit.post.update);
    expect(facts.stamps!.get("user")).toBe(audit.user);
    expect(facts.domain).toBe(binding.physical[0]!.domain);
    expect(binding.bound.size).toBe(0);
    const absent = callRows(binding, "post", undefined);
    expect(absent.stamps!.get("post")!.create).toEqual({ source: "api" });
  });

  test("stamps take no room in the domain memo: one tenant keeps one domain whoever writes, past 256 writers", () => {
    const scoped = {
      control: "scope",
      default: "tenant",
      models: {
        post: {
          tenant: { root: { tenantId: { control: "tenant" } } },
          all: {},
        },
      },
    } as const;
    const binding = bindRows([scoped], undefined, audit);
    expect(binding.references).toEqual([["tenant"], ["tenant"]]);
    const read = callRows(binding, "post", { tenant: "acme" });
    const ann = callRows(binding, "post", { tenant: "acme", actor: "ann" });
    const bob = callRows(binding, "post", { tenant: "acme", actor: "bob" });
    expect(ann.domain).toBe(read.domain);
    expect(bob.domain).toBe(read.domain);
    expect(bob.defaults).toBe(read.defaults);
    expect(bob.stamps!.get("post")!.create).toEqual({
      createdBy: "bob",
      source: "api",
    });
    for (let index = 0; index < 300; index++) {
      callRows(binding, "post", { tenant: "acme", actor: `a${index}` });
    }
    expect(binding.bound.size).toBe(1);
    expect(callRows(binding, "post", { tenant: "acme" }).domain).toBe(
      read.domain
    );
  });

  test("constant stamps keep the precomputed facts; bound rows leave them as declared", () => {
    const constant = { user: audit.user };
    const binding = bindRows(undefined, undefined, constant);
    expect(binding.references).toEqual([[]]);
    expect(binding.bindsStamps).toBe(false);
    const facts = callRows(binding, "user", undefined);
    expect(facts).toBe(binding.physical[0]);
    expect(facts.stamps!.get("user")).toBe(audit.user);
    const scoped = {
      control: "scope",
      default: "tenant",
      models: { post: { tenant: { root: { tenantId: { control: "t" } } } } },
    } as const;
    const bound = bindRows([scoped], undefined, constant);
    const tenant = callRows(bound, "post", { t: "acme" });
    expect(tenant.domain.root.get("post")).toEqual([{ tenantId: "acme" }]);
    expect(tenant.stamps).toBe(bound.physical[0]!.stamps);
    // A tombstoning call writes them too: a tombstone is an update.
    const managed = bindRows(
      undefined,
      { post: { extension: "managed", assign: {} } },
      constant
    );
    expect(callRows(managed, "post", undefined).stamps!.get("user")).toBe(
      audit.user
    );
  });

  test("a chain merges every extension's fields per model and kind: a later extension wins a field", () => {
    const first = appendResolvedExtension(
      undefined,
      {
        name: "first",
        data: { models: { post: { create: { title: "a", authorId: "u" } } } },
      },
      schema
    );
    const second = appendResolvedExtension(
      first,
      {
        name: "second",
        data: {
          models: {
            post: { create: { title: "b" }, update: { title: "c" } },
            user: { update: { name: "d" } },
          },
        },
      },
      schema
    );
    expect(second.data!.post).toEqual({
      create: { title: "b", authorId: "u" },
      update: { title: "c" },
    });
    expect(second.data!.user).toEqual({ update: { name: "d" } });
    expect(second.callRows!.physical[0]!.stamps!.get("post")).toBe(
      second.data!.post
    );
    const third = appendResolvedExtension(second, { name: "third" }, schema);
    expect(third.callRows).toBe(second.callRows);
  });
});

describe("controls: the order a chain takes", () => {
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
});

describe("controls: the official cache", () => {
  test("its control comes from the cache, whatever controls a definition carrying its query spells", async () => {
    const official = cache({ driver: new MemoryCache() });
    const placedOn = (definition: Readonly<Record<string, unknown>>) =>
      appendResolvedExtension(undefined, definition, schema).controls?.placed(
        "post",
        "create"
      );
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

  test("the key carries the rows declarations: one control value under two declarations never shares an entry", async () => {
    const shared = new KeyRecordingCache();
    const base = await seededBase();
    await base.post.create({
      data: { id: "p2", title: "gone", authorId: "u1", deletedAt: new Date() },
    });
    const byMarker = base
      .$extends(cache({ driver: shared, version: "v" }))
      .$extends({ ...softRows });
    const byTitle = base
      .$extends(cache({ driver: shared, version: "v" }))
      .$extends({
        ...softRows,
        rows: {
          ...softRows.rows,
          models: {
            post: {
              ...softRows.rows.models.post,
              without: { root: { title: "gone" }, related: { title: "gone" } },
            },
          },
        },
      });
    const ids = (rows: readonly { readonly id: string }[]) =>
      rows.map((row) => row.id);
    expect(
      ids(await byMarker.$withCache().post.findMany({ select: { id: true } }))
    ).toEqual(["p1"]);
    expect(
      ids(await byTitle.$withCache().post.findMany({ select: { id: true } }))
    ).toEqual(["p2"]);
    expect(new Set(shared.keys).size).toBe(2);
  });

  test("a rows client never reads a base entry, at its root or through a relation, in either extension order", async () => {
    for (const order of ["cache-first", "rows-first"] as const) {
      const { recorder, db, base } = await cachedPair(order);
      await base.post.create({
        data: {
          id: "p2",
          title: "gone",
          authorId: "u1",
          deletedAt: new Date(),
        },
      });
      const warm = base.$extends(cache({ driver: recorder, version: "v" }));
      const byId = { select: { id: true }, orderBy: { id: "asc" } } as const;
      const related = {
        select: { id: true, posts: { select: { id: true } } },
      } as const;
      expect(await warm.$withCache().post.findMany(byId)).toEqual([
        { id: "p1" },
        { id: "p2" },
      ]);
      expect(await warm.$withCache().user.findMany(related)).toEqual([
        { id: "u1", posts: [{ id: "p1" }, { id: "p2" }] },
      ]);
      expect(await db.$withCache().post.findMany(byId)).toEqual([{ id: "p1" }]);
      expect(await db.$withCache().user.findMany(related)).toEqual([
        { id: "u1", posts: [{ id: "p1" }] },
      ]);
      expect(recorder.keys).toHaveLength(4);
    }
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

  test("a rows value that is not plain data bypasses the cache, and each call reads its own value", async () => {
    const price = s.model({
      id: s.int().id(),
      amount: s.decimal({ precision: 10, scale: 2 }),
    });
    const base = createClient({
      schema: { price },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    for (const [id, amount] of [
      [1, "1.5"],
      [2, "3"],
    ] as const)
      await base.price.create({ data: { id, amount: new Decimal(amount) } });
    const recorder = new KeyRecordingCache();
    const db = base
      .$extends(cache({ driver: recorder, version: "v" }))
      .$extends({
        name: "floor",
        // A Decimal is a class instance: no key spells it by its content.
        controls: {
          floor: { schema: standard<Decimal>((value) => ({ value })) },
        },
        rows: {
          control: "scope",
          default: "above",
          models: {
            price: {
              above: { root: { amount: { gte: { control: "floor" } } } },
            },
          },
        },
      });
    const above = async (floor: string) =>
      (
        await db.$withCache().price.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
          floor: new Decimal(floor),
        })
      ).map((row) => row.id);
    expect(await above("2")).toEqual([2]);
    expect(await above("1")).toEqual([1, 2]);
    expect(await above("2")).toEqual([2]);
    expect(recorder.keys).toEqual([]);
  });
});
