import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
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
