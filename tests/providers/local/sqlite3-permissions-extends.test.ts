import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError, ForbiddenError } from "@errors";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { permissions, type Rule } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { runPermissionsUpsertBehavior } from "@tests/contracts/public-client/permissions-upsert-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test.each([
  "absent",
  "false guard",
  "true alternative",
])("absorbing an inherited rule preserves independent grants (%s)", async (shape) => {
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    title: s.string(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({
      data: { id: "p", authorId: "alice", title: "public" },
    });
    const db = base.$extends(
      permissions({
        actor: v.object({
          userId: v.string({ optional: true, nullable: true }),
          admin: v.boolean(),
        }),
        models: {
          post: {
            read:
              shape === "true alternative"
                ? {
                    title: "public",
                    OR: [
                      { authorId: { actor: "userId" } },
                      { actor: { admin: false } },
                    ],
                  }
                : shape === "false guard"
                  ? {
                      OR: [
                        { title: "public" },
                        {
                          actor: { admin: true },
                          authorId: { actor: "userId" },
                        },
                      ],
                    }
                  : { title: "public" },
            update: { title: "public", authorId: { actor: "userId" } },
          },
        },
      })
    );
    // Each declared grant owns its actor dependencies. Missing optional
    // update facts never close the independent public read grant.
    for (const actor of [
      { admin: false },
      { admin: false, userId: undefined },
    ]) {
      // @ts-expect-error Contextual scalar options widen; exercise runtime omission.
      expect(await db.$as(actor).post.findMany()).toEqual([
        { id: "p", authorId: "alice", title: "public" },
      ]);
    }
    expect(
      await db.$as({ userId: null, admin: false }).post.findMany()
    ).toEqual([{ id: "p", authorId: "alice", title: "public" }]);
    expect(
      await db.$as({ userId: "bob", admin: false }).post.findMany()
    ).toEqual([{ id: "p", authorId: "alice", title: "public" }]);
  } finally {
    await base.$disconnect();
  }
});

test("absorption preserves conditional actor reads and whole-list validation", async () => {
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    title: s.string(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    const row = { id: "p", authorId: "alice", title: "public" };
    await base.post.create({ data: row });
    const actor = v.object({
      network: v.string(),
      ids: v.optional(v.union([v.string(), v.array(v.string())])),
    });
    const db = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: { title: "public" },
            update: {
              actor: { network: "home" },
              title: "public",
              authorId: { in: { actor: "ids" } },
            },
          },
        },
      })
    );
    // The disabled branch reads no values. When enabled, the whole-list
    // parameter must still be a list even though the broad read rule matches.
    expect(
      await db.$as({ network: "office", ids: undefined }).post.findMany()
    ).toEqual([row]);
    expect(await db.$as({ network: "home" }).post.findMany()).toEqual([row]);
    expect(
      await db.$as({ network: "home", ids: "alice" }).post.findMany()
    ).toEqual([]);
    expect(await db.$as({ network: "home", ids: [] }).post.findMany()).toEqual([
      row,
    ]);
  } finally {
    await base.$disconnect();
  }
});

