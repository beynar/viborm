import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { getOfficialDefaultOmitRequestCapability } from "@client/default-omit-extension";
import { PGliteDriver } from "@drivers/pglite";
import { ClientInitializationError, ValidationError } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import { defaultOmit } from "@src/client/exports";
import { createClient, s } from "@src/index";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { isRecord } from "@validation/value-guards";
import { afterEach, describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    email: s.string(),
    passwordHash: s.string(),
    posts: s.toMany(() => post).name("author"),
  })
  .map("default_omit_users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    secret: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id")
      .name("author"),
  })
  .map("default_omit_posts");
const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
  })
  .map("default_omit_nodes");
const note = s
  .model({
    id: s.string().id(),
    body: s.string(),
    secret: s.string(),
  })
  .map("default_omit_notes");
const image = s
  .model({
    id: s.string().id(),
    url: s.string(),
    token: s.string(),
  })
  .map("default_omit_images");
const board = s
  .model({
    id: s.string().id(),
    pinned: s.toOne(
      { note: () => note, image: () => image },
      { values: { note: "default.note.v1", image: "default.image.v1" } }
    ),
  })
  .map("default_omit_boards");
const gallery = s
  .model({
    id: s.string().id(),
    items: s.toMany(
      { note: () => note, image: () => image },
      { values: { note: "default.notes.v1", image: "default.images.v1" } }
    ),
  })
  .map("default_omit_galleries");

const schema = { user, post, node, note, image, board, gallery };
const family = usePGliteSchemaFamily(schema);
const disposableClients: Array<{ $disconnect(): Promise<void> }> = [];

const omissionConfig = {
  user: { passwordHash: true },
  post: { secret: true },
  node: { label: true },
  note: { secret: true },
  image: { token: true },
} as const;

function omission() {
  return defaultOmit<typeof schema>()(omissionConfig);
}

function extensionOnlyBase() {
  const client = createClient({ schema, driver: new PGliteDriver() });
  disposableClients.push(client);
  return client;
}

function applyUnsafe(client: object, extension: unknown): object {
  const extend = Reflect.get(client, "$extends");
  if (typeof extend !== "function") throw new Error("Expected $extends");
  return Reflect.apply(extend, client, [extension]);
}

function isPasswordHidden(value: unknown): boolean {
  return isRecord(value) && !Object.hasOwn(value, "passwordHash");
}

async function seed(): Promise<void> {
  const { client } = family();
  await client.user.createMany({
    data: [
      {
        id: "u1",
        email: "ada@example.test",
        passwordHash: "hash-1",
      },
      {
        id: "u-delete",
        email: "delete@example.test",
        passwordHash: "hash-delete",
      },
    ],
  });
  await client.post.create({
    data: {
      id: "p1",
      title: "First",
      secret: "post-secret",
      authorId: "u1",
    },
  });
  await client.node.createMany({
    data: [
      { id: "root", label: "Root", parentId: null },
      { id: "child", label: "Child", parentId: "root" },
    ],
  });
  await client.note.create({
    data: { id: "n1", body: "Note", secret: "note-secret" },
  });
  await client.image.create({
    data: { id: "i1", url: "image.png", token: "image-token" },
  });
  await client.board.create({
    data: {
      id: "b1",
      pinned: { connect: { type: "note", where: { id: "n1" } } },
    },
  });
  await client.gallery.create({
    data: {
      id: "g1",
      items: {
        connect: [
          { type: "note", where: { id: "n1" } },
          { type: "image", where: { id: "i1" } },
        ],
      },
    },
  });
}

afterEach(async () => {
  for (const client of disposableClients.splice(0)) {
    await client.$disconnect();
  }
});

