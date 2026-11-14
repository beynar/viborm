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
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { CacheEntry } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import {
  ClientInitializationError,
  NestedWriteError,
  NotFoundError,
  QueryError,
  ValidationError,
} from "@errors";
import type {
  ResolvedDeletion,
  ResolvedExtensionChain,
} from "@extensions/chain";
import { placeControls } from "@extensions/controls";
import { isAppliedExtension } from "@extensions/extension";
import { Kept } from "@extensions/kept";
import { bindPlain } from "@extensions/plain-domain";
import { bindRows } from "@extensions/rows";
import { Stamps } from "@extensions/stamps";
import {
  Condition,
  type ModelStamps,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import { s } from "@schema";
import {
  accepts,
  arg,
  around,
  call,
  Decimal,
  deletes,
  args as extArgs,
  extension,
  now as extNow,
  target as extTarget,
  keep,
  methods,
  oneOf,
  reads,
  rule,
  settled,
  statement,
  unit,
  unless,
  when,
  writes,
} from "@src/index";
import { v } from "@src/validation";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  audit,
  optimisticLock,
  tenancy as tenancyRecipe,
} from "@tests/fixtures/extension-recipes";
import { failure } from "@tests/fixtures/failure";
import {
  appendResolvedExtension,
  type HostDefinition as ExtensionDefinitionInput,
  hostExtension,
} from "@tests/fixtures/host-definition";
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
function applyUnchecked(
  client: object,
  definition: ExtensionDefinitionInput
): object {
  return Reflect.apply(Reflect.get(client, "$extends"), client, [
    hostExtension(definition),
  ]);
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

const NAMED_CONTROL = /named control "(reason|deleted)"/;

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
      .$extends(
        extension(
          "rows",
          extArgs({
            deleted: oneOf("without", "with", "only").default("without"),
          }),
          rule({
            post: {
              root: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: { not: null } }),
              ],
              related: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: null }),
              ],
            },
          })
        )
      )
      .$extends(
        extension(
          "audit",
          extArgs({ reason: standard((value) => ({ value })) }),
          call(
            (c) => {
              const context = {
                input: c.args,
                controls: c.values,
                model: c.model,
                operation: c.operation,
              };
              record("audit-request", context);
              c.set({});
            },
            extTarget("post", "findMany")
          ),
          around(
            (c) => (run) => {
              const context = {
                proceed: run,
                input: run.input,
                mode: run.mode,
                kind: c.kind,
                model: c.model,
                operation: c.operation,
                controls: c.values,
                onWriteOutcome: (listener) => settled(c, listener),
              };
              record("audit-query", context);
              return context.proceed();
            },
            extTarget("post", "findMany")
          )
        )
      )
      .$extends(
        extension(
          "tenant",
          extArgs({ region: oneOf("eu", "us").on(reads) }),
          call((c) => {
            const context = {
              input: c.args,
              controls: c.values,
              model: c.model,
              operation: c.operation,
            };
            record("tenant-request", context);
            c.set({});
          })
        )
      )
      .$extends(
        extension(
          "bystander",
          call((c) => {
            const context = {
              input: c.args,
              controls: c.values,
              model: c.model,
              operation: c.operation,
            };
            record("bystander-request", context);
            c.set({});
          }),
          around((c) => (run) => {
            const context = {
              proceed: run,
              input: run.input,
              mode: run.mode,
              kind: c.kind,
              model: c.model,
              operation: c.operation,
              controls: c.values,
              onWriteOutcome: (listener) => settled(c, listener),
            };
            record("bystander-query", context);
            return context.proceed();
          })
        )
      );

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
      "bystander-request:{}:",
      'audit-query:{"reason":"audit"}:',
      "bystander-query:{}:",
    ]);

    seen.length = 0;
    await db.post.findMany({ select: { id: true } });
    // An absent plain control is not admitted; the rows control is admitted as
    // its default mode.
    expect(seen).toEqual([
      "audit-request:{}:",
      "tenant-request:{}:",
      "bystander-request:{}:",
      "audit-query:{}:",
      "bystander-query:{}:",
    ]);
  });

  test("the rows extension's own handlers read the admitted mode, default included", async () => {
    const modes: unknown[] = [];
    const db = (await seededBase()).$extends(
      extension(
        "rows",
        extArgs({
          deleted: oneOf("without", "with", "only").default("without"),
        }),
        around((c) => (run) => {
          // A raw statement has no controls; a model operation's are typed here.
          if (c.kind === "model") modes.push(c.values);
          return run();
        }),
        rule({
          post: {
            root: [
              when(arg("deleted"), "without", { deletedAt: null }),
              when(arg("deleted"), "only", { deletedAt: { not: null } }),
            ],
            related: [
              when(arg("deleted"), "without", { deletedAt: null }),
              when(arg("deleted"), "only", { deletedAt: null }),
            ],
          },
        })
      )
    );
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
      base.$extends(
        extension(
          "own",
          extArgs({ reason: oneOf("a", "b") }),
          call((c) => {
            patches.push("own");
            c.set({ reason: "b" });
          })
        )
      ),
      // An extension applied before the declaring one patches its control.
      base
        .$extends(
          extension(
            "earlier",
            call((c) => {
              patches.push("earlier");
              c.set(
                Object.defineProperty({}, "reason", {
                  enumerable: true,
                  get() {
                    patches.push("earlier-value-read");
                    return "b";
                  },
                })
              );
            })
          )
        )
        .$extends(extension("declaring", extArgs({ reason: oneOf("a", "b") }))),
      // A later extension patches the rows control.
      base
        .$extends(
          extension(
            "rows",
            extArgs({
              deleted: oneOf("without", "with", "only").default("without"),
            }),
            rule({
              post: {
                root: [
                  when(arg("deleted"), "without", { deletedAt: null }),
                  when(arg("deleted"), "only", { deletedAt: { not: null } }),
                ],
                related: [
                  when(arg("deleted"), "without", { deletedAt: null }),
                  when(arg("deleted"), "only", { deletedAt: null }),
                ],
              },
            })
          )
        )
        .$extends(
          extension(
            "later",
            call((c) => {
              patches.push("later");
              c.set({ deleted: "with" });
            })
          )
        ),
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
    expect(patches).toEqual(["own", "earlier", "later"]);
    await expect(
      base.post.findUnique({ where: { id: "p-refused" } })
    ).resolves.toBeNull();
  });

  test("an unplaced control and an undeclared key stay unknown keys; a value outside oneOf, compared by identity, is a ValidationError at the control's path", async () => {
    const base = await seededBase();
    const db = base.$extends(
      extension(
        "tenant",
        extArgs({
          region: oneOf("eu", "us").on(reads),
          level: oneOf(2, 3).on(reads),
        })
      )
    );
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
      hostExtension({ name: "callable", controls: { reason: { schema } } })
    );
    await expect(db.post.findMany({ reason: "why" })).resolves.toHaveLength(1);
    const invalid = await failure(db.post.findMany({ reason: "because" }));
    expect(invalid).toBeInstanceOf(ValidationError);
    if (!(invalid instanceof ValidationError)) throw invalid;
    expect(invalid.issues).toEqual([
      { path: "reason", message: 'Control "reason" is not why' },
    ]);
  });

  test("issues that cannot be read still fail with their class", async () => {
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
    const db = (await seededBase()).$extends(
      extension(
        "counted",
        extArgs({
          reason: standard((value) => {
            timeline.push(`validate:${String(value)}`);
            return { value };
          }),
        }),
        call((c) => {
          timeline.push("request");
          c.set({});
        })
      )
    );
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
      .$extends(
        extension(
          "guarded",
          extArgs({
            reason: accepts(
              standard((value) => {
                timeline.push(`validate:${String(value)}`);
                return value === "ok"
                  ? { value }
                  : { issues: [{ message: "is not ok" }] };
              })
            ).on(writes),
          })
        )
      )
      .$extends(
        extension(
          "statements",
          unit(
            (u, next) => {
              timeline.push(`statement:${String(u.operation)}`);
              return next(statement(u));
            },
            ["statement"],
            { rewrites: true }
          )
        )
      );
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
    const defined = extension(
      "defined",
      extArgs({
        mode: oneOf("soft", "hard").on(deletes).models(["post"]),
        reason: accepts(standard((value) => ({ value }))).on(["findMany"]),
        deleted: oneOf("without", "with", "only").default("without"),
      }),
      around((c) => (run) => {
        if (c.kind === "model") seen.push(c.values);
        return run();
      }),
      rule({
        post: {
          root: [
            when(arg("deleted"), "without", { deletedAt: null }),
            when(arg("deleted"), "only", { deletedAt: { not: null } }),
          ],
          related: [
            when(arg("deleted"), "without", { deletedAt: null }),
            when(arg("deleted"), "only", { deletedAt: null }),
          ],
          delete: {
            instead: keep(unless(arg("mode"), "hard", { deletedAt: extNow })),
          },
        },
      })
    );
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
      .$extends(
        extension(
          "managed",
          extArgs({
            mode: oneOf("soft", "hard").on(deletes).models(["post"]),
            deleted: oneOf("without", "with", "only").default("without"),
          }),
          rule({
            post: {
              root: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: { not: null } }),
              ],
              related: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: null }),
              ],
              delete: {
                instead: keep(
                  unless(arg("mode"), "hard", { deletedAt: extNow })
                ),
              },
            },
          })
        )
      )
      .$extends(
        extension("later", extArgs({ reason: oneOf("why").on(writes) }))
      );
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
    const db = base.$extends(
      extension("tenant", extArgs({ tenant: oneOf("acme").required() }))
    );
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
      .$extends(
        extension(
          "audit",
          extArgs({ actor: oneOf("ann").on(writes).required() })
        )
      )
      .$extends(
        extension(
          "managed",
          extArgs({
            mode: oneOf("soft", "hard")
              .on(deletes)
              .models(["post"])
              .required(["post"]),
            deleted: oneOf("without", "with", "only").default("without"),
          }),
          rule({
            post: {
              root: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: { not: null } }),
              ],
              related: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: null }),
              ],
              delete: {
                instead: keep(
                  unless(arg("mode"), "hard", { deletedAt: extNow })
                ),
              },
            },
          })
        )
      );
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
    // A recipe is an extension: its arguments as the chain placed them, on
    // models that hold every field the recipes write.
    const recipeModel = () =>
      s.model({
        id: s.string().id(),
        tenantId: s.string(),
        createdBy: s.string(),
        updatedBy: s.string(),
        version: s.int(),
      });
    const recipeSchema = { post: recipeModel(), user: recipeModel() };
    const placed = (value: unknown) => {
      if (!isAppliedExtension(value)) throw new TypeError("not an extension");
      return value
        .append(undefined, recipeSchema)
        .controls!.all.map(({ name, required: on }) => [
          name,
          on === true || on === undefined ? on : [...on].sort(),
        ]);
    };
    expect(placed(tenancyRecipe(["post", "user"]))).toEqual([
      ["tenant", ["post", "user"]],
      ["scope", undefined],
    ]);
    expect(placed(audit(["post"]))).toEqual([["actor", ["post"]]]);
    expect(placed(optimisticLock(["post"]))).toEqual([
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
      extension(
        "scoped",
        extArgs({
          tenant: oneOf("acme").required(["note"]),
          scope: oneOf("tenant", "all").default("tenant"),
        }),
        rule({
          note: {
            root: when(arg("scope"), "tenant", { tenantId: arg("tenant") }),
          },
        })
      )
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
  // A predicate's values are parameters (plan K2): the domains are built once
  // per chain, as admission left them, and a call carries its controls
  // beside them. What each call then reads is witnessed on real databases
  // (tests/contracts/engine/query/domain-predicate-behavior.ts).
  const scopedPost = s.model({
    id: s.string().id(),
    tenantId: s.string(),
    title: s.string(),
    deletedAt: s.dateTime().nullable(),
    version: s.int(),
  });
  const scopedSchema = { post: scopedPost };
  const deletion = {
    post: { extension: "managed", at: "deletedAt", assign: {} },
  } as const;
  const bound = (...definitions: ExtensionDefinitionInput[]) => {
    let chain: ReturnType<typeof appendResolvedExtension> | undefined;
    for (const definition of definitions)
      chain = appendResolvedExtension(chain, definition, scopedSchema);
    return chain!.callRows!;
  };

  test("every call shares its combination's domains; a call whose predicates read a value carries its controls, others the shared facts", () => {
    const binding = bound(tenancyRecipe(["post"]), softRows);
    const acme = binding.call("post", { tenant: "acme" });
    const globex = binding.call("post", { tenant: "globex" });
    expect(acme.domain).toBe(globex.domain);
    expect(acme.domain).toBe(binding.call("post", undefined).domain);
    expect(acme.values?.controls).toEqual({ tenant: "acme" });
    expect(globex.values?.controls).toEqual({ tenant: "globex" });
    expect(acme.values?.required("tenant", "post")).toBe(true);
    // Every combination's default domain reads the tenant.
    for (const deleted of ["without", "with", "only"])
      expect(
        binding.call("post", { tenant: "acme", deleted }).values
      ).toBeDefined();
    const soft = bound(softRows);
    const withDeleted = soft.call("post", { deleted: "with" });
    expect(withDeleted.values).toBeUndefined();
    expect(soft.call("post", { deleted: "with" })).toBe(withDeleted);
    expect(withDeleted.domain).not.toBe(soft.call("post", undefined).domain);
  });

  test("a predicate's value is a parameter; an absent optional value travels as absent", () => {
    const binding = bound(optimisticLock(["post"]));
    const [checked] = binding.call("post", undefined).domain.root.get("post")!;
    const operand = (checked as { version: { equals: unknown } }).version
      .equals;
    expect(operand).toBeInstanceOf(Parameter);
    expect(operand).toMatchObject({ control: "expectedVersion" });
    // Absent, the lock's value still travels as absent: the engine drops it,
    // as no control of the chain is required.
    const absent = binding.call("post", undefined).values!;
    expect(absent.controls).toEqual({});
    expect(absent.required("expectedVersion", "post")).toBe(false);
    // `unchecked` names nothing, but its default domain does.
    const unchecked = binding.call("post", { versionCheck: "unchecked" });
    expect(unchecked.values).toBeDefined();
    expect(unchecked.domain).toBe(
      binding.call("post", { versionCheck: "unchecked", expectedVersion: 2 })
        .domain
    );
  });

  test("a model's own AND, OR or NOT field is a field at its filter, a combinator elsewhere", () => {
    const logical = s.model({
      id: s.int().id(),
      AND: s.string(),
      OR: s.string(),
      NOT: s.string(),
    });
    const chain = appendResolvedExtension(
      undefined,
      {
        name: "picked",
        controls: {
          a: { schema: v.string() },
          o: { schema: v.string() },
          n: { schema: v.string() },
        },
        rows: {
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
        },
      },
      { ...schema, logical }
    );
    const [fields] = chain
      .callRows!.call("logical", undefined)
      .domain.root.get("logical")!;
    for (const field of ["AND", "OR", "NOT"])
      expect(
        (fields as Record<string, { equals: unknown }>)[field]!.equals
      ).toBeInstanceOf(Parameter);
    // `post` declares no such field: there `AND` combines filters.
    const [combined] = chain
      .callRows!.call("post", undefined)
      .domain.root.get("post")!;
    expect(
      (combined as { AND: { title: { equals: unknown } }[] }).AND[0]!.title
        .equals
    ).toBeInstanceOf(Parameter);
  });

  test("a filter is never a reference, at the top or as an item of AND, OR and NOT: `control` there is a field", async () => {
    const switched = s.model({ id: s.string().id(), control: s.string() });
    const base = createClient({
      schema: { switched },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    await base.switched.createMany({
      data: [
        { id: "a", control: "x" },
        { id: "b", control: "y" },
      ],
    });
    const named = { control: "x" };
    const db = base.$extends(
      extension(
        "field",
        extArgs({ kind: oneOf("a").default("a") }),
        rule({
          switched: {
            root: when(arg("kind"), "a", { control: "x" }),
            related: when(arg("kind"), "a", {
              AND: [{ control: "x" }],
              OR: [{ control: "x" }],
              NOT: { control: "y" },
            }),
          },
        })
      )
    );
    expect(db.$extends).toBeTypeOf("function");
    expect(
      await callUnchecked(db, "switched", "findMany", { select: { id: true } })
    ).toEqual([{ id: "a" }]);
    // Under such a filter, a field's value is still one.
    expect(() =>
      base.$extends(
        extension(
          "nested",
          extArgs({ kind: oneOf("a").default("a") }),
          rule({
            switched: {
              root: when(arg("kind"), "a", { NOT: { control: arg("x") } }),
            },
          })
        )
      )
    ).toThrow('references undeclared control "x"');
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
      extension(
        "dated",
        extArgs({
          day: given,
          tenants: given,
          view: oneOf("scoped", "all").default("scoped"),
        }),
        rule({
          entry: {
            root: when(arg("view"), "scoped", { day: arg("day") }),
            related: when(arg("view"), "scoped", {
              tenantId: { in: arg("tenants") },
            }),
          },
        })
      )
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

  test("a tombstoning call's default domain is the chain's; a physical one keeps the same domains", () => {
    const [tenantRows] = appendResolvedExtension(
      undefined,
      tenancyRecipe(["post"]),
      scopedSchema
    ).rows!;
    const kept = (entry: ResolvedDeletion) => new Kept([["post", entry]]);
    const binding = bindRows({
      extensions: [],
      rows: [tenantRows!],
      kept: kept(deletion.post),
    });
    const defaults = binding.call("post", undefined);
    const operator = binding.call("post", { tenant: "acme", scope: "all" });
    expect(operator.domain.related.get("post")).toBeUndefined();
    expect(operator.defaults).toBe(defaults.domain);
    expect(operator.tombstones).toBe(defaults.tombstones);
    expect(operator.values?.controls).toEqual({ tenant: "acme", scope: "all" });
    const own = binding.call("post", { tenant: "acme" });
    expect(own.defaults).toBe(own.domain);
    const physical = bindRows({
      extensions: [],
      rows: [tenantRows!],
      kept: kept({ ...deletion.post, removeWhen: { mode: "hard" } }),
    });
    const removing = physical.call("post", { tenant: "acme", mode: "hard" });
    const tombstoning = physical.call("post", { tenant: "acme" });
    expect(removing.tombstones).toBeUndefined();
    expect(removing.domain).toBe(tombstoning.domain);
    expect(tombstoning.tombstones?.get("post")).toMatchObject({
      removeWhen: { mode: "hard" },
    });
  });
});

describe("rows: each predicate admitted at $extends", () => {
  // Plan K1(a): a predicate is parsed once through its model's `where`
  // schema, its values the call supplies held as registered parameters.
  const admitted = (root: object) => {
    const chain = appendResolvedExtension(
      undefined,
      {
        name: "admitted",
        controls: { who: { schema: v.object({ id: v.string() }) } },
        rows: {
          control: "scope",
          default: "on",
          models: { post: { on: { root } } },
        },
      } as ExtensionDefinitionInput,
      schema
    );
    return chain
      .callRows!.call("post", undefined)
      .domain.root.get("post")![0] as Record<string, unknown>;
  };

  test("a reference, a path into one and the call's instant are parameters; anything else is a literal", () => {
    const where = admitted({
      authorId: { control: "who", path: "id" },
      deletedAt: { lt: { now: true } },
      title: { in: ["a", "b"] },
    });
    const author = (where.authorId as { equals: Parameter }).equals;
    expect(author).toBeInstanceOf(Parameter);
    expect(author).toMatchObject({ control: "who", path: "id" });
    const now = (where.deletedAt as { lt: Parameter }).lt;
    expect(now).toBeInstanceOf(Parameter);
    expect(now).toMatchObject({ now: true });
    expect(where.title).toEqual({ in: ["a", "b"] });
    // A record with other keys, or a path that is not one, is a value.
    expect(() => admitted({ title: { control: "who", other: 1 } })).toThrow(
      ClientInitializationError
    );
    expect(() => admitted({ title: { control: "who", path: 1 } })).toThrow(
      ClientInitializationError
    );
  });

  test("a condition is a where of its own, conjoined with what it sits beside", () => {
    const alone = admitted({
      $if: { control: "who", path: "id", equals: "u1" },
    });
    expect(alone).toBeInstanceOf(Condition);
    expect(alone).toMatchObject({ test: { equals: "u1" } });
    const beside = admitted({
      title: "a",
      $if: { control: "who", exists: true },
    }) as { AND: unknown[] };
    expect(beside.AND[0]).toEqual({ title: { equals: "a" } });
    expect(beside.AND[1]).toBeInstanceOf(Condition);
  });

  test("a refusal names the extension, the model, the predicate and the path; the root is named so", () => {
    const refused = (root: object) => {
      try {
        admitted(root);
      } catch (error) {
        expect(error).toBeInstanceOf(ClientInitializationError);
        return (error as ClientInitializationError).message;
      }
      throw new Error("expected a refusal");
    };
    expect(refused(42 as unknown as object)).toContain(
      'Extension "admitted" rows.post.on.root at "root":'
    );
    expect(refused({ author: { is: { nmae: "x" } } })).toContain(
      'at "author.is.nmae"'
    );
    for (const spec of [
      "who",
      { exists: true },
      { control: "who", path: 1, exists: true },
      { control: "who" },
      { control: "who", exists: true, has: 1 },
      { control: "who", exists: true, extra: 1 },
      { control: "who", exists: "yes" },
      { control: "who", in: "u1" },
      { control: "who", hasSome: "u1" },
    ])
      expect(refused({ OR: [{ $if: spec }] }), JSON.stringify(spec)).toContain(
        'at "OR.0.$if": a condition names one control and exactly one of exists, equals, in, has, hasSome'
      );
  });

  test("positions are the where schema's: inside a relation filter, a field named control or now is that field", () => {
    const node = s.model({
      id: s.string().id(),
      control: s.string(),
      now: s.boolean(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    });
    const where = appendResolvedExtension(
      undefined,
      {
        name: "fields",
        controls: { who: { schema: v.string() } },
        rows: {
          control: "scope",
          default: "on",
          models: {
            node: {
              on: {
                root: {
                  parent: { is: { control: "literal" } },
                  children: {
                    some: { now: true },
                    every: { control: { control: "who" } },
                  },
                },
              },
            },
          },
        },
      },
      { node }
    )
      .callRows!.call("node", undefined)
      .domain.root.get("node")![0] as {
      parent: { is: unknown };
      children: { some: unknown; every: { control: { equals: unknown } } };
    };
    expect(where.parent.is).toEqual({ control: { equals: "literal" } });
    expect(where.children.some).toEqual({ now: { equals: true } });
    const who = where.children.every.control.equals;
    expect(who).toBeInstanceOf(Parameter);
    expect(who).toMatchObject({ control: "who" });
  });

  test("an admitted predicate admits again as itself", () => {
    const first = appendResolvedExtension(
      undefined,
      {
        name: "again",
        controls: { who: { schema: v.string() } },
        rows: {
          control: "scope",
          default: "on",
          models: {
            post: {
              on: {
                root: {
                  authorId: { control: "who" },
                  $if: { control: "who", exists: true },
                },
              },
            },
          },
        },
      },
      schema
    ).rows![0]!;
    const second = appendResolvedExtension(
      undefined,
      { name: "again", controls: { who: { schema: v.string() } }, rows: first },
      schema
    ).rows![0]!;
    expect(second.models.post!.on!.root).toEqual(first.models.post!.on!.root);
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
  /**
   * A chain's call facts with `data` and what else it holds: bound by the
   * filters' binding where it filters or keeps rows, else plain.
   */
  const stamped = (
    data: Readonly<Record<string, ModelStamps>>,
    others: Pick<ResolvedExtensionChain, "rows" | "kept"> = {}
  ) => {
    const chain = { extensions: [], ...others, data, stamps: new Stamps(data) };
    return others.rows || others.kept ? bindRows(chain) : bindPlain(chain);
  };

  test("a stamp's control takes the call's value, put in per call, a field of an object control by its path; a field whose control the call did not pass is not written", () => {
    const binding = stamped(audit);
    expect(new Stamps(audit).named).toBe(true);
    const facts = binding.call("post", { actor: "ann" });
    const post = facts.stamps!.get("post")!;
    expect(post.create).toEqual({ createdBy: "ann", source: "api" });
    expect(post.update).toBe(audit.post.update);
    expect(facts.stamps!.get("user")).toBe(audit.user);
    expect(facts.domain).toBe(binding.call("user", undefined).domain);
    expect(facts.values).toBeUndefined();
    const absent = binding.call("post", undefined);
    expect(absent.stamps!.get("post")!.create).toEqual({ source: "api" });
    const pathed = stamped({
      post: { update: { deletedById: { control: "who", path: "user.id" } } },
    });
    expect(
      pathed.call("post", { who: { user: { id: "u7" } } }).stamps!.get("post")!
        .update
    ).toEqual({ deletedById: "u7" });
    expect(
      pathed.call("post", { who: { user: {} } }).stamps!.get("post")!.update
    ).toEqual({});
    // Inside a list, a reference is bound too, and its absence leaves the
    // field unwritten; a record with other keys is data.
    const listed = stamped({
      post: {
        update: {
          title: [{ control: "who" }, "x"],
          deletedById: { control: "who", note: 1 },
          version: { increment: { control: "step" } },
          name: ["a", "b"],
        },
      },
    } as never);
    expect(
      listed.call("post", { who: "u1", step: 2 }).stamps!.get("post")!.update
    ).toEqual({
      title: ["u1", "x"],
      deletedById: { control: "who", note: 1 },
      version: { increment: 2 },
      name: ["a", "b"],
    });
    expect(listed.call("post", undefined).stamps!.get("post")!.update).toEqual({
      deletedById: { control: "who", note: 1 },
      name: ["a", "b"],
    });
  });

  test("a stamp's { now: true } is the call's instant, left for the engine to write; a record with other keys is data", () => {
    const data = {
      post: {
        create: { title: { now: true }, source: { now: true, at: 1 } },
        update: { title: { now: true }, createdBy: { now: true } },
      },
    } as never;
    const binding = stamped(data);
    const facts = binding.call("post", undefined);
    const post = facts.stamps!.get("post")!;
    const { title, source } = post.create as Record<string, unknown>;
    expect(title).toBeInstanceOf(Parameter);
    expect(title).toMatchObject({ now: true });
    expect(source).toEqual({ now: true, at: 1 });
    const update = post.update as Record<string, unknown>;
    expect([update.title, update.createdBy]).toEqual([title, title]);
    // An instant names no control: no call binds anything.
    expect(new Stamps(data).named).toBe(false);
    expect(binding.call("post", undefined)).toBe(facts);
  });

  test("stamps and values are a call's own: every tenant and writer shares one domain", () => {
    const scoped = appendResolvedExtension(
      undefined,
      {
        name: "scoped",
        controls: { tenant: { schema: v.string() } },
        rows: {
          control: "scope",
          default: "tenant",
          models: {
            post: {
              tenant: { root: { title: { control: "tenant" } } },
              all: {},
            },
          },
        },
      },
      schema
    ).rows!;
    const binding = stamped(audit, { rows: scoped });
    const read = binding.call("post", { tenant: "acme" });
    const ann = binding.call("post", { tenant: "acme", actor: "ann" });
    const bob = binding.call("post", { tenant: "globex", actor: "bob" });
    expect(binding.call("post", { scope: "all" }).values).toBeDefined();
    expect(ann.domain).toBe(read.domain);
    expect(bob.domain).toBe(read.domain);
    expect(bob.defaults).toBe(read.defaults);
    expect(bob.values?.controls).toEqual({ tenant: "globex", actor: "bob" });
    expect(bob.stamps!.get("post")!.create).toEqual({
      createdBy: "bob",
      source: "api",
    });
  });

  test("constant stamps keep the precomputed facts; parameterized rows leave them as declared", () => {
    const constant = { user: audit.user };
    const binding = stamped(constant);
    expect(new Stamps(constant).named).toBe(false);
    const facts = binding.call("user", undefined);
    expect(facts.values).toBeUndefined();
    expect(binding.call("post", undefined)).toBe(facts);
    expect(facts.stamps!.get("user")).toBe(audit.user);
    const scoped = appendResolvedExtension(
      undefined,
      {
        name: "scoped",
        controls: { t: { schema: v.string() } },
        rows: {
          control: "scope",
          default: "tenant",
          models: { post: { tenant: { root: { title: { control: "t" } } } } },
        },
      },
      schema
    ).rows!;
    const bound = stamped(constant, { rows: scoped });
    const tenant = bound.call("post", { t: "acme" });
    const other = bound.call("post", { t: "globex" });
    expect(tenant.domain).toBe(other.domain);
    expect(tenant.values?.controls).toEqual({ t: "acme" });
    expect(tenant.stamps).toBe(other.stamps);
    // A tombstoning call writes them too: a tombstone is an update.
    const managed = stamped(constant, {
      kept: new Kept([["post", { extension: "managed", assign: {} }]]),
    });
    const tombstoning = managed.call("post", undefined);
    expect(tombstoning.tombstones).toBeDefined();
    expect(tombstoning.stamps!.get("user")).toBe(audit.user);
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
    expect(second.callRows!.call("post", undefined).stamps!.get("post")).toBe(
      second.data!.post
    );
    const third = appendResolvedExtension(second, { name: "third" }, schema);
    expect(third.callRows).toBe(second.callRows);
  });
});

describe("controls: the order a chain takes", () => {
  test("rows may follow a result consumer: its methods run through the whole chain", () => {
    const consumer = definitionClient().$extends(
      extension(
        "consumer",
        methods((scope) => {
          const own = { models: { audited: () => ({ ping: () => "pong" }) } };
          return { ...own.client?.(scope), ...own.models };
        })
      )
    );
    const late = applyUnchecked(consumer, {
      name: "late-rows",
      rows: { control: "deleted", default: "a", models: {} },
    }) as typeof consumer;
    expect(late.audited.ping()).toBe("pong");
  });
});

describe("controls: the cache key", () => {
  async function cachedPair(order: "cache-first" | "rows-first") {
    const recorder = new KeyRecordingCache();
    const base = await seededBase();
    const official = cache({ driver: recorder, version: "v" });
    const db =
      order === "cache-first"
        ? base.$extends(official).$extends(
            extension(
              "rows",
              extArgs({
                deleted: oneOf("without", "with", "only").default("without"),
              }),
              rule({
                post: {
                  root: [
                    when(arg("deleted"), "without", { deletedAt: null }),
                    when(arg("deleted"), "only", {
                      deletedAt: { not: null },
                    }),
                  ],
                  related: [
                    when(arg("deleted"), "without", { deletedAt: null }),
                    when(arg("deleted"), "only", { deletedAt: null }),
                  ],
                },
              })
            )
          )
        : base
            .$extends(
              extension(
                "rows",
                extArgs({
                  deleted: oneOf("without", "with", "only").default("without"),
                }),
                rule({
                  post: {
                    root: [
                      when(arg("deleted"), "without", { deletedAt: null }),
                      when(arg("deleted"), "only", {
                        deletedAt: { not: null },
                      }),
                    ],
                    related: [
                      when(arg("deleted"), "without", { deletedAt: null }),
                      when(arg("deleted"), "only", { deletedAt: null }),
                    ],
                  },
                })
              )
            )
            .$extends(official);
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
      .$extends(
        extension(
          "rows",
          extArgs({
            deleted: oneOf("without", "with", "only").default("without"),
          }),
          rule({
            post: {
              root: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: { not: null } }),
              ],
              related: [
                when(arg("deleted"), "without", { deletedAt: null }),
                when(arg("deleted"), "only", { deletedAt: null }),
              ],
            },
          })
        )
      );
    const byTitle = base
      .$extends(cache({ driver: shared, version: "v" }))
      .$extends(
        extension(
          "rows",
          extArgs({
            deleted: oneOf("without", "with", "only").default("without"),
          }),
          rule({
            post: {
              root: [
                when(arg("deleted"), "without", { title: "gone" }),
                when(arg("deleted"), "only", { deletedAt: { not: null } }),
              ],
              related: [
                when(arg("deleted"), "without", { title: "gone" }),
                when(arg("deleted"), "only", { deletedAt: null }),
              ],
            },
          })
        )
      );
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
      .$extends(
        extension("writes-only", extArgs({ reason: oneOf("a").on(writes) }))
      )
      .$extends(
        extension("absent", extArgs({ region: oneOf("eu").on(reads) }))
      );
    await db.$withCache().post.findMany({ where: { title: "live" } });
    await db
      .$withCache()
      .post.findMany({ where: { title: "live" }, region: "eu" });
    expect(declared.keys[0]).toBe(plain.keys[0]);
    expect(declared.keys[1]).not.toBe(plain.keys[0]);
  });

  test("a read holding a value of a volatile argument runs uncached, whether the cache would serve it or a statement transform bypasses it; one without it is served", async () => {
    const recorder = new KeyRecordingCache();
    const statements: string[] = [];
    const judged = extension(
      "judged",
      extArgs({ caller: oneOf("a").on(reads).volatile() })
    );
    const cached = (await seededBase())
      .$extends(cache({ driver: recorder, version: "v" }))
      .$extends(judged);
    const metered = cached.$extends(
      extension(
        "meter",
        unit(
          (u, next) => {
            statements.push(statement(u).toStatement());
            return next(statement(u));
          },
          ["statement"],
          { rewrites: true }
        )
      )
    );
    const read = { caller: "a", select: { id: true } } as const;
    for (const db of [metered, cached]) {
      statements.length = 0;
      for (let round = 0; round < 2; round += 1)
        await expect(db.$withCache().post.findMany(read)).resolves.toEqual([
          { id: "p1" },
        ]);
      // Never served: each read sent its statement.
      if (db === metered) expect(statements).toHaveLength(2);
    }
    // Never stored.
    expect(recorder.keys).toEqual([]);
    await expect(
      cached.$withCache().post.findMany({ select: { id: true } })
    ).resolves.toEqual([{ id: "p1" }]);
    expect(recorder.keys).toHaveLength(1);
  });

  test("a control value no rule reads leaves the key as it is, whatever the value", async () => {
    const recorder = new KeyRecordingCache();
    const db = (await seededBase())
      .$extends(cache({ driver: recorder, version: "v" }))
      .$extends(
        extension(
          "instance",
          extArgs({
            scope: accepts(
              standard<string>((value) => ({
                value: new Map([[value, 1]]),
              }))
            ).on(reads),
          })
        )
      );
    await expect(
      db.$withCache().post.findMany({ scope: "x", select: { id: true } })
    ).resolves.toEqual([{ id: "p1" }]);
    await expect(
      db.$withCache().post.findMany({ scope: "y", select: { id: true } })
    ).resolves.toEqual([{ id: "p1" }]);
    // The key is the statement: a value it does not bind keys nothing.
    expect(recorder.keys).toHaveLength(1);
  });

  test("a rows value that is not plain data keys a read by the statement it binds, and each call reads its own value", async () => {
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
      .$extends(
        extension(
          "floor",
          extArgs({
            floor: standard<Decimal>((value) => ({ value })),
            scope: oneOf("above").default("above"),
          }),
          rule({
            price: {
              root: when(arg("scope"), "above", {
                amount: { gte: arg("floor") },
              }),
            },
          })
        )
      );
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
    // Two floors, two statements, two entries; the third read is served.
    expect(recorder.keys).toHaveLength(2);
  });
});

describe("rows: named predicates and verbs, per model", () => {
  // Plan K3: a model's predicates are admitted once by name; `read` ANDs with
  // every mode, a write's verb with its candidates (R2, R3, R8). What each
  // write is judged at, against the oracle, is witnessed on four databases
  // (tests/contracts/public-client/permissions-app-verbs.ts).
  const declared = (verbs: object, models: object = {}) =>
    ({
      name: "verbs",
      controls: { who: { schema: v.string(), required: true } },
      rows: { control: "as", default: "all", models, verbs },
    }) as ExtensionDefinitionInput;
  const bound = (definition: ExtensionDefinitionInput) =>
    appendResolvedExtension(undefined, definition, schema).callRows!;
  const mine = { authorId: { control: "who" } };

  test("each predicate is admitted once; a mode, a verb and a written field naming one share its object; a verb left out matches nothing", () => {
    const binding = bound(
      declared(
        {
          post: {
            predicates: { mine, titled: { title: "t" } },
            read: "mine",
            update: "mine",
            writes: { title: "titled" },
          },
        },
        { post: { all: {}, titled: { root: "titled" } } }
      )
    );
    const all = binding.call("post", undefined);
    const titled = binding.call("post", { as: "titled", who: "ann" });
    const layer = all!.domain.verbs!.get("post")![0]!;
    expect(titled!.domain.root.get("post")![0]).toBe(layer.writes.get("title"));
    expect(layer.read).toBe(layer.update);
    expect(
      (layer.read as { authorId: { equals: unknown } }).authorId.equals
    ).toBeInstanceOf(Parameter);
    expect(layer.delete).toEqual({ OR: [] });
    // Verbs are per model, not per mode: every combination shares them.
    expect(titled!.domain.verbs).toBe(all!.domain.verbs);
    // A value read by a verb's predicate alone makes the calls carry theirs.
    expect(all.values).toBeDefined();
    expect(titled.values).toBeDefined();
    expect(
      bound(
        declared({ post: { predicates: { titled: { title: "t" } } } })
      ).call("post", undefined).values
    ).toBeUndefined();
  });

  test("an unknown model, predicate name or written field is refused at $extends, named by its place", () => {
    const refused = (verbs: object, models?: object) =>
      refusal(() => bound(declared(verbs, models))).message;
    expect(refused({ nope: { predicates: {} } })).toBe(
      'Extension "verbs" rows.verbs.nope at "root": names an unknown model.'
    );
    for (const verb of ["read", "update", "delete"])
      expect(
        refused({ post: { predicates: { mine }, [verb]: "theirs" } })
      ).toBe(
        `Extension "verbs" rows.verbs.post at "${verb}": names unknown predicate "theirs".`
      );
    expect(
      refused({ post: { predicates: { mine }, writes: { title: "theirs" } } })
    ).toBe(
      'Extension "verbs" rows.verbs.post at "writes.title": names unknown predicate "theirs".'
    );
    expect(
      refused({ post: { predicates: { mine }, writes: { titel: "mine" } } })
    ).toBe(
      'Extension "verbs" rows.verbs.post at "writes.titel": names an unknown field.'
    );
    expect(
      refused({ post: { predicates: { mine: { titel: "t" } } } })
    ).toContain('rows.verbs.post.predicates.mine at "titel"');
    expect(
      refused(
        { post: { predicates: { mine } } },
        {
          post: { all: {}, theirs: { related: "theirs" } },
        }
      )
    ).toBe(
      'Extension "verbs" rows.post.theirs.related at "root": names unknown predicate "theirs".'
    );
    // A model's mode names only its own model's predicates.
    expect(
      refused(
        { post: { predicates: { mine } } },
        {
          user: { all: {}, mine: { root: "mine" } },
        }
      )
    ).toBe(
      'Extension "verbs" rows.user.mine.root at "root": names unknown predicate "mine".'
    );
    // A relation is a field a write names.
    expect(() =>
      bound(
        declared({ post: { predicates: { mine }, writes: { author: "mine" } } })
      )
    ).not.toThrow();
  });

  test("an unknown key in a model's verbs is refused at $extends, named with its model: a misspelt `writes` would judge its field at `update`", () => {
    // Policies may be data built at runtime, so the types do not cover it.
    const error = refusal(() =>
      bound(
        declared({
          post: {
            predicates: { mine, nobody: { id: "-" } },
            update: "mine",
            write: { title: "nobody" },
          },
        })
      )
    );
    expect(error.message).toBe(
      'Extension "verbs" rows.verbs.post at "write": is not one of predicates, read, update, delete, writes, place, moves, acyclic, evidence, reads.'
    );
    expect(error.meta).toMatchObject({ model: "post" });
  });

  test("`data: {}` on a model with nothing to stamp emits no UPDATE: its rows are read, on the base client as under verbs, never judged at `update`", async () => {
    const base = await seededBase();
    await base.user.create({ data: { id: "u2", name: "Bob" } });
    expect(
      await base.user.update({
        where: { id: "u1" },
        data: {},
        select: { id: true },
      })
    ).toEqual({ id: "u1" });
    expect(await base.user.updateMany({ data: {} })).toEqual({ count: 2 });
    expect(
      await failure(base.user.update({ where: { id: "u3" }, data: {} }))
    ).toBeInstanceOf(NotFoundError);
    const governed = applyUnchecked(
      base,
      declared({
        user: {
          predicates: { self: { id: { control: "who" } }, nobody: { id: "-" } },
          read: "self",
          update: "nobody",
        },
      })
    );
    const update = (where: object, data: object) =>
      callUnchecked(governed, "user", "update", { who: "u1", where, data });
    expect(await update({ id: "u1" }, {})).toEqual({ id: "u1", name: "Ada" });
    expect(await failure(update({ id: "u2" }, {}))).toBeInstanceOf(
      NotFoundError
    );
    expect(await failure(update({ id: "u1" }, { name: "Eve" }))).toBeInstanceOf(
      NotFoundError
    );
    expect(
      await callUnchecked(governed, "user", "updateMany", {
        who: "u1",
        data: {},
      })
    ).toEqual({ count: 1 });
  });

  test("a lax `disconnect: true` judges the member it unlinks: one the call sees and may not write is refused, as a clear is; one it cannot see keeps its link", async () => {
    const holder = s.model({
      id: s.string().id(),
      badge: s.toOne(() => badge),
    });
    const badge = s.model({
      id: s.string().id(),
      label: s.string(),
      holderId: s.string().nullable().unique(),
      holder: s
        .toOne(() => holder)
        .fields("holderId")
        .references("id"),
    });
    const base = createClient({
      schema: { holder, badge },
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    for (const [id, label] of [
      ["open", "open"],
      ["locked", "locked"],
      ["hidden", "hidden"],
    ] as const) {
      await base.holder.create({ data: { id } });
      await base.badge.create({ data: { id, label, holderId: id } });
    }
    const governed = applyUnchecked(base, {
      name: "badges",
      rows: {
        control: "as",
        default: "all",
        models: {},
        verbs: {
          holder: { predicates: { all: {} }, read: "all", update: "all" },
          badge: {
            predicates: {
              seen: { label: { not: "hidden" } },
              open: { label: "open" },
            },
            read: "seen",
            update: "seen",
            writes: { holderId: "open", holder: "open" },
          },
        },
      },
    });
    const disconnect = (id: string) =>
      callUnchecked(governed, "holder", "update", {
        where: { id },
        data: { badge: { disconnect: true } },
      });
    const holderOf = async (id: string) =>
      (await base.badge.findUnique({ where: { id } }))?.holderId;
    await disconnect("open");
    expect(await holderOf("open")).toBeNull();
    expect(await failure(disconnect("locked"))).toBeInstanceOf(
      NestedWriteError
    );
    expect(await holderOf("locked")).toBe("locked");
    await disconnect("hidden");
    expect(await holderOf("hidden")).toBe("hidden");
  });

  test("a predicate that contains itself is refused at $extends; one that shares a sub-object is admitted", () => {
    const loop: Record<string, unknown> = { title: "t" };
    loop.OR = [loop];
    const nested: Record<string, unknown> = {};
    nested.author = { is: { posts: { some: nested } } };
    for (const [predicate, at] of [
      [loop, "OR.0"],
      [nested, "author.is.posts.some"],
    ] as const) {
      expect(
        refusal(() =>
          bound(declared({ post: { predicates: { loop: predicate } } }))
        ).message
      ).toBe(
        `Extension "verbs" rows.verbs.post.predicates.loop at "${at}": contains itself.`
      );
      expect(
        refusal(() =>
          appendResolvedExtension(
            undefined,
            {
              name: "modes",
              rows: {
                control: "as",
                default: "on",
                models: { post: { on: { root: predicate } } },
              },
            } as ExtensionDefinitionInput,
            schema
          )
        ).message
      ).toBe(
        `Extension "modes" rows.post.on.root at "${at}": contains itself.`
      );
    }
    const shared = { title: "t" };
    const layer = bound(
      declared({
        post: { predicates: { both: { AND: [shared, { OR: [shared] }] } } },
      })
    )
      .call("post", undefined)
      .domain.verbs!.get("post")![0]!;
    expect(layer.read).toEqual({ OR: [] });
  });

  test("a required control is asked for on a model only verbs name, and nowhere else", () => {
    const placed = placeControls({
      name: "verbs",
      controls: { who: { oneOf: ["u1"], required: true } },
      rows: {
        control: "as",
        default: "all",
        models: {},
        verbs: { post: { predicates: { mine }, read: "mine" } },
      },
    });
    expect(placed.map(({ name, required: on }) => [name, on])).toEqual([
      ["who", new Set(["post"])],
      ["as", undefined],
    ]);
  });

  test("a chain references a control a verb's predicate names: undeclared, it is refused at $extends", () => {
    expect(
      refusal(() =>
        appendResolvedExtension(
          undefined,
          {
            name: "verbs",
            rows: {
              control: "as",
              default: "all",
              models: {},
              verbs: { post: { predicates: { mine }, read: "mine" } },
            },
          } as ExtensionDefinitionInput,
          schema
        )
      ).message
    ).toContain('"who"');
  });
});

/** A sent read's text up to its WHERE. */
const SELECTED_FROM = /^SELECT .* WHERE /;

describe("an array path as a list operand (G4, W-L4)", () => {
  const item = s.model({ id: s.string().id(), rank: s.int() });
  const listSchema = { item };
  const ids = { control: "actor", path: "key.ids" };
  const keyed = extension(
    "keyed",
    extArgs({
      actor: accepts(
        v.object({
          key: v.object({
            ids: v.optional(v.array(v.string())),
            ranks: v.optional(v.array(v.number())),
          }),
        })
      ).required(["item"]),
      as: oneOf("listed", "excluded", "ranked").default("listed"),
    }),
    rule({
      item: {
        root: [
          when(arg("as"), "listed", { id: { in: arg("actor", "key.ids") } }),
          when(arg("as"), "excluded", {
            id: { notIn: arg("actor", "key.ids") },
          }),
          when(arg("as"), "ranked", {
            rank: { in: arg("actor", "key.ranks") },
          }),
        ],
      },
    })
  );
  /** The statements a driver is handed, as the transport binds them. */
  class Recording extends SqlOnlyDriver {
    readonly sent: [string, unknown[]][] = [];
    override readonly maxBindParametersPerStatement: number | undefined;
    constructor(
      adapter: ConstructorParameters<typeof SqlOnlyDriver>[0],
      dialect: ConstructorParameters<typeof SqlOnlyDriver>[1],
      budget?: number
    ) {
      super(adapter, dialect);
      this.maxBindParametersPerStatement = budget;
    }
    // (client, sql, params): the base fixture reads none of them.
    protected override async execute<T>(
      ...args: unknown[]
    ): Promise<{ rows: T[]; rowCount: number }> {
      const [, sql, params] = args as [null, string, unknown[]];
      this.sent.push([sql.replace(SELECTED_FROM, ""), params]);
      return { rows: [], rowCount: 0 };
    }
  }
  const sent = async (driver: Recording, key: Record<string, unknown>) => {
    const db = createClient({ schema: listSchema, driver }).$extends(keyed);
    await callUnchecked(db, "item", "findMany", {
      actor: { key },
      select: { id: true },
    });
    return driver.sent.at(-1);
  };

  test("PostgreSQL binds the list whole; SQLite binds each member; an empty list takes nothing", async () => {
    const pg = new Recording(new PostgresAdapter(), "postgresql");
    expect(await sent(pg, { ids: ["a", "b", "a"] })).toEqual([
      '"q0"."id" = ANY($1) ORDER BY "q0"."id" ASC',
      ['{"a","b","a"}'],
    ]);
    expect(await sent(pg, { ids: [] })).toEqual([
      'FALSE ORDER BY "q0"."id" ASC',
      [],
    ]);
    const lite = new Recording(new SQLiteAdapter(), "sqlite");
    expect(await sent(lite, { ids: ["a", "b", "a"] })).toEqual([
      '"q0"."id" COLLATE BINARY IN (?, ?, ?) ORDER BY "q0"."id" ASC',
      ["a", "b", "a"],
    ]);
    expect(await sent(lite, { ids: ["c"] })).toEqual([
      '"q0"."id" COLLATE BINARY IN (?) ORDER BY "q0"."id" ASC',
      ["c"],
    ]);
  });

  test("over the driver's bind budget, equal members bind once and are read by number", async () => {
    const budgeted = new Recording(new SQLiteAdapter(), "sqlite", 2);
    expect(await sent(budgeted, { ids: ["a", "b", "a"] })).toEqual([
      '"q0"."id" COLLATE BINARY IN (?1, ?2, ?1) ORDER BY "q0"."id" ASC',
      ["a", "b"],
    ]);
  });

  test("on SQLite3: every length, duplicates, notIn, a list of the field's type; an absent list matches nothing", async () => {
    const base = createClient({
      schema: listSchema,
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    await syncLiveSchema(base);
    await base.item.createMany({
      data: ["a", "b", "c", "d"].map((id, rank) => ({ id, rank })),
    });
    const db = base.$extends(keyed);
    const read = async (as: string, key: Record<string, unknown>) =>
      (
        (await callUnchecked(db, "item", "findMany", {
          actor: { key },
          as,
          select: { id: true },
          orderBy: { id: "asc" },
        })) as { id: string }[]
      ).map(({ id }) => id);
    for (const [given, taken] of [
      [["a"], ["a"]],
      [
        ["d", "b", "b"],
        ["b", "d"],
      ],
      [[], []],
      [["missing"], []],
    ] as const) {
      expect(await read("listed", { ids: given }), String(given)).toEqual(
        taken
      );
      expect(await read("excluded", { ids: given }), String(given)).toEqual(
        ["a", "b", "c", "d"].filter((id) => !taken.includes(id as never))
      );
    }
    expect(await read("ranked", { ranks: [0, 3] })).toEqual(["a", "d"]);
    // Absent, the required actor's list is false wherever it is read (R6).
    expect(await read("listed", {})).toEqual([]);
    expect(await read("excluded", {})).toEqual([]);
  });
});
