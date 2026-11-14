import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { permissions, type Rule } from "@src/permissions";
import { v } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

/** An optional actor value's presence: the guard an author writes. */
const present = (path: string) => ({ control: "actor", path, exists: true });

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
      models: { parent: { read: { children } }, child: { read: {} } },
    })(base).$as({ id: "actor" });
    expect(await db.parent.findMany()).toEqual([{ id: "empty" }]);
    expect(
      await db.parent.findUnique({
        where: { id: "populated" },
        select: { $access: ["read"] },
      })
    ).toBeNull();
  } finally {
    await base.$disconnect();
  }
});

test("a missing optional fact closes the permission unless the author guards it, positive or negated", async () => {
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
      read: {
        OR: [{ public: true }, { ownerId: { actor: "userId" as const } }],
      },
      update: { ownerId: { actor: "userId" as const } },
    };
    const positive = (read: Rule, update: Rule) =>
      base.$extends(
        permissions({
          actor,
          models: {
            organization: { read, update },
            document: { read: { organization: "read" } },
            envelope: { read: { document: "read" } },
          },
        })
      );
    // Unguarded, the absent value closes the whole permission, the public
    // alternative with it, and so does the update rule read inherits; the
    // author's guards skip only what they guard.
    const owner = { $if: present("userId"), ownerId: { actor: "userId" } };
    const guardedRead = { OR: [{ public: true }, owner] };
    for (const read of [organizationRules.read, guardedRead])
      expect(
        await positive(read, organizationRules.update)
          .$as({})
          .envelope.findMany()
      ).toEqual([]);
    expect(
      await positive(guardedRead, owner)
        .$as({})
        .envelope.findMany({ select: { id: true } })
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
    // Update and delete imply read: unguarded, their missing values close it.
    const unguarded = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: { public: true },
            update: { NOT: { ownerId: { actor: "user.id" } } },
          },
        },
      })
    );
    expect(await unguarded.$as({ active: true }).post.count()).toBe(0);
    const db = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: { public: true },
            update: {
              $if: present("user.id"),
              NOT: { ownerId: { actor: "user.id" } },
            },
            delete: { $if: present("ids"), id: { in: { actor: "ids" } } },
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
        await view.post.findUnique({
          where: { id: "p" },
          select: { $access: ["read", "update", "delete"] },
        })
      ).toEqual({ $access: { read: true, update: false, delete: false } });
    }
    const nestedNull = base.$extends(
      permissions({
        actor: v.object({
          userId: v.union([v.string(), v.union([v.literal(null), v.number()])]),
        }),
        models: {
          post: {
            read: { public: true },
            update: { $if: present("userId"), ownerId: { actor: "userId" } },
          },
        },
      })
    );
    expect(await nestedNull.$as({ userId: null }).post.count()).toBe(1);
    expect(
      await nestedNull.$as({ userId: null }).post.findUnique({
        where: { id: "p" },
        select: { $access: ["update"] },
      })
    ).toEqual({ $access: { update: false } });
    const jsonActor = base.$extends(
      permissions({
        actor: v.object({ json: v.json() }),
        models: {
          post: {
            read: { public: true },
            update: {
              $if: present("json"),
              metadata: { equals: { actor: "json" } },
            },
          },
        },
      })
    );
    expect(await jsonActor.$as({ json: null }).post.count()).toBe(1);
    expect(
      await jsonActor.$as({ json: null }).post.findUnique({
        where: { id: "p" },
        select: { $access: ["update"] },
      })
    ).toEqual({ $access: { update: false } });
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