test("absorption reverses containment for a negative relation quantifier", async () => {
  const parent = s.model({
    id: s.string().id(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentId: s.string(),
    in: s.string().array(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });
  const base = createClient({ schema: { parent, child }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.parent.create({ data: { id: "p" } });
    await base.child.create({
      data: { id: "c", parentId: "p", in: ["a", "b"] },
    });
    const db = base.$extends(
      permissions({
        actor: v.object({}),
        models: {
          parent: {
            read: { children: { none: { in: ["a", "b"] } } },
            update: { children: { none: { in: ["a"] } } },
          },
        },
      })
    );
    // This parent has no child whose array is exactly ["a"]. Update grants
    // read by inheritance; the child column's name is not a set operator.
    expect(await db.$as({}).parent.findMany()).toEqual([{ id: "p" }]);
  } finally {
    await base.$disconnect();
  }
});

test("$extends applies Permissions with actor isolation, methods and transactions", async () => {
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    title: s.string(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "a", authorId: "alice", title: "Alice" },
        { id: "b", authorId: "bob", title: "Bob" },
      ],
    });
    const db = base.$extends(
      permissions({
        actor: v.object({ userId: v.string() }),
        models: {
          post: {
            read: { authorId: { actor: "userId" } },
            update: { authorId: { actor: "userId" } },
          },
        },
      })
    );
    const alice = db.$as({ userId: "alice" });
    const bob = db.$as({ userId: "bob" });
    expect(await alice.post.findMany()).toEqual([
      { id: "a", authorId: "alice", title: "Alice" },
    ]);
    expect(await bob.post.findMany()).toEqual([
      { id: "b", authorId: "bob", title: "Bob" },
    ]);
    expect(await alice.post.can("update", { id: "b" })).toBe(false);
    await alice.post.assert("update", { id: "a" });
    expect(
      await alice.$transaction((tx) => tx.post.can("update", { id: "a" }))
    ).toBe(true);
    const derived = alice.$extends((client) =>
      client.$extends({ name: "after-policy" })
    );
    expect(await derived.post.findMany()).toEqual(await alice.post.findMany());
    const rollback = new Error("rollback governed transaction");
    await expect(
      derived.$transaction(async (tx) => {
        expect(await tx.post.can("update", { id: "b" })).toBe(false);
        await tx.post.update({
          where: { id: "a" },
          data: { title: "temporary" },
        });
        throw rollback;
      })
    ).rejects.toBe(rollback);
    expect((await base.post.findUnique({ where: { id: "a" } }))?.title).toBe(
      "Alice"
    );
    expect(await base.post.count()).toBe(2);

    // Factories still append through the existing chain admission boundary.
    const consumer = base.$extends({
      name: "consumer",
      client: () => ({ $ready: () => true }),
    });
    expect(() =>
      consumer.$extends(
        // @ts-expect-error - exercise the runtime refusal for invalid ordering
        permissions({
          actor: v.object({ userId: v.string() }),
          models: { post: { read: {} } },
        })
      )
    ).toThrow(ClientInitializationError);
  } finally {
    await base.$disconnect();
  }
});

test("$extends composes soft-delete rows, Permissions and restore methods", async () => {
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    deletedAt: s.dateTime().nullable(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "a", authorId: "alice", deletedAt: null },
        { id: "b", authorId: "bob", deletedAt: null },
      ],
    });
    const tombstones = softDelete({
      models: { post: { deletedAt: "deletedAt" } },
    });
    const policy = permissions({
      actor: v.object({ userId: v.string() }),
      models: {
        post: {
          read: { authorId: { actor: "userId" } },
          update: { authorId: { actor: "userId" } },
          delete: { authorId: { actor: "userId" } },
        },
      },
    });
    const db = base
      .$extends(tombstones.rows)
      .$extends(policy)
      .$extends(tombstones.methods);
    const alice = db.$as({ userId: "alice" });
    await alice.post.delete({ where: { id: "a" } });
    expect(await alice.post.findMany()).toEqual([]);
    expect(
      (await alice.post.restore({ where: { id: "a" } })).deletedAt
    ).toBeNull();
    expect(await alice.post.findMany()).toEqual([
      { id: "a", authorId: "alice", deletedAt: null },
    ]);
    await alice.post.delete({ where: { id: "a" } });
    await expect(
      db.$as({ userId: "bob" }).post.restore({ where: { id: "a" } })
    ).rejects.toThrow();
    expect(
      (await base.post.findUnique({ where: { id: "a" } }))?.deletedAt
    ).toBeInstanceOf(Date);
  } finally {
    await base.$disconnect();
  }
});

test("$extends refuses repeated levels before a read rule can authorize a write", async () => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "p", title: "original" } });
    expect(() =>
      base.$extends(
        permissions({
          actor: v.object({}),
          levels: ["read", "update", "read"],
          models: { post: { read: {} } },
        })
      )
    ).toThrow("levels must list each action only once");
    const db = base
      .$extends(
        permissions({
          actor: v.object({}),
          levels: ["read", "update"],
          models: { post: { read: {} } },
        })
      )
      .$as({});
    expect(await db.post.can("update", { id: "p" })).toBe(false);
    await expect(
      db.post.update({ where: { id: "p" }, data: { title: "changed" } })
    ).rejects.toThrow();
    expect((await base.post.findUnique({ where: { id: "p" } }))?.title).toBe(
      "original"
    );
  } finally {
    await base.$disconnect();
  }
});