describe("official default omit foundation", () => {
  test("snapshots one frozen capability without mutating caller config", () => {
    const reads = { model: 0, field: 0 };
    const fields = {
      get passwordHash(): true {
        reads.field += 1;
        return true;
      },
    };
    const config = {
      get user() {
        reads.model += 1;
        return fields;
      },
    };

    const extension = defaultOmit<typeof schema>()(config);
    const capability = getOfficialDefaultOmitRequestCapability(
      extension.request
    );

    expect(extension.name).toBe("viborm.defaultOmit");
    expect(Reflect.ownKeys(extension)).toEqual(["name", "request"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(fields)).toBe(false);
    expect(reads).toEqual({ model: 1, field: 1 });
    expect(capability).toBeDefined();
    expect(
      getOfficialDefaultOmitRequestCapability({ ...extension }.request)
    ).toBe(capability);
    expect(getOfficialDefaultOmitRequestCapability(() => ({}))).toBeUndefined();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability?.config)).toBe(true);
    expect(Object.isFrozen(Reflect.get(capability?.config ?? {}, "user"))).toBe(
      true
    );
    expect(reads).toEqual({ model: 1, field: 1 });
  });

  test("normalizes hostile configuration inspection without leaking values", () => {
    const hostileKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private-default-omit-ownKeys");
        },
      }
    );
    const hostileField = {
      get user() {
        // biome-ignore lint/style/useThrowOnlyError: exercises non-Error normalization
        throw "private-default-omit-field";
      },
    };
    const create = defaultOmit<typeof schema>();

    for (const hostile of [hostileKeys, hostileField]) {
      let failure: unknown;
      try {
        Reflect.apply(create, undefined, [hostile]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ClientInitializationError);
      if (!(failure instanceof ClientInitializationError)) continue;
      expect(failure.originalCause).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("private-default-omit");
    }
  });

  test("accepts an exact clone and rejects provenance attacks atomically", () => {
    const base = extensionOnlyBase();
    const official = omission();
    const cloned = { ...official };
    const derived = base.$extends(cloned);

    expect(derived.$schema).toBe(schema);
    expect(() =>
      applyUnsafe(base, { name: "viborm.defaultOmit", request: () => ({}) })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, { ...official, name: "renamed-default-omit" })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, { ...official, request: () => ({}) })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, {
        ...official,
        request: official.request.bind(undefined),
      })
    ).toThrow(ClientInitializationError);
    expect(() => applyUnsafe(derived, official)).toThrow(
      ClientInitializationError
    );
    expect(derived.$extends({ name: "after-refusals" }).$schema).toBe(schema);
  });

  test("preserves official hybrid admission error precedence", () => {
    const base = extensionOnlyBase();
    const omit = omission();
    const observed = instrumentation({ logging: { error: true } });
    const derived = base.$extends(omit).$extends(observed);

    expect(() =>
      applyUnsafe(derived, {
        name: omit.name,
        request: omit.request,
        observe: observed.observe,
      })
    ).toThrow(
      "The official instrumentation extension is already present on this client."
    );
  });

  test("admits result-agnostic extensions before omit and refuses prior result consumers", () => {
    const base = extensionOnlyBase();
    const official = omission();
    const admitted = [
      base.$extends({ name: "request", request: () => ({}) }),
      base.$extends({
        name: "generic-query",
        query: async ({ proceed }) => proceed(),
      }),
      base.$extends({
        name: "statement",
        statement: ({ statement }) => statement,
      }),
      base.$extends({
        name: "observe",
        observe: (_unit, proceed) => proceed(),
      }),
      base.$extends(cache({ driver: new MemoryCache() })),
      base.$extends(instrumentation({ tracing: true })),
    ];
    const refused = [
      base.$extends({
        name: "mapped-query",
        query: {
          user: {
            findMany: async ({ proceed }) => proceed(),
          },
        },
      }),
      base.$extends({
        name: "client",
        client: () => ({ $prior: () => true }),
      }),
      base.$extends({
        name: "model",
        model: { user: () => ({ prior: () => true }) },
      }),
    ];

    for (const client of admitted) {
      const withDefaultOmit = applyUnsafe(client, official);
      expect(Reflect.get(withDefaultOmit, "$schema")).toBe(schema);
    }
    for (const client of refused) {
      expect(() => applyUnsafe(client, official)).toThrow(
        "The default omit extension cannot follow an extension that defines model-mapped query, client, or model behavior."
      );
    }
    expect(base.$extends({ name: "still-usable" }).$schema).toBe(schema);
  });

  test("does not read the removed built-in omit configuration", () => {
    let reads = 0;
    const config = {
      schema,
      driver: new PGliteDriver(),
      get omit() {
        reads += 1;
        throw new Error("removed omit accessor was read");
      },
    };

    const client = Reflect.apply(createClient, undefined, [config]);
    disposableClients.push(client);

    expect(reads).toBe(0);
    expect(Reflect.get(client, "$schema")).toBe(schema);
  });
});

