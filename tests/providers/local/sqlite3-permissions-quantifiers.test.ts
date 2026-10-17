import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test.each([
  { every: { OR: [] }, none: { id: "blocked" } },
  { none: { id: "blocked" }, every: { OR: [] } },
])("every false and none require an empty relation: %j", async (children) => {
  const parent = s.model({
    id: s.string().id(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });
  const base = createClient({ schema: { parent, child }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.parent.createMany({
      data: [{ id: "empty" }, { id: "populated" }],
    });
    await base.child.create({ data: { id: "allowed", parentId: "populated" } });
    const db = permissions({
      actor: v.object({ id: v.string() }),
      levels: ["read"],
      models: { parent: { read: { children } }, child: { read: {} } },
    })(base).$as({ id: "actor" });
    expect(await db.parent.findMany()).toEqual([{ id: "empty" }]);
    expect(await db.parent.can("read", { id: "populated" })).toBe(false);
  } finally {
    await base.$disconnect();
  }
});

test("optional facts preserve positive related grants without allowing negated uncertainty", async () => {
  const organization = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    public: s.boolean(),
    documents: s.toMany(() => document),
  });
  const document = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id"),
    envelopes: s.toMany(() => envelope),
  });
  const envelope = s.model({
    id: s.string().id(),
    documentId: s.string(),
    document: s
      .toOne(() => document)
      .fields("documentId")
      .references("id"),
  });
  const base = createClient({
    schema: { organization, document, envelope },
    dataDir: ":memory:",
  });
  try {
    await syncLiveSchema(base);
    await base.organization.createMany({
      data: [
        { id: "public", ownerId: "alice", public: true },
        { id: "private", ownerId: "alice", public: false },
      ],
    });
    await base.document.createMany({
      data: [
        { id: "public", organizationId: "public" },
        { id: "private", organizationId: "private" },
      ],
    });
    await base.envelope.createMany({
      data: [
        { id: "public", documentId: "public" },
        { id: "private", documentId: "private" },
      ],
    });
    const actor = v.object({ userId: v.optional(v.string()) });
    const organizationRules = {
      read: { public: true },
      update: { ownerId: { actor: "userId" as const } },
    };
    const positive = base.$extends(
      permissions({
        actor,
        models: {
          organization: organizationRules,
          document: { read: { organization: "read" } },
          envelope: { read: { document: "read" } },
        },
      })
    );
    expect(
      await positive.$as({}).envelope.findMany({ select: { id: true } })
    ).toEqual([{ id: "public" }]);
    const negative = base.$extends(
      permissions({
        actor,
        models: {
          organization: organizationRules,
          document: { read: { organization: "read" } },
          envelope: { read: { NOT: { document: "read" } } },
        },
      })
    );
    expect(await negative.$as({}).envelope.findMany()).toEqual([]);
    expect(
      await negative
        .$as({ userId: "bob" })
        .envelope.findMany({ select: { id: true } })
    ).toEqual([{ id: "private" }]);
    const doubleNegative = base.$extends(
      permissions({
        actor,
        models: {
          organization: organizationRules,
          document: { read: { NOT: { organization: "read" } } },
          envelope: { read: { NOT: { document: "read" } } },
        },
      })
    );
    expect(await doubleNegative.$as({}).envelope.findMany()).toEqual([]);
    const every = base.$extends(
      permissions({
        actor,
        models: {
          organization: {
            read: { NOT: { documents: { every: { organization: "update" } } } },
            update: organizationRules.update,
          },
        },
      })
    );
    expect(await every.$as({}).organization.findMany()).toEqual([]);
    expect(await every.$as({ userId: "bob" }).organization.count()).toBe(2);
  } finally {
    await base.$disconnect();
  }
});

test("optional scalar, list and mandatory dependencies retain their declared boundaries", async () => {
  const post = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    public: s.boolean(),
    metadata: s.json(),
  });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    const metadata = { audit: { control: "actor", path: "user.id" } };
    await base.post.create({
      data: { id: "p", ownerId: "alice", public: true, metadata },
    });
    const actor = v.object({
      user: v.optional(v.object({ id: v.string({ nullable: true }) })),
      ids: v.optional(v.array(v.string())),
      active: v.boolean(),
    });
    const db = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: { public: true },
            update: { NOT: { ownerId: { actor: "user.id" } } },
            delete: { id: { in: { actor: "ids" } } },
          },
        },
      })
    );
    for (const facts of [
      { active: true },
      { active: true, user: { id: null } },
    ]) {
      const view = db.$as(facts);
      expect(await view.post.count()).toBe(1);
      expect(
        await view.post.can(["read", "update", "delete"], { id: "p" })
      ).toEqual({ read: true, update: false, delete: false });
    }
    const nestedNull = base.$extends(
      permissions({
        actor: v.object({
          userId: v.union([v.string(), v.union([v.literal(null), v.number()])]),
        }),
        models: {
          post: {
            read: { public: true },
            update: { ownerId: { actor: "userId" } },
          },
        },
      })
    );
    expect(await nestedNull.$as({ userId: null }).post.count()).toBe(1);
    expect(
      await nestedNull.$as({ userId: null }).post.can("update", { id: "p" })
    ).toBe(false);
    const jsonActor = base.$extends(
      permissions({
        actor: v.object({ json: v.json() }),
        models: {
          post: {
            read: { public: true },
            update: { metadata: { equals: { actor: "json" } } },
          },
        },
      })
    );
    expect(await jsonActor.$as({ json: null }).post.count()).toBe(1);
    expect(
      await jsonActor.$as({ json: null }).post.can("update", { id: "p" })
    ).toBe(false);
    const restricted = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            mandatory: { ownerId: { actor: "user.id" } },
            read: true,
          },
        },
      })
    );
    expect(await restricted.$as({ active: true }).post.count()).toBe(0);
    const conditional = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: {
              OR: [
                { actor: { active: false } },
                { ownerId: { actor: "user.id" } },
              ],
            },
          },
        },
      })
    );
    expect(await conditional.$as({ active: false }).post.count()).toBe(1);
    expect(await conditional.$as({ active: true }).post.count()).toBe(0);
    const literal = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: { metadata: { equals: metadata } },
          },
        },
      })
    );
    expect(await literal.$as({ active: true }).post.count()).toBe(1);
  } finally {
    await base.$disconnect();
  }
});