test("an explicit target role table denies an undeclared requested action", async () => {
  const roles: Readonly<Record<string, readonly string[]>> = {
    read: ["reader"],
  };
  const user = s.model({
    id: s.string().id(),
    role: s.string(),
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
  });
  const base = createClient({ schema: { post, user }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.user.create({ data: { id: "u", role: "outsider" } });
    await base.post.create({
      data: { id: "p", title: "original", authorId: "u" },
    });
    const db = base
      .$extends(
        permissions({
          actor: v.object({}),
          models: {
            user: { actions: { read: [] }, read: {} },
            post: {
              actions: { read: [], update: ["read"] },
              read: {},
              update: {
                author: {
                  is: (action) => ({
                    role: { in: roles[action] ?? [], not: "banned" },
                  }),
                },
              },
            },
          },
        })
      )
      .$as({});
    expect(await db.post.can("update", { id: "p" })).toBe(false);
    await expect(
      db.post.update({ where: { id: "p" }, data: { title: "changed" } })
    ).rejects.toThrow();
    expect((await base.post.findUnique({ where: { id: "p" } }))?.title).toBe(
      "original"
    );
  } finally {
    await base.$disconnect();
  }
});

test("prototype-spelled action and domain names preserve filtering and answers", async () => {
  const post = s.model({ id: s.string().id() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({ data: [{ id: "allowed" }, { id: "denied" }] });
    const db = base
      .$extends(
        permissions({
          actor: v.object({}),
          models: {
            post: {
              actions: { read: [], ["__proto__"]: [] },
              read: {},
              ["__proto__"]: { id: "allowed" },
            },
          },
        })
      )
      .$as({});
    expect(await db.post.findMany({ as: "__proto__" })).toEqual([
      { id: "allowed" },
    ]);
    expect(await db.post.can("__proto__", { id: "allowed" })).toBe(true);
    expect(await db.post.can("__proto__", { id: "denied" })).toBe(false);
    expect(await db.post.can(["__proto__"], { id: "allowed" })).toEqual({
      ["__proto__"]: true,
    });
    const narrowed = base
      .$extends(
        permissions({
          actor: v.object({}),
          models: {
            post: {
              read: {},
              domains: { ["__proto__"]: { id: "allowed" } },
            },
          },
        })
      )
      .$as({});
    expect(await narrowed.post.findMany({ as: "__proto__" })).toEqual([
      { id: "allowed" },
    ]);
  } finally {
    await base.$disconnect();
  }
});

test("delete always requires its own action unless explicitly mapped", async () => {
  const post = s.model({ id: s.string().id() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "p" } });
    for (const rules of [{ full: {} }, { full: {}, share: {} }]) {
      const db = base
        .$extends(
          permissions({
            actor: v.object({}),
            levels: ["read", "update", "full"],
            models: { post: rules },
          })
        )
        .$as({});
      expect(await db.post.can("full", { id: "p" })).toBe(true);
      await expect(
        db.post.delete({ where: { id: "p" } })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(db.post.deleteMany({})).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(await base.post.count()).toBe(1);
    }
    const mapped = base
      .$extends(
        permissions({
          actor: v.object({}),
          levels: ["read", "update", "full"],
          models: { post: { full: {}, operations: { delete: "full" } } },
        })
      )
      .$as({});
    expect(await mapped.post.delete({ where: { id: "p" } })).toEqual({
      id: "p",
    });
    expect(await base.post.count()).toBe(0);
  } finally {
    await base.$disconnect();
  }
});

test("CRUD grants, explicit denials and scoped service principals compose", async () => {
  const post = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    authorId: s.string(),
    title: s.string(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  const actor = v.object({
    kind: v.union([v.literal("user"), v.literal("service")]),
    principalId: v.string(),
    organizationId: v.string(),
  });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "mine", organizationId: "a", authorId: "alice", title: "mine" },
        { id: "other", organizationId: "a", authorId: "bob", title: "other" },
        {
          id: "foreign",
          organizationId: "b",
          authorId: "alice",
          title: "foreign",
        },
      ],
    });
    const db = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            mandatory: { organizationId: { actor: "organizationId" } },
            update: {
              OR: [
                { authorId: { actor: "principalId" } },
                { actor: { kind: "service" } },
              ],
            },
            delete: false,
          },
        },
      })
    );
    const alice = {
      kind: "user" as const,
      principalId: "alice",
      organizationId: "a",
    };
    const service = {
      kind: "service" as const,
      principalId: "worker",
      organizationId: "a",
    };
    const [normal, scoped, denied] = await Promise.all([
      db.$as(alice).post.findMany({ orderBy: { id: "asc" } }),
      db
        .$as(service, ["post.update"])
        .post.findMany({ orderBy: { id: "asc" } }),
      db.$as(alice, []).post.findMany(),
    ]);
    expect(normal.map(({ id }) => id)).toEqual(["mine"]);
    expect(scoped.map(({ id }) => id)).toEqual(["mine", "other"]);
    expect(denied).toEqual([]);
    expect(
      await db.$as(alice, ["post.update"]).post.can("update", { id: "other" })
    ).toBe(false);
    expect(
      await db.$as(service, ["post.delete"]).post.can("delete", { id: "mine" })
    ).toBe(false);
    await expect(
      db
        .$as(service, ["post.read"])
        .post.update({ where: { id: "mine" }, data: { title: "no" } })
    ).rejects.toThrow();
    await db
      .$as(service, ["post.update"])
      .post.update({ where: { id: "other" }, data: { title: "service" } });
    expect(
      (await base.post.findUnique({ where: { id: "other" } }))?.title
    ).toBe("service");
    expect(
      (await base.post.findUnique({ where: { id: "foreign" } }))?.title
    ).toBe("foreign");
    const evidence = await db
      .$as(service, ["post.update"])
      .post.findUnique({ where: { id: "mine" }, include: { $access: true } });
    expect(evidence?.$access).toEqual({
      update: true,
      delete: false,
      read: true,
    });
  } finally {
    await base.$disconnect();
  }
});