describe("official default omit public behavior", () => {
  test("isolates base, authentic derived, and sibling projections", async () => {
    await seed();
    const { client: base } = family();
    const mutableFields: { passwordHash?: true } = { passwordHash: true };
    const mutableConfig = { user: mutableFields };
    const extension = defaultOmit<typeof schema>()(mutableConfig);
    mutableFields.passwordHash = undefined;
    const derived = base.$extends(extension);
    const sibling = base.$extends(
      defaultOmit<typeof schema>()({ user: { email: true } })
    );

    expect(await base.user.findUniqueOrThrow({ where: { id: "u1" } })).toEqual({
      id: "u1",
      email: "ada@example.test",
      passwordHash: "hash-1",
    });
    expect(
      await derived.user.findUniqueOrThrow({ where: { id: "u1" } })
    ).toEqual({ id: "u1", email: "ada@example.test" });
    expect(
      await sibling.user.findUniqueOrThrow({ where: { id: "u1" } })
    ).toEqual({ id: "u1", passwordHash: "hash-1" });
    expect(Reflect.get(base, "$hiddenUsers")).toBeUndefined();
    const baseHidden = Reflect.get(base.user, "hidden");
    if (typeof baseHidden !== "function") {
      throw new TypeError(
        "Expected the model proxy to defer unknown operations"
      );
    }
    await expect(Reflect.apply(baseHidden, base.user, [])).rejects.toThrow(
      "Unknown operation 'hidden' on model 'user'"
    );
  });

  test("hides the default on all nine row-returning operations", async () => {
    await seed();
    const client = family().client.$extends(omission());
    const reads = [
      await client.user.findFirst({ where: { id: "u1" } }),
      await client.user.findFirstOrThrow({ where: { id: "u1" } }),
      ...(await client.user.findMany({ where: { id: "u1" } })),
      await client.user.findUnique({ where: { id: "u1" } }),
      await client.user.findUniqueOrThrow({ where: { id: "u1" } }),
      await client.user.create({
        data: {
          id: "u-create",
          email: "create@example.test",
          passwordHash: "create-hash",
        },
      }),
      await client.user.update({
        where: { id: "u1" },
        data: { email: "updated@example.test" },
      }),
      await client.user.delete({ where: { id: "u-delete" } }),
      await client.user.upsert({
        where: { id: "u-upsert" },
        create: {
          id: "u-upsert",
          email: "upsert@example.test",
          passwordHash: "upsert-hash",
        },
        update: { email: "updated-upsert@example.test" },
      }),
    ];

    expect(reads).toHaveLength(9);
    for (const row of reads) expect(isPasswordHidden(row)).toBe(true);
  });

  test("preserves select and local omit precedence", async () => {
    await seed();
    const client = family().client.$extends(omission());

    expect(
      await client.user.findMany({
        select: { id: true, passwordHash: true },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "u-delete", passwordHash: "hash-delete" },
      { id: "u1", passwordHash: "hash-1" },
    ]);
    expect(
      await client.user.findMany({
        where: { id: "u1" },
        omit: { passwordHash: false },
      })
    ).toEqual([
      {
        id: "u1",
        email: "ada@example.test",
        passwordHash: "hash-1",
      },
    ]);
    expect(
      await client.user.findMany({
        where: { id: "u1" },
        omit: { email: true },
      })
    ).toEqual([{ id: "u1" }]);
  });

  test("does not turn bulk counts into rows and narrows explicit returning", async () => {
    await seed();
    const client = family().client.$extends(omission());

    expect(
      await client.user.createMany({
        data: [
          {
            id: "u-count",
            email: "count@example.test",
            passwordHash: "count-hash",
          },
        ],
      })
    ).toEqual({ count: 1 });
    expect(
      await client.user.createMany({
        data: [
          {
            id: "u-return",
            email: "return@example.test",
            passwordHash: "return-hash",
          },
        ],
        omit: { email: true },
      })
    ).toEqual([{ id: "u-return" }]);
    expect(
      await client.user.updateMany({
        where: { id: "u1" },
        data: { email: "bulk-count@example.test" },
      })
    ).toEqual({ count: 1 });
    expect(
      await client.user.updateMany({
        where: { id: "u1" },
        data: { email: "bulk-return@example.test" },
        omit: { email: true },
      })
    ).toEqual([{ id: "u1" }]);
    expect(await client.user.deleteMany({ where: { id: "u-count" } })).toEqual({
      count: 1,
    });
    expect(
      await client.user.deleteMany({
        where: { id: "u-return" },
        omit: { email: true },
      })
    ).toEqual([{ id: "u-return" }]);
  });

  test("rewrites ordinary, recursive, direct-variant, and collection results", async () => {
    await seed();
    const client = family().client.$extends(omission());

    expect(
      await client.user.findMany({
        where: { id: "u1" },
        include: { posts: { include: { author: true } } },
      })
    ).toEqual([
      {
        id: "u1",
        email: "ada@example.test",
        posts: [
          {
            id: "p1",
            title: "First",
            authorId: "u1",
            author: { id: "u1", email: "ada@example.test" },
          },
        ],
      },
    ]);
    expect(
      await client.node.findMany({
        where: { id: "root" },
        include: { children: true },
      })
    ).toEqual([
      {
        id: "root",
        parentId: null,
        children: [{ id: "child", parentId: "root" }],
      },
    ]);

    const boards = await client.board.findMany({ include: { pinned: true } });
    expect(boards).toEqual([
      {
        id: "b1",
        pinned: { type: "note", data: { id: "n1", body: "Note" } },
      },
    ]);
    const galleries = await client.gallery.findMany({
      include: { items: true },
    });
    const items = galleries[0]?.items ?? [];
    expect(items.map(({ type }) => type).sort()).toEqual(["image", "note"]);
    for (const item of items) {
      expect(Object.hasOwn(item.data, "secret")).toBe(false);
      expect(Object.hasOwn(item.data, "token")).toBe(false);
    }
  });

  test("inherits exact defaults through callback, nested, and array transactions", async () => {
    await seed();
    const client = family().client.$extends(omission());

    const callback = await client.$transaction(async (tx) => {
      const root = await tx.user.findUniqueOrThrow({ where: { id: "u1" } });
      const nested = await tx.$transaction((inner) =>
        inner.user.findUniqueOrThrow({ where: { id: "u1" } })
      );
      return { root, nested };
    });
    expect(callback).toEqual({
      root: { id: "u1", email: "ada@example.test" },
      nested: { id: "u1", email: "ada@example.test" },
    });

    const array = await client.$transaction([
      client.user.findMany({ where: { id: "u1" } }),
      client.post.findMany({ where: { id: "p1" } }),
    ]);
    expect(array).toEqual([
      [{ id: "u1", email: "ada@example.test" }],
      [{ id: "p1", title: "First", authorId: "u1" }],
    ]);
  });

  test("leaves count, exist, aggregate, and groupBy result families unchanged", async () => {
    await seed();
    const client = family().client.$extends(omission());

    expect(
      await client.user.count({ select: { _all: true, email: true } })
    ).toEqual({ _all: 2, email: 2 });
    expect(await client.user.exist({ where: { id: "u1" } })).toBe(true);
    expect(
      await client.user.aggregate({ _count: true, _min: { email: true } })
    ).toEqual({ _count: 2, _min: { email: "ada@example.test" } });
    expect(
      await client.user.groupBy({
        by: ["email"],
        _count: true,
        orderBy: { email: "asc" },
      })
    ).toEqual([
      { email: "ada@example.test", _count: 1 },
      { email: "delete@example.test", _count: 1 },
    ]);
  });

  test("keeps cache after omit on the same detached result shape", async () => {
    await seed();
    const cacheDriver = new MemoryCache();
    const client = family()
      .client.$extends(omission())
      .$extends(cache({ driver: cacheDriver }));

    const first = await client
      .$withCache()
      .user.findMany({ where: { id: "u1" } });
    const second = await client
      .$withCache()
      .user.findMany({ where: { id: "u1" } });
    expect(first).toEqual([{ id: "u1", email: "ada@example.test" }]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  test("runs request transforms before default omission and core validation", async () => {
    await seed();
    const events: string[] = [];
    const client = family()
      .client.$extends(omission())
      .$extends({
        name: "after-default-omit",
        request: {
          user: {
            findMany({ input }) {
              events.push(
                Object.hasOwn(input, "omit") ? "request:omit" : "request:plain"
              );
              return {
                take: 1,
                where: { email: { equals: "ada@example.test" } },
              };
            },
          },
        },
        query: {
          user: {
            async findMany({ input, proceed }) {
              const select = Reflect.get(input, "select");
              events.push(
                isRecord(select) &&
                  Object.hasOwn(select, "email") &&
                  !Object.hasOwn(select, "passwordHash")
                  ? "query:select"
                  : "query:unprepared"
              );
              return proceed();
            },
          },
        },
        client(scope) {
          return { $hiddenUsers: () => scope.user.findMany({}) };
        },
        model: {
          user(delegate) {
            return { hidden: () => delegate.findMany({}) };
          },
        },
      });

    await expect(client.user.findMany({ take: -1 })).resolves.toEqual([
      { id: "u1", email: "ada@example.test" },
    ]);
    expect(events).toEqual(["request:plain", "query:select"]);
    expect(await client.$hiddenUsers()).toEqual([
      { id: "u1", email: "ada@example.test" },
    ]);
    expect(await client.user.hidden()).toEqual([
      { id: "u1", email: "ada@example.test" },
    ]);
    const unextended = family().client;
    expect(Reflect.get(unextended, "$hiddenUsers")).toBeUndefined();
    const unextendedHidden = Reflect.get(unextended.user, "hidden");
    if (typeof unextendedHidden !== "function") {
      throw new TypeError(
        "Expected the model proxy to defer unknown operations"
      );
    }
    await expect(
      Reflect.apply(unextendedHidden, unextended.user, [])
    ).rejects.toThrow("Unknown operation 'hidden' on model 'user'");
  });

  test("still lets core validation own unknown ordinary input", async () => {
    await seed();
    const client = family().client.$extends(omission());
    const findMany = Reflect.get(client.user, "findMany");

    await expect(
      Reflect.apply(findMany, client.user, [{ where: { emale: "typo" } }])
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
