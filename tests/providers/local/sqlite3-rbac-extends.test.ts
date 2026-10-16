import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError, ForbiddenError } from "@errors";
import { s } from "@schema";
import { rbac } from "@src/rbac";
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
            view: { authorId: { actor: "userId" } },
            edit: { authorId: { actor: "userId" } },
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
    expect(await alice.post.can("edit", { id: "b" })).toBe(false);
    await alice.post.assert("edit", { id: "a" });
    expect(
      await alice.$transaction((tx) => tx.post.can("edit", { id: "a" }))
    ).toBe(true);
    const derived = alice.$extends((client) =>
      client.$extends({ name: "after-policy" })
    );
    expect(await derived.post.findMany()).toEqual(await alice.post.findMany());
    const rollback = new Error("rollback governed transaction");
    await expect(
      derived.$transaction(async (tx) => {
        expect(await tx.post.can("edit", { id: "b" })).toBe(false);
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
          models: { post: { view: {} } },
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
          view: { authorId: { actor: "userId" } },
          edit: { authorId: { actor: "userId" } },
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

test("$extends refuses repeated levels before a view rule can authorize a write", async () => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "p", title: "original" } });
    expect(() =>
      base.$extends(
        rbac({
          actor: v.object({}),
          levels: ["view", "edit", "view"],
          models: { post: { view: {} } },
        })
      )
    ).toThrow("levels must list each action only once");
    const db = base
      .$extends(
        rbac({
          actor: v.object({}),
          levels: ["view", "edit"],
          models: { post: { view: {} } },
        })
      )
      .$as({});
    expect(await db.post.can("edit", { id: "p" })).toBe(false);
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
    view: ["reader"],
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
            user: { actions: { view: [] }, view: {} },
            post: {
              actions: { view: [], edit: ["view"] },
              view: {},
              edit: {
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
    expect(await db.post.can("edit", { id: "p" })).toBe(false);
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
              actions: { view: [], ["__proto__"]: [] },
              view: {},
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
              view: {},
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
            levels: ["view", "edit", "full"],
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
          levels: ["view", "edit", "full"],
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