test("create-only policies admit proposed rows and grant neither read nor update", async () => {
  const post = s.model({ id: s.string().id(), ownerId: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    const owned: Rule = { ownerId: { actor: "userId" } };
    const config = {
      actor: v.object({ userId: v.string() }),
      models: {
        post: {
          create: owned,
        },
      },
    };
    const call = base
      .$extends(permissions(config))
      .$as({ userId: "alice" }, ["post.create"]);
    await call.post.create({ data: { id: "p", ownerId: "alice" } });
    // A creation rule judges a proposed row and grants no read of stored
    // rows: the model declares no read action, so a read is refused before
    // any statement (R9), and the row exists below the policy.
    await expect(call.post.findMany()).rejects.toBeInstanceOf(ForbiddenError);
    expect(await base.post.findMany()).toEqual([{ id: "p", ownerId: "alice" }]);
    await expect(
      call.post.create({ data: { id: "foreign", ownerId: "bob" } })
    ).rejects.toThrow();
    await expect(
      call.post.update({ where: { id: "p" }, data: { ownerId: "bob" } })
    ).rejects.toThrow();
    const hidden = base
      .$extends(
        permissions({
          ...config,
          models: { post: { ...config.models.post, read: false } },
        })
      )
      .$as({ userId: "alice" }, ["post.create"]);
    expect(await hidden.post.findMany()).toEqual([]);
    expect(await base.post.count()).toBe(1);
  } finally {
    await base.$disconnect();
  }
});

test("grouped callbacks retain declaring actions through inheritance and evidence", async () => {
  const post = s.model({ id: s.string().id(), ownerId: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "update", ownerId: "alice" },
        { id: "delete", ownerId: "alice" },
      ],
    });
    const calls: string[] = [];
    const call = base
      .$extends(
        permissions({
          actor: v.object({}),
          models: {
            post: {
              "update, delete": (action) => {
                calls.push(action);
                return { id: action };
              },
            },
          },
        })
      )
      .$as({});
    // Rules are evaluated when their model first compiles: at its first call.
    expect(calls).toEqual([]);
    const rows = await call.post.findMany({
      orderBy: { id: "asc" },
      include: { $access: true },
    });
    expect(rows.map(({ id, $access }) => ({ id, $access }))).toEqual([
      { id: "delete", $access: { update: false, delete: true, read: true } },
      { id: "update", $access: { update: true, delete: false, read: true } },
    ]);
    expect(calls).toEqual(["update", "delete"]);
  } finally {
    await base.$disconnect();
  }
});

