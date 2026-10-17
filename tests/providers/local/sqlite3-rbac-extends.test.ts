import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError, ForbiddenError } from "@errors";
import { s } from "@schema";
import { type Rule, rbac } from "@src/rbac";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test("$extends applies RBAC with actor isolation, methods and transactions", async () => {
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
      rbac({
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
        rbac({
          actor: v.object({ userId: v.string() }),
          models: { post: { read: {} } },
        })
      )
    ).toThrow(ClientInitializationError);
  } finally {
    await base.$disconnect();
  }
});

test("$extends composes soft-delete rows, RBAC and restore methods", async () => {
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
    const policy = rbac({
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
        rbac({
          actor: v.object({}),
          levels: ["read", "update", "read"],
          models: { post: { read: {} } },
        })
      )
    ).toThrow("levels must list each action only once");
    const db = base
      .$extends(
        rbac({
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
        rbac({
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
        rbac({
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
        rbac({
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
          rbac({
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
        rbac({
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
      rbac({
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

test("create-only policies admit proposed rows and grant read without granting update", async () => {
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
      .$extends(rbac(config))
      .$as({ userId: "alice" }, ["post.create"]);
    await call.post.create({ data: { id: "p", ownerId: "alice" } });
    expect(await call.post.findMany()).toEqual([{ id: "p", ownerId: "alice" }]);
    await expect(
      call.post.create({ data: { id: "foreign", ownerId: "bob" } })
    ).rejects.toThrow();
    await expect(
      call.post.update({ where: { id: "p" }, data: { ownerId: "bob" } })
    ).rejects.toThrow();
    const hidden = base
      .$extends(
        rbac({
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
        rbac({
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
    expect(calls).toEqual(["update", "delete"]);
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
      rbac({
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
        .$extends(rbac({ actor: v.object({}), models: { post: model } }))
        .$as({});
      await expect(
        call.post.update({ where: { id: "p" }, data: { title: "denied" } })
      ).rejects.toThrow();
    }
    const db = base.$extends(
      rbac({
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
      rbac({
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
