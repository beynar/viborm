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
import { QueryError, ValidationError } from "@errors";
import { Kept, type ResolvedKept } from "@extensions/kept";
import { bindRows } from "@extensions/rows";
import { Condition, Parameter } from "@query-engine/raptor3/shared/row-scope";
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
  models,
  oneOf,
  reads,
  rule,
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
import { appendExtension } from "@tests/fixtures/extension-chain";
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

/** Apply an extension written apart from the client, as JavaScript would. */
function applyUnchecked(client: object, value: unknown): object {
  return Reflect.apply(Reflect.get(client, "$extends"), client, [value]);
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

const NAMED_CONTROL = /set argument "(reason|deleted)"/;

/** A mode argument and the rule that reads it, on `post`. */
const softRows = extension(
  "rows",
  extArgs({ deleted: oneOf("without", "with", "only").default("without") }),
  rule({
    post: {
      root: [
        when(arg("deleted"), "without", { deletedAt: null }),
        when(arg("deleted"), "only", { deletedAt: { not: null } }),
      ],
      related: when(arg("deleted"), "without", { deletedAt: null }),
    },
  })
);

describe("controls: admission and ownership", () => {
  test("two contributing extensions: each owner's handlers see only their own admitted controls; inputs never carry one", async () => {
    const seen: string[] = [];
    const record = (label: string, input: object, controls: object) => {
      const leaked = ["deleted", "reason", "region"].filter((key) =>
        Reflect.has(input, key)
      );
      seen.push(`${label}:${JSON.stringify(controls)}:${leaked.join(",")}`);
    };
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
            (c) => record("audit-request", c.args, c.values),
            extTarget("post", "findMany")
          ),
          around(
            (c) => (run) => {
              record("audit-query", run.input, c.values);
              return run();
            },
            extTarget("post", "findMany")
          )
        )
      )
      .$extends(
        extension(
          "tenant",
          extArgs({ region: oneOf("eu", "us").on(reads) }),
          call(
            (c) => record("tenant-request", c.args, c.values),
            extTarget(models)
          )
        )
      )
      .$extends(
        extension(
          "bystander",
          call(
            (c) => record("bystander-request", c.args, c.values),
            extTarget(models)
          ),
          around((c) => (run) => {
            record("bystander-query", run.input, c.values);
            return run();
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
          }, extTarget(models))
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
            }, extTarget(models))
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
            }, extTarget(models))
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
      {
        path: "region",
        message: 'Argument "region" must be one of "eu", "us"',
      },
    ]);
    expect(outside.operation).toBe("findMany");
  });

  test("a schema control: issues are a ValidationError at its path; a throwing or async validator is a QueryError; a VibORMError passes through", async () => {
    const base = await seededBase();
    const typed = new ValidationError({ kind: "registry" }, [
      { path: "x", message: "owned" },
    ]);
    const withValidator = (
      name: string,
      validate: (value: unknown) => unknown
    ) =>
      applyUnchecked(
        base,
        extension(name, extArgs({ reason: standard(validate) }))
      );

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
      { path: "reason", message: 'Argument "reason" too short' },
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
      ["async", async (value) => ({ value }), "returned a promise"],
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
      extension("callable", extArgs({ reason: schema }))
    );
    await expect(db.post.findMany({ reason: "why" })).resolves.toHaveLength(1);
    const invalid = await failure(db.post.findMany({ reason: "because" }));
    expect(invalid).toBeInstanceOf(ValidationError);
    if (!(invalid instanceof ValidationError)) throw invalid;
    expect(invalid.issues).toEqual([
      { path: "reason", message: 'Argument "reason" is not why' },
    ]);
  });

  test("arguments that are not an object stay core's ValidationError, as on a client without controls", async () => {
    const base = await seededBase();
    const rows = applyUnchecked(base, softRows);
    const plain = applyUnchecked(
      base,
      extension("plain", extArgs({ flag: oneOf("a", "b") }))
    );
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
        }, extTarget(models))
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
  const DELETES = ["delete", "deleteMany"] as const;
  // Each kept-rows argument is placed where its own declaration says, on its
  // own managed model's deletes, whichever extension declares it and in
  // either order: what a `keep` reads does not move it.
  const managing = extension(
    "managing",
    extArgs({ mode: oneOf("soft", "hard").on(DELETES).models(["post"]) }),
    rule({
      post: {
        delete: {
          instead: keep(unless(arg("mode"), "hard", { deletedAt: extNow })),
        },
      },
    })
  );
  const purging = extension(
    "purging",
    extArgs({ purge: oneOf("no", "yes").on(DELETES).models(["user"]) }),
    rule({
      user: {
        delete: {
          instead: keep(unless(arg("purge"), "yes", { removedAt: extNow })),
        },
      },
    })
  );
  for (const [first, second] of [
    [managing, purging],
    [purging, managing],
  ] as const) {
    test(`two extensions' kept-rows arguments stay on their own model's deletes (${first.name} first)`, async () => {
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
    { path: "tenant", message: 'Argument "tenant" is required' },
  ];

  test("a required control is asked for on every model that accepts it: a call that does not pass it is refused at its path on every operation it is placed on, before it writes; passed, it is admitted", async () => {
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
      { path: "mode", message: 'Argument "mode" is required' },
    ]);
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
      ).toEqual([{ path: "tenant", message: 'Argument "tenant" is required' }]);
    }
    expect(
      await issues(
        callUnchecked(db, "note", "create", {
          data: { id: "n1", body: "x" },
          tenant: "acme",
        })
      )
    ).toEqual([{ path: "actor", message: 'Argument "actor" is required' }]);
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
      { path: "tenant", message: 'Argument "tenant" is required' },
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
  const bound = (...definitions: unknown[]) => {
    let chain: ReturnType<typeof appendExtension> | undefined;
    for (const definition of definitions)
      chain = appendExtension(chain, definition, scopedSchema);
    return chain!.callRows!;
  };

  test("a predicate's value is a parameter; an absent optional value travels as absent", () => {
    const binding = bound(optimisticLock(["post"]));
    const [checked] = binding.call("post", undefined).domain.root.get("post")!;
    // `when` is folded per call: its filter is the second arm of its `OR`.
    const operand = (
      checked as { OR: [unknown, { version: { equals: unknown } }] }
    ).OR[1].version.equals;
    expect(operand).toBeInstanceOf(Parameter);
    expect(operand).toMatchObject({ arg: "expectedVersion" });
    // Absent, the lock's value still travels as absent: the engine drops it,
    // as no control of the chain is required.
    // An argument with a default takes it where the call passes none.
    const absent = binding.call("post", undefined).values!;
    expect(absent.args).toEqual({ versionCheck: "checked" });
    expect(absent.required("expectedVersion", "post")).toBe(false);
    // `unchecked` names nothing, but its default domain does.
    const unchecked = binding.call("post", { versionCheck: "unchecked" });
    expect(unchecked.values).toBeDefined();
    expect(unchecked.domain).toBe(
      binding.call("post", { versionCheck: "unchecked", expectedVersion: 2 })
        .domain
    );
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
    ).toThrow('references undeclared argument "x"');
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

  test("every call shares the chain's one domain, its values beside it; a physical one keeps it", () => {
    const [tenantRows] = appendExtension(
      undefined,
      tenancyRecipe(["post"]),
      scopedSchema
    ).rules!;
    const kept = (entry: ResolvedKept) => new Kept([["post", entry]]);
    const binding = bindRows({
      extensions: [],
      rules: [tenantRows!],
      kept: kept(deletion.post),
    });
    const defaults = binding.call("post", undefined);
    const operator = binding.call("post", { tenant: "acme", scope: "all" });
    expect(operator.domain).toBe(defaults.domain);
    expect(operator.tombstones).toBe(defaults.tombstones);
    expect(operator.values?.args).toEqual({ tenant: "acme", scope: "all" });
    const physical = bindRows({
      extensions: [],
      rules: [tenantRows!],
      // `keep(unless(arg("mode"), "hard", …))`: kept unless the test holds.
      kept: kept({
        ...deletion.post,
        test: new Condition(new Parameter("mode"), { equals: "hard" }),
        keeps: false,
      }),
    });
    const removing = physical.call("post", { tenant: "acme", mode: "hard" });
    const tombstoning = physical.call("post", { tenant: "acme" });
    expect(removing.tombstones).toBeUndefined();
    expect(removing.domain).toBe(tombstoning.domain);
    expect(tombstoning.tombstones?.get("post")).toMatchObject({
      at: "deletedAt",
    });
  });
});

describe("controls: the order a chain takes", () => {
  test("rows may follow a result consumer: its methods run through the whole chain", () => {
    const consumer = definitionClient().$extends(
      extension(
        "consumer",
        // Taking the scope makes it a result consumer.
        methods((_scope) => ({ audited: () => ({ ping: () => "pong" }) }))
      )
    );
    const late = applyUnchecked(
      consumer,
      extension(
        "late-rows",
        extArgs({ deleted: oneOf("a", "b").default("a") }),
        rule({})
      )
    ) as typeof consumer;
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
    const floor = arg("floor");
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
                // Held: under an operator, a word is typed before this
                // extension's own arguments (a reported type defect).
                amount: { gte: floor },
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

/** A sent read's text up to its WHERE. */
const SELECTED_FROM = /^SELECT .* WHERE /;

describe("an array path as a list operand (G4, W-L4)", () => {
  const item = s.model({ id: s.string().id(), rank: s.int() });
  const listSchema = { item };
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
