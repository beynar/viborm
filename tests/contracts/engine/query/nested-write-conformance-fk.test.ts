// Nested-write conformance: foreign-key relation slice.
//
// Every group here runs on `nestedWriteBehaviorSchema`. Split out of the
// original single-file oracle so one process boots fewer PGlite databases; the
// shared two-substrate harness lives in `nested-write-conformance-fixtures`.

import {
  dumpNestedWrite,
  type NestedWriteSchema,
  type PersistedState,
  registerGroup,
  type Scenario,
  type SchemaClient,
} from "@tests/contracts/engine/query/nested-write-conformance-fixtures";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";

// ---------------------------------------------------------------------------
// Group 1: FK relations (nested-write behavior schema).
// user 1—* post (nullable FK), user 1—1 profile, post 1—* postTag *—1 tag.
// ---------------------------------------------------------------------------

const fkScenarios: Scenario<NestedWriteSchema>[] = [
  {
    name: "create derives to-one and to-many foreign keys (mixed directions)",
    act: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Alice",
          profile: { create: { id: "pr1", bio: "bio" } },
          posts: {
            createMany: {
              data: [
                { id: "po1", title: "First" },
                { id: "po2", title: "Second" },
              ],
            },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Alice" }],
      posts: [
        { id: "po1", title: "First", userId: "u1" },
        { id: "po2", title: "Second", userId: "u1" },
      ],
      profiles: [{ id: "pr1", bio: "bio", userId: "u1" }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "createMany duplicate PK rolls back parent and prior children",
    expectReject: true,
    act: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Kate",
          posts: {
            createMany: {
              data: [
                { id: "dup", title: "First" },
                { id: "dup", title: "Duplicate" },
              ],
            },
          },
        },
      }),
    expected: { users: [], posts: [], profiles: [], tags: [], postTags: [] },
  },
  {
    name: "connect (child-holds-FK to-many) links an existing child",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Bob" } });
      await client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { posts: { connect: { id: "po1" } } },
      }),
    expected: {
      users: [{ id: "u1", name: "Bob" }],
      posts: [{ id: "po1", title: "Orphan", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "connect (parent-holds-FK) of a missing target leaves state unchanged",
    expectReject: true,
    seed: (client) =>
      client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: { author: { connect: { id: "missing" } } },
      }),
    expected: {
      users: [],
      posts: [{ id: "po1", title: "Orphan", userId: null }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "parent-holds-FK scalar rebind targets the final related row",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Original" } });
      await client.user.create({ data: { id: "u2", name: "Final" } });
      await client.post.create({
        data: { id: "po1", title: "Rebound", userId: "u1" },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          userId: "u2",
          author: { update: { name: "Updated final" } },
        },
      }),
    expected: {
      users: [
        { id: "u1", name: "Original" },
        { id: "u2", name: "Updated final" },
      ],
      posts: [{ id: "po1", title: "Rebound", userId: "u2" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "connectOrCreate connects an existing target (parent holds FK)",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Existing" } });
      await client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          author: {
            connectOrCreate: {
              where: { id: "u1" },
              create: { id: "u1", name: "Should not create" },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Existing" }],
      posts: [{ id: "po1", title: "Orphan", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "connectOrCreate creates a missing target (parent holds FK)",
    seed: (client) =>
      client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          author: {
            connectOrCreate: {
              where: { id: "u1" },
              create: { id: "u1", name: "Created" },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Created" }],
      posts: [{ id: "po1", title: "Orphan", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "connectOrCreate dedupes repeated targets (first-create-wins)",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Owner" } }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            connectOrCreate: [
              {
                where: { id: "po1" },
                create: { id: "po1", title: "First wins" },
              },
              {
                where: { id: "po1" },
                create: { id: "po1", title: "Ignored" },
              },
            ],
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [{ id: "po1", title: "First wins", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "disconnect true (child holds FK) nulls the FK",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Dora",
          posts: { create: { id: "po1", title: "Child" } },
        },
      }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { posts: { disconnect: { id: "po1" } } },
      }),
    expected: {
      users: [{ id: "u1", name: "Dora" }],
      posts: [{ id: "po1", title: "Child", userId: null }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "disconnect non-nullable FK (m2m join) rejects atomically, state unchanged",
    expectReject: true,
    seed: async (client) => {
      await client.tag.create({ data: { id: "t1", name: "required" } });
      await client.post.create({
        data: {
          id: "po1",
          title: "Required join",
          userId: null,
          postTags: {
            create: { id: "j1", tag: { connect: { id: "t1" } } },
          },
        },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          title: "Changed",
          postTags: {
            // @ts-expect-error - required child membership cannot disconnect
            disconnect: { id: "j1" },
          },
        },
      }),
    expected: {
      users: [],
      posts: [{ id: "po1", title: "Required join", userId: null }],
      profiles: [],
      tags: [{ id: "t1", name: "required" }],
      postTags: [{ id: "j1", postId: "po1", tagId: "t1" }],
    },
  },
  {
    name: "delete and deleteMany keep child mutations parent-correlated",
    seed: async (client) => {
      await client.user.create({
        data: {
          id: "u1",
          name: "Hana",
          posts: {
            create: [
              { id: "po1", title: "Remove one" },
              { id: "po2", title: "Remove many" },
            ],
          },
        },
      });
      await client.user.create({
        data: {
          id: "u2",
          name: "Ivan",
          posts: { create: { id: "po3", title: "Remove many" } },
        },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            delete: { id: "po1" },
            deleteMany: { title: "Remove many" },
          },
        },
      }),
    expected: {
      users: [
        { id: "u1", name: "Hana" },
        { id: "u2", name: "Ivan" },
      ],
      posts: [{ id: "po3", title: "Remove many", userId: "u2" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "delete of another parent's child rejects, state unchanged",
    expectReject: true,
    seed: async (client) => {
      await client.user.create({
        data: {
          id: "u1",
          name: "Owner",
          posts: { create: { id: "po1", title: "Owner post" } },
        },
      });
      await client.user.create({
        data: {
          id: "u2",
          name: "Other",
          posts: { create: { id: "po2", title: "Other post" } },
        },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { posts: { delete: { id: "po2" } } },
      }),
    expected: {
      users: [
        { id: "u1", name: "Owner" },
        { id: "u2", name: "Other" },
      ],
      posts: [
        { id: "po1", title: "Owner post", userId: "u1" },
        { id: "po2", title: "Other post", userId: "u2" },
      ],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "update child and updateMany stay parent-correlated",
    seed: async (client) => {
      await client.user.create({
        data: {
          id: "u1",
          name: "Faye",
          posts: {
            create: [
              { id: "po1", title: "Draft" },
              { id: "po2", title: "Queued" },
            ],
          },
        },
      });
      await client.user.create({
        data: {
          id: "u2",
          name: "Gus",
          posts: { create: { id: "po3", title: "Queued" } },
        },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            update: {
              where: { id: "po1" },
              data: { title: "Updated one" },
            },
            updateMany: {
              where: { title: "Queued" },
              data: { title: "Updated many" },
            },
          },
        },
      }),
    expected: {
      users: [
        { id: "u1", name: "Faye" },
        { id: "u2", name: "Gus" },
      ],
      posts: [
        { id: "po1", title: "Updated one", userId: "u1" },
        { id: "po2", title: "Updated many", userId: "u1" },
        { id: "po3", title: "Queued", userId: "u2" },
      ],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "update to another parent's child (updateMany-correlated) rejects, state unchanged",
    expectReject: true,
    seed: async (client) => {
      await client.user.create({
        data: {
          id: "u1",
          name: "Lina",
          posts: { create: { id: "po1", title: "Owner" } },
        },
      });
      await client.user.create({
        data: {
          id: "u2",
          name: "Milo",
          posts: { create: { id: "po2", title: "Other" } },
        },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          name: "Changed",
          posts: {
            update: { where: { id: "po2" }, data: { title: "Stolen" } },
          },
        },
      }),
    expected: {
      users: [
        { id: "u1", name: "Lina" },
        { id: "u2", name: "Milo" },
      ],
      posts: [
        { id: "po1", title: "Owner", userId: "u1" },
        { id: "po2", title: "Other", userId: "u2" },
      ],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "set (nullable FK) disconnects departing and connects added children",
    seed: async (client) => {
      await client.user.create({
        data: {
          id: "u1",
          name: "Nia",
          posts: {
            create: [
              { id: "po-kept", title: "Kept" },
              { id: "po-dropped", title: "Dropped" },
            ],
          },
        },
      });
      await client.post.create({
        data: { id: "po-added", title: "Added", userId: null },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          posts: { set: [{ id: "po-kept" }, { id: "po-added" }] },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Nia" }],
      posts: [
        { id: "po-added", title: "Added", userId: "u1" },
        { id: "po-dropped", title: "Dropped", userId: null },
        { id: "po-kept", title: "Kept", userId: "u1" },
      ],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "set keeping the only required-FK child is a no-op and succeeds",
    seed: async (client) => {
      await client.tag.create({ data: { id: "t1", name: "keep" } });
      await client.post.create({
        data: {
          id: "po1",
          title: "Set no-op",
          userId: null,
          postTags: { create: { id: "j1", tag: { connect: { id: "t1" } } } },
        },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: { postTags: { set: [{ id: "j1" }] } },
      }),
    expected: {
      users: [],
      posts: [{ id: "po1", title: "Set no-op", userId: null }],
      profiles: [],
      tags: [{ id: "t1", name: "keep" }],
      postTags: [{ id: "j1", postId: "po1", tagId: "t1" }],
    },
  },
  {
    name: "set orphaning a required-FK child rejects, state unchanged",
    expectReject: true,
    seed: async (client) => {
      await client.tag.create({ data: { id: "t1", name: "keep" } });
      await client.tag.create({ data: { id: "t2", name: "orphan" } });
      await client.post.create({
        data: {
          id: "po1",
          title: "Set orphan",
          userId: null,
          postTags: {
            create: [
              { id: "j-keep", tag: { connect: { id: "t1" } } },
              { id: "j-orphan", tag: { connect: { id: "t2" } } },
            ],
          },
        },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          title: "Changed",
          postTags: { set: [{ id: "j-keep" }] },
        },
      }),
    expected: {
      users: [],
      posts: [{ id: "po1", title: "Set orphan", userId: null }],
      profiles: [],
      tags: [
        { id: "t1", name: "keep" },
        { id: "t2", name: "orphan" },
      ],
      postTags: [
        { id: "j-keep", postId: "po1", tagId: "t1" },
        { id: "j-orphan", postId: "po1", tagId: "t2" },
      ],
    },
  },
  {
    name: "to-many upsert creates then updates the current parent's child",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Jules" } }),
    act: async (client) => {
      await client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            upsert: {
              where: { id: "po1" },
              create: { id: "po1", title: "Created" },
              update: { title: "Unused" },
            },
          },
        },
      });
      await client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            upsert: {
              where: { id: "po1" },
              create: { id: "po-unused", title: "Should not create" },
              update: { title: "Updated" },
            },
          },
        },
      });
    },
    expected: {
      users: [{ id: "u1", name: "Jules" }],
      posts: [{ id: "po1", title: "Updated", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one upsert creates then updates the current target",
    seed: (client) =>
      client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      }),
    act: async (client) => {
      await client.post.update({
        where: { id: "po1" },
        data: {
          author: {
            upsert: {
              create: { id: "u1", name: "Created" },
              update: { name: "Unused" },
            },
          },
        },
      });
      await client.post.update({
        where: { id: "po1" },
        data: {
          author: {
            upsert: {
              create: { id: "u-unused", name: "Should not create" },
              update: { name: "Updated" },
            },
          },
        },
      });
    },
    expected: {
      users: [{ id: "u1", name: "Updated" }],
      posts: [{ id: "po1", title: "Orphan", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-many upsert cannot target another parent's existing child, state unchanged",
    expectReject: true,
    seed: async (client) => {
      await client.user.create({
        data: {
          id: "u1",
          name: "Owner",
          posts: { create: { id: "po1", title: "Owned" } },
        },
      });
      await client.user.create({ data: { id: "u2", name: "Intruder" } });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u2" },
        data: {
          posts: {
            upsert: {
              where: { id: "po1" },
              create: { id: "po1", title: "Should not create" },
              update: { title: "Stolen" },
            },
          },
        },
      }),
    expected: {
      users: [
        { id: "u1", name: "Owner" },
        { id: "u2", name: "Intruder" },
      ],
      posts: [{ id: "po1", title: "Owned", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "top-level upsert create then update branch",
    act: async (client) => {
      await client.user.upsert({
        where: { id: "u1" },
        create: { id: "u1", name: "Created" },
        update: { name: "Unused" },
      });
      await client.user.upsert({
        where: { id: "u1" },
        create: { id: "u1", name: "Should not create" },
        update: { name: "Updated" },
      });
    },
    expected: {
      users: [{ id: "u1", name: "Updated" }],
      posts: [],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "top-level upsert targetWhere no-match skips the update branch",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Alice",
          posts: { create: { id: "po1", title: "Draft" } },
        },
      }),
    act: (client) =>
      client.user.upsert({
        where: { id: "u1" },
        targetWhere: { name: "Bob" },
        create: { id: "u-unused", name: "Unused" },
        update: {
          name: "Wrong target",
          posts: {
            update: { where: { id: "po1" }, data: { title: "Wrong target" } },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Alice" }],
      posts: [{ id: "po1", title: "Draft", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "top-level upsert setWhere no-match skips the update branch",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Alice",
          posts: { create: { id: "po1", title: "Draft" } },
        },
      }),
    act: (client) =>
      client.user.upsert({
        where: { id: "u1" },
        setWhere: { name: "Bob" },
        create: { id: "u-unused", name: "Unused" },
        update: {
          name: "Wrong set",
          posts: {
            update: { where: { id: "po1" }, data: { title: "Wrong set" } },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Alice" }],
      posts: [{ id: "po1", title: "Draft", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "top-level upsert targetWhere+setWhere match runs the update branch",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Alice",
          posts: { create: { id: "po1", title: "Draft" } },
        },
      }),
    act: (client) =>
      client.user.upsert({
        where: { id: "u1" },
        targetWhere: { name: "Alice" },
        setWhere: { name: "Alice" },
        create: { id: "u-unused", name: "Unused" },
        update: {
          name: "Updated",
          posts: {
            update: { where: { id: "po1" }, data: { title: "Published" } },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Updated" }],
      posts: [{ id: "po1", title: "Published", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "connectOrCreate create branch accepts recursive nested writes",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Recursive" } });
      await client.tag.create({ data: { id: "t1", name: "recursive" } });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: "po1" },
              create: {
                id: "po1",
                title: "Recursive child",
                postTags: {
                  create: { id: "j1", tag: { connect: { id: "t1" } } },
                },
              },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Recursive" }],
      posts: [{ id: "po1", title: "Recursive child", userId: "u1" }],
      profiles: [],
      tags: [{ id: "t1", name: "recursive" }],
      postTags: [{ id: "j1", postId: "po1", tagId: "t1" }],
    },
  },
  {
    name: "unsupported nested create key rejects before any mutation",
    expectReject: true,
    act: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Invalid",
          posts: {
            // @ts-expect-error create inputs reject update-only nested keys.
            deleteMany: { title: "Nope" },
          },
        },
      }),
    expected: { users: [], posts: [], profiles: [], tags: [], postTags: [] },
  },
];

// ---------------------------------------------------------------------------
// Group 2: mapped-column FK propagation (own dump so raw column names are
// checked for parity).
// ---------------------------------------------------------------------------

const mappedScenarios: Scenario<NestedWriteSchema>[] = [
  {
    name: "mapped createMany + connect derive mapped foreign keys",
    seed: (client) =>
      client.mappedPost.create({
        data: { id: "mp-existing", title: "Existing", authorId: null },
      }),
    act: (client) =>
      client.mappedUser.create({
        data: {
          id: "mu1",
          name: "Mapped Many",
          posts: {
            createMany: {
              data: [
                { id: "mp1", title: "First" },
                { id: "mp2", title: "Second" },
              ],
            },
            connect: { id: "mp-existing" },
          },
        },
      }),
    expected: {
      mappedUsers: [{ id: "mu1", name: "Mapped Many" }],
      mappedPosts: [
        { id: "mp-existing", title: "Existing", authorId: "mu1" },
        { id: "mp1", title: "First", authorId: "mu1" },
        { id: "mp2", title: "Second", authorId: "mu1" },
      ],
    },
  },
];

async function dumpMapped(
  client: SchemaClient<NestedWriteSchema>
): Promise<PersistedState> {
  const [mappedUsers, mappedPosts] = await Promise.all([
    client.mappedUser.findMany({ orderBy: { id: "asc" } }),
    client.mappedPost.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { mappedUsers, mappedPosts };
}

// ---------------------------------------------------------------------------
// Group 8: cross-step dependency. Within one relation, a create and a
// connectOrCreate for the SAME key across two steps are rejected uniformly
// before either mode writes. Planned mode cannot observe the earlier create
// while resolving the later branch, so accepting the shape would make the
// public result substrate-dependent.
// ---------------------------------------------------------------------------

const CROSS_STEP_EMPTY: PersistedState = {
  users: [{ id: "u1", name: "Owner" }],
  posts: [],
  profiles: [],
  tags: [],
  postTags: [],
};

const crossStepScenarios: Scenario<NestedWriteSchema>[] = [
  {
    // RETARGETED by N6-U3: rejects, writes nothing, and the guard is now the one that
    // owns the invariant. `connectOrCreate` is a stage-1 named reader — it must read to
    // choose its arm — so it is ordered before the stage-3 `create`. Its probe finds
    // nothing, it takes its create arm, and the sibling `create` then inserts the same
    // key: the unique constraint refuses, exactly as N2-U1 chose for the occupied 1:1
    // slot. Adding a preflight check for a key the database already guards would be a
    // second guard on one invariant (the AGENTS.md ban).
    name: "cross-step: create then connectOrCreate the same key hits the unique constraint",
    expectedError: "Unique constraint violation",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Owner" } }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            create: { id: "po-shared", title: "Created first" },
            connectOrCreate: {
              where: { id: "po-shared" },
              create: { id: "po-shared", title: "Should not create" },
            },
          },
        },
      }),
    expectReject: true,
    expected: CROSS_STEP_EMPTY,
  },
];

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

registerGroup("nested-write conformance: FK relations (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: fkScenarios,
});

registerGroup("nested-write conformance: mapped-column FKs (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpMapped,
  scenarios: mappedScenarios,
});

registerGroup("nested-write conformance: cross-step dependency (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: crossStepScenarios,
});