test("scope binding validates, detaches caller input, and resets on a new unrestricted actor binding", async () => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "p", title: "original" } });
    const db = base.$extends(
      permissions({
        actor: v.object({}),
        models: { post: { read: true, update: true } },
      })
    );
    for (const scopes of [
      null,
      "post.read",
      [1],
      ["missing.read"],
      ["post.publish"],
      ["post.*"],
    ]) {
      await expect(async () => {
        // @ts-expect-error - hostile runtime values must still be refused
        await db.$as({}, scopes).post.findMany();
      }).rejects.toThrow();
    }
    const scopes: "post.read"[] = ["post.read"];
    const readOnly = db.$as({}, scopes);
    scopes.length = 0;
    expect(await readOnly.post.count()).toBe(1);
    await expect(
      readOnly.post.update({ where: { id: "p" }, data: { title: "denied" } })
    ).rejects.toThrow();
    await readOnly
      .$as({})
      .post.update({ where: { id: "p" }, data: { title: "allowed" } });
    expect((await base.post.findUnique({ where: { id: "p" } }))?.title).toBe(
      "allowed"
    );
  } finally {
    await base.$disconnect();
  }
});

test("field write grants complement the base update permission and credential scope", async () => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "p", title: "original" } });
    for (const model of [
      {
        read: true,
        update: false,
        full: true,
        fields: { title: { write: "full" as const } },
      },
      { read: true, full: true, fields: { title: { write: "full" as const } } },
    ]) {
      const call = base
        .$extends(permissions({ actor: v.object({}), models: { post: model } }))
        .$as({});
      await expect(
        call.post.update({ where: { id: "p" }, data: { title: "denied" } })
      ).rejects.toThrow();
    }
    const db = base.$extends(
      permissions({
        actor: v.object({}),
        models: {
          post: {
            read: true,
            update: true,
            full: true,
            fields: { title: { write: "full" as const } },
          },
        },
      })
    );
    for (const scopes of [
      ["post.update"] as const,
      ["post.full", "post.read"] as const,
    ]) {
      await expect(
        db
          .$as({}, scopes)
          .post.update({ where: { id: "p" }, data: { title: "denied" } })
      ).rejects.toThrow();
    }
    await db
      .$as({}, ["post.update", "post.full"])
      .post.update({ where: { id: "p" }, data: { title: "allowed" } });
    expect((await base.post.findUnique({ where: { id: "p" } }))?.title).toBe(
      "allowed"
    );
  } finally {
    await base.$disconnect();
  }
});

test("cached evidence and rows are isolated between scopes for the same actor", async () => {
  const post = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    title: s.string(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({
      data: { id: "p", ownerId: "alice", title: "original" },
    });
    const db = base.$extends(cache({ driver: new MemoryCache() })).$extends(
      permissions({
        actor: v.object({ userId: v.string() }),
        cache: "allow",
        models: {
          post: { read: { ownerId: { actor: "userId" } }, update: true },
        },
      })
    );
    const actor = { userId: "alice" };
    const reader = db.$as(actor, ["post.read"]).$withCache({ ttl: 60_000 });
    const writer = db.$as(actor, ["post.update"]).$withCache({ ttl: 60_000 });
    const denied = db.$as(actor, []).$withCache({ ttl: 60_000 });
    const args = { include: { $access: true } } as const;
    const readOnly = [
      {
        id: "p",
        ownerId: "alice",
        title: "original",
        $access: { read: true, update: false },
      },
    ];
    expect(await reader.post.findMany(args)).toEqual(readOnly);
    // The base client bypasses this cache extension's invalidation. A stale
    // answer establishes that the repeated request really is a cache hit.
    await base.post.update({ where: { id: "p" }, data: { title: "changed" } });
    expect(await reader.post.findMany(args)).toEqual(readOnly);
    const writable = [
      {
        id: "p",
        ownerId: "alice",
        title: "changed",
        $access: { read: true, update: true },
      },
    ];
    expect(await writer.post.findMany(args)).toEqual(writable);
    expect(await denied.post.findMany(args)).toEqual([]);
    await base.post.update({ where: { id: "p" }, data: { title: "newest" } });
    expect(await writer.post.findMany(args)).toEqual(writable);
    expect(await reader.post.findMany(args)).toEqual(readOnly);
    expect(await denied.post.findMany(args)).toEqual([]);
    expect((await base.post.findUnique({ where: { id: "p" } }))?.title).toBe(
      "newest"
    );
  } finally {
    await base.$disconnect();
  }
});