test("guarded OR alternatives isolate missing facts through nested relations; unguarded ones close the permission", async () => {
  const folder = s.model({
    id: s.string().id(),
    documents: s.toMany(() => document),
  });
  const document = s.model({
    id: s.string().id(),
    folderId: s.string(),
    public: s.boolean(),
    ownerId: s.string(),
    folder: s
      .toOne(() => folder)
      .fields("folderId")
      .references("id"),
  });
  const base = createClient({
    schema: { folder, document },
    dataDir: ":memory:",
  });
  try {
    await syncLiveSchema(base);
    await base.folder.createMany({
      data: [{ id: "public" }, { id: "private" }, { id: "empty" }],
    });
    await base.document.createMany({
      data: [
        { id: "public", folderId: "public", public: true, ownerId: "alice" },
        { id: "private", folderId: "private", public: false, ownerId: "alice" },
      ],
    });
    const actor = v.object({
      userId: v.optional(v.string({ nullable: true })),
      ids: v.optional(v.array(v.string())),
    });
    const alternatives = {
      OR: [
        { public: true },
        { ownerId: { actor: "userId" as const } },
        { id: { in: { actor: "ids" as const } } },
      ],
    };
    const guarded = {
      OR: [
        { public: true },
        { $if: present("userId"), ownerId: { actor: "userId" as const } },
        { $if: present("ids"), id: { in: { actor: "ids" as const } } },
      ],
    };
    const db = base.$extends(
      permissions({
        actor,
        models: {
          document: {
            read: { AND: [{ id: { not: "excluded" } }, guarded] },
          },
          folder: { read: { documents: { some: guarded } } },
        },
      })
    );
    for (const facts of [{}, { userId: null }]) {
      const view = db.$as(facts);
      expect(await view.document.findMany({ select: { id: true } })).toEqual([
        { id: "public" },
      ]);
      expect(await view.folder.findMany({ select: { id: true } })).toEqual([
        { id: "public" },
      ]);
      expect(
        await view.document.findUnique({
          where: { id: "private" },
          select: { $access: ["read"] },
        })
      ).toBeNull();
    }
    const unguarded = base.$extends(
      permissions({
        actor,
        models: { document: { read: alternatives } },
      })
    );
    expect(await unguarded.$as({}).document.findMany()).toEqual([]);
    expect(await db.$as({ userId: "alice" }).document.count()).toBe(2);
    expect(await db.$as({ ids: ["private"] }).document.count()).toBe(2);
    expect(await db.$as({ ids: [] }).document.count()).toBe(1);

    const alternativeNot = base.$extends(
      permissions({
        actor,
        models: {
          document: {
            read: {
              OR: [
                { public: true },
                {
                  $if: present("userId"),
                  NOT: { ownerId: { actor: "userId" } },
                },
              ],
            },
          },
        },
      })
    );
    expect(
      await alternativeNot.$as({}).document.findMany({ select: { id: true } })
    ).toEqual([{ id: "public" }]);
    expect(await alternativeNot.$as({ userId: "bob" }).document.count()).toBe(
      2
    );

    const mandatoryTarget = base.$extends(
      permissions({
        actor,
        models: {
          folder: {
            mandatory: { OR: [{ id: "public" }, { id: { actor: "userId" } }] },
            read: true,
          },
          document: { read: { folder: "read" } },
        },
      })
    );
    expect(await mandatoryTarget.$as({}).document.findMany()).toEqual([]);
    expect(
      await mandatoryTarget
        .$as({ userId: "bob" })
        .document.findMany({ select: { id: true } })
    ).toEqual([{ id: "public" }]);

    // An unguarded negative or vacuous body reading a missing fact closes the
    // permission: none/every never manufacture a grant from it.
    for (const quantifier of ["none", "every"] as const) {
      const negative = base.$extends(
        permissions({
          actor,
          models: {
            folder: { read: { documents: { [quantifier]: alternatives } } },
          },
        })
      );
      expect(await negative.$as({}).folder.findMany()).toEqual([]);
    }
    const not = base.$extends(
      permissions({
        actor,
        models: {
          document: { read: { NOT: alternatives } },
        },
      })
    );
    expect(await not.$as({}).document.findMany()).toEqual([]);
    expect(
      await not
        .$as({ userId: "bob", ids: [] })
        .document.findMany({ select: { id: true } })
    ).toEqual([{ id: "private" }]);

    const related = base.$extends(
      permissions({
        actor,
        models: {
          document: {
            read: {
              folder: {
                is: {
                  OR: [
                    { id: "public" },
                    { $if: present("userId"), id: { actor: "userId" } },
                  ],
                },
              },
            },
          },
        },
      })
    );
    expect(
      await related.$as({}).document.findMany({ select: { id: true } })
    ).toEqual([{ id: "public" }]);
    const isNot = base.$extends(
      permissions({
        actor,
        models: {
          document: {
            read: {
              folder: {
                isNot: { OR: [{ id: "public" }, { id: { actor: "userId" } }] },
              },
            },
          },
        },
      })
    );
    expect(await isNot.$as({}).document.findMany()).toEqual([]);
  } finally {
    await base.$disconnect();
  }
});