test("a cached read is keyed on the policy's content once, and goes uncached when another model's rules are refused", async () => {
  const post = s.model({ id: s.string().id(), ownerId: s.string() });
  const note = s.model({ id: s.string().id(), ownerId: s.string() });
  const base = createClient({ schema: { post, note }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "p", ownerId: "alice" } });
    const owned = { ownerId: { actor: "userId" } } as const;
    const cached = (models: object) =>
      base.$extends(cache({ driver: new MemoryCache() })).$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          cache: "allow",
          models,
        } as never)
      ) as unknown as {
        $as(actor: object): {
          $withCache(options: object): {
            post: { findMany(): Promise<unknown[]> };
          };
        };
      };
    const healthy = cached({ post: { read: owned }, note: { read: owned } });
    const reader = healthy.$as({ userId: "alice" }).$withCache({ ttl: 60_000 });
    expect(await reader.post.findMany()).toHaveLength(1);
    await base.post.create({ data: { id: "q", ownerId: "alice" } });
    // A hit: the base write bypassed this cache's invalidation.
    expect(await reader.post.findMany()).toHaveLength(1);

    // `note`'s rule names an actor path the actor schema lacks: a cached
    // read of `post` still answers, uncached, and never reads `note`.
    const broken = cached({
      post: { read: owned },
      note: { read: { ownerId: { actor: "usrId" } } },
    });
    const fresh = broken.$as({ userId: "alice" }).$withCache({ ttl: 60_000 });
    expect(await fresh.post.findMany()).toHaveLength(2);
    await base.post.create({ data: { id: "r", ownerId: "alice" } });
    expect(await fresh.post.findMany()).toHaveLength(3);
  } finally {
    await base.$disconnect();
  }
});

test("a same-row field reference in a rule compares two columns of the row", async () => {
  const post = s.model({ id: s.string().id(), views: s.int(), likes: s.int() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "a", views: 1, likes: 1 },
        { id: "b", views: 5, likes: 1 },
      ],
    });
    const refs = createModelFieldRefs("post", post);
    const db = base.$extends(
      permissions({
        actor: v.object({}),
        models: { post: { read: { views: { gt: refs.likes } } } },
      })
    );
    expect(await db.$as({}).post.findMany({ select: { id: true } })).toEqual([
      { id: "b" },
    ]);
  } finally {
    await base.$disconnect();
  }
});

test("a read-gated field reads NULL where withheld: distinct and groupBy over it merge rows", async () => {
  const project = s.model({ id: s.string().id(), budget: s.int() });
  const base = createClient({ schema: { project }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.project.createMany({
      data: [
        { id: "a", budget: 10 },
        { id: "b", budget: 20 },
      ],
    });
    const db = base.$extends(
      permissions({
        actor: v.object({ admin: v.boolean() }),
        models: {
          project: {
            read: true,
            full: { actor: { admin: true } },
            fields: { budget: { read: "full" } },
          },
        },
      })
    );
    const user = db.$as({ admin: false });
    expect(await user.project.count()).toBe(2);
    expect(
      await user.project.findMany({
        distinct: ["budget"],
        select: { id: true },
      })
    ).toHaveLength(1);
    expect(
      await user.project.groupBy({ by: ["budget"], _count: true })
    ).toEqual([{ budget: null, _count: 2 }]);
    expect(
      await user.project.findMany({ where: { budget: { gt: 5 } } })
    ).toEqual([]);
    expect(
      await db
        .$as({ admin: true })
        .project.findMany({ distinct: ["budget"], select: { id: true } })
    ).toHaveLength(2);
  } finally {
    await base.$disconnect();
  }
});

runPermissionsUpsertBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});

test("a refused new row names the key an update writes through a nested to-one delete", async () => {
  const author = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id")
      .onDelete("setNull"),
  });
  const base = createClient({ schema: { author, post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.author.create({ data: { id: "a1" } });
    await base.post.create({ data: { id: "p1", authorId: "a1" } });
    const db = base
      .$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: {
            author: { read: true, delete: true },
            post: {
              read: true,
              update: true,
              create: { authorId: { not: null } },
            },
          },
        })
      )
      .$as({ userId: "u1" });
    await expect(
      db.post.update({
        where: { id: "p1" },
        data: { author: { delete: true } },
      })
    ).rejects.toThrow(
      "The update on post is not permitted: the row it would leave, judged again because it writes authorId (through author), is refused"
    );
    await expect(
      db.post.update({ where: { id: "p1" }, data: { authorId: null } })
    ).rejects.toThrow("because it writes authorId, is refused");
    expect(await base.author.count()).toBe(1);
  } finally {
    await base.$disconnect();
  }
});
