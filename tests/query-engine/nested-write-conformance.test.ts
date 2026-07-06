import { createClient, type VibORMClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

// The conformance oracle (DESIGN.md §11 M0): run identical nested-write
// scenarios through BOTH execution modes — the interactive-transaction engine
// and the atomic-batch engine — on PGlite and assert byte-identical persisted
// state. This is the acceptance oracle the engine-unification work is gated
// against, widened here from four FK-create scenarios to head-to-head coverage
// of every mutation kind (create/connect/connectOrCreate/disconnect/delete/
// deleteMany/update/updateMany/set/upsert, FK + M2M, plus the D4 non-PK
// overlay and a cross-step dependency probe).

// A batch-only PGlite driver: same database, but forced down the atomic-batch
// path (own writes are NOT observable mid-operation). The base PGlite driver
// exercises the interactive-transaction path.
class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

// A schema exercising a foreign key that references a NON-primary-key unique
// column of the parent. Updating that referenced column mid-operation while a
// child is created is the D4 divergence (map-oracle D4): the tx engine
// re-SELECTs the parent and threads the fresh value; the batch engine overlays
// only the primary key onto the pre-read record, so it must overlay every
// updated scalar column for the child FK to pick up the new value.
const nonPkReferenceSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      members: s.oneToMany(() => member),
    })
    .map("conformance_d4_orgs");

  const member = s
    .model({
      id: s.string().id(),
      orgCode: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgCode")
        .references("code")
        .optional(),
    })
    .map("conformance_d4_members");

  return { org, member };
})();

// A self-referential parent-holds-FK schema: `category.parent` is a manyToOne
// to the same model, its FK (`parentId`) sitting on the parent row. A nested
// `parent: { create }` inserts a SAME-MODEL child BEFORE the top-level row
// (before-parent FK split), so the top-level create's own row is not the first
// insert into the model — the review found LiveMode's old first-insert anchor
// returned the nested child. This group pins two-mode persisted-state parity for
// that tree class (the returned-record parity is pinned in the M3 gate).
const selfRefFkSchema = (() => {
  const category = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => category)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => category),
    })
    .map("conformance_selfref_categories");

  return { category };
})();

type SchemaClient<TSchema extends Schema> = VibORMClient<{
  schema: TSchema;
  driver: PGliteDriver;
}>;

type PersistedState = Record<string, unknown[]>;

// The observable result of running a scenario on one mode: whether the act
// rejected, plus the persisted state afterwards.
interface Outcome {
  rejected: boolean;
  state: PersistedState;
}

interface Scenario<TSchema extends Schema> {
  name: string;
  seed?: (client: SchemaClient<TSchema>) => PromiseLike<unknown>;
  act: (client: SchemaClient<TSchema>) => PromiseLike<unknown>;
  // If set, the act is expected to reject in both modes. State must still be
  // byte-identical across modes and equal to `expected` (rolled-back state).
  expectReject?: boolean;
  expected: PersistedState;
  // A DELIBERATE, DESIGN-SANCTIONED tx-vs-batch asymmetry (DESIGN.md §6.2.3):
  // a residual cross-step dependency the batch engine cannot resolve at plan
  // time surfaces as an abort where the transaction engine succeeds. When set,
  // each mode is asserted against its own declared outcome instead of against
  // byte-identical parity — the asymmetry is pinned as a contract.
  asymmetric?: {
    reason: string;
    transaction: { reject: boolean; state: PersistedState };
    batch: { reject: boolean; state: PersistedState };
  };
}

interface SchemaGroup<TSchema extends Schema> {
  schema: TSchema;
  // Dump every table in a stable order so tx-vs-batch state is comparable.
  dump: (client: SchemaClient<TSchema>) => Promise<PersistedState>;
  scenarios: Scenario<TSchema>[];
}

async function runScenario<TSchema extends Schema>(
  group: SchemaGroup<TSchema>,
  scenario: Scenario<TSchema>,
  createDriver: (db: PGlite) => PGliteDriver
): Promise<Outcome> {
  const db = new PGlite();
  const setupClient = createClient({
    schema: group.schema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(setupClient, { force: true });

  const client = createClient({
    schema: group.schema,
    driver: createDriver(db),
  });
  try {
    await scenario.seed?.(client);
    let rejected = false;
    try {
      await scenario.act(client);
    } catch {
      rejected = true;
    }
    return { rejected, state: await group.dump(client) };
  } finally {
    await client.$disconnect();
  }
}

function registerGroup<TSchema extends Schema>(
  title: string,
  group: SchemaGroup<TSchema>
): void {
  describe(title, () => {
    for (const scenario of group.scenarios) {
      // Each scenario boots two PGlite instances; well over the default 5s
      // timeout when the full suite runs in parallel.
      test(scenario.name, { timeout: 30_000 }, async () => {
        const transaction = await runScenario(
          group,
          scenario,
          (db) => new PGliteDriver({ client: db })
        );
        const batch = await runScenario(
          group,
          scenario,
          (db) => new BatchOnlyPGliteDriver({ client: db })
        );

        if (scenario.asymmetric) {
          // Pin the design-sanctioned divergence: each mode against its own
          // declared outcome. NOT byte-identical by construction.
          expect(transaction.rejected).toBe(
            scenario.asymmetric.transaction.reject
          );
          expect(transaction.state).toEqual(
            scenario.asymmetric.transaction.state
          );
          expect(batch.rejected).toBe(scenario.asymmetric.batch.reject);
          expect(batch.state).toEqual(scenario.asymmetric.batch.state);
          return;
        }

        // Both modes must agree on whether the act rejected.
        expect(batch.rejected).toBe(transaction.rejected);
        expect(transaction.rejected).toBe(scenario.expectReject === true);
        // The load-bearing oracle assertion: the two substrates persist
        // byte-identical state for the same scenario.
        expect(batch.state).toEqual(transaction.state);
        // Both must also match the intended end state (guards against both
        // engines being wrong the same way).
        expect(transaction.state).toEqual(scenario.expected);
        expect(batch.state).toEqual(scenario.expected);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Group 1: FK relations (nested-write behavior schema).
// user 1—* post (nullable FK), user 1—1 profile, post 1—* postTag *—1 tag.
// ---------------------------------------------------------------------------

type NestedWriteSchema = typeof nestedWriteBehaviorSchema;

async function dumpNestedWrite(
  client: SchemaClient<NestedWriteSchema>
): Promise<PersistedState> {
  const [users, posts, profiles, tags, postTags] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
    client.profile.findMany({ orderBy: { id: "asc" } }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
    client.postTag.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts, profiles, tags, postTags };
}

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
          postTags: { disconnect: { id: "j1" } },
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
// Group 3: many-to-many family (many-to-many schema).
// post *—* tag (junction config on post side), user *—* user (self-ref).
// ---------------------------------------------------------------------------

type ManyToManySchema = typeof manyToManySchema;

async function dumpManyToMany(
  client: SchemaClient<ManyToManySchema>
): Promise<PersistedState> {
  // Include tag membership per post so junction state is compared, not just
  // rows. Ordering is stabilized so tx-vs-batch dumps are byte-identical.
  const [posts, tags, categories] = await Promise.all([
    client.post.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
    client.category.findMany({
      orderBy: { id: "asc" },
      include: { posts: { orderBy: { id: "asc" } } },
    }),
  ]);
  return { posts, tags, categories };
}

const m2mBaselineSeed = async (client: SchemaClient<ManyToManySchema>) => {
  await client.post.create({ data: { id: "p1", title: "Post 1" } });
  await client.post.create({ data: { id: "p2", title: "Post 2" } });
  await client.tag.create({
    data: { id: "t1", name: "tag-1", featuredPostId: null },
  });
  await client.tag.create({
    data: { id: "t2", name: "tag-2", featuredPostId: null },
  });
  await client.tag.create({
    data: { id: "t3", name: "tag-3", featuredPostId: null },
  });
};

// The baseline m2m seed's tag rows, keyed by id. Scenarios extend or trim
// this via `m2mExpected`'s options so both the `tags` list and the per-post
// membership render the correct tag records.
const BASELINE_M2M_TAGS: Record<string, string> = {
  t1: "tag-1",
  t2: "tag-2",
  t3: "tag-3",
};

// Titles for scenario-created posts referenced in expected membership maps.
const M2M_POST_TITLES: Record<string, string> = {
  p3: "Post 3",
};

interface M2mExpectedOptions {
  // post id -> connected tag ids.
  membership?: Record<string, string[]>;
  // Tags present after the scenario (id -> name). Defaults to the baseline
  // three; override to add created tags or drop deleted ones.
  tags?: Record<string, string>;
}

// Build the expected many-to-many dump from a tag registry plus a
// post -> connected-tag-ids map, so tag names render identically in the
// `tags` list and in each post's included `tags`.
function m2mExpected(options: M2mExpectedOptions = {}): PersistedState {
  const tagNames = options.tags ?? BASELINE_M2M_TAGS;
  const membership = options.membership ?? {};

  const tagRecord = (id: string): Record<string, unknown> => ({
    id,
    name: tagNames[id] ?? id,
    featuredPostId: null,
  });

  const post = (id: string, title: string): Record<string, unknown> => ({
    id,
    title,
    tags: [...(membership[id] ?? [])].sort().map(tagRecord),
  });

  const posts: Record<string, unknown>[] = [
    post("p1", "Post 1"),
    post("p2", "Post 2"),
  ];
  // Any post referenced in membership beyond the two baseline posts is a
  // scenario-created post (e.g. create-through-junction).
  for (const postId of Object.keys(membership)) {
    if (postId === "p1" || postId === "p2") {
      continue;
    }
    posts.push(post(postId, M2M_POST_TITLES[postId] ?? postId));
  }
  posts.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const tags = Object.keys(tagNames).sort().map(tagRecord);

  return { posts, tags, categories: [] };
}

const m2mScenarios: Scenario<ManyToManySchema>[] = [
  {
    name: "m2m connect inserts junction rows and is idempotent",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      // Idempotent re-connect collapses to the same membership.
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t1", "t2"] } }),
  },
  {
    name: "m2m connect of a missing target rejects, membership unchanged",
    expectReject: true,
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "missing" } } },
      }),
    expected: m2mExpected(),
  },
  {
    name: "m2m create-through-junction on parent create connects and creates",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.create({
        data: {
          id: "p3",
          title: "Post 3",
          tags: {
            connect: { id: "t1" },
            create: { id: "t-new", name: "tag-new" },
          },
        },
      }),
    expected: m2mExpected({
      membership: { p3: ["t-new", "t1"] },
      tags: { ...BASELINE_M2M_TAGS, "t-new": "tag-new" },
    }),
  },
  {
    name: "m2m connectOrCreate connects existing and creates missing",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: [
              { where: { id: "t1" }, create: { id: "t1", name: "ignored" } },
              { where: { id: "t9" }, create: { id: "t9", name: "tag-9" } },
            ],
          },
        },
      }),
    expected: m2mExpected({
      membership: { p1: ["t1", "t9"] },
      tags: { ...BASELINE_M2M_TAGS, t9: "tag-9" },
    }),
  },
  {
    name: "m2m connectOrCreate dedupes duplicate targets to one association",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: [
              { where: { id: "t9" }, create: { id: "t9", name: "tag-9" } },
              { where: { id: "t9" }, create: { id: "t9", name: "tag-9b" } },
            ],
          },
        },
      }),
    expected: m2mExpected({
      membership: { p1: ["t9"] },
      tags: { ...BASELINE_M2M_TAGS, t9: "tag-9" },
    }),
  },
  {
    name: "m2m set replaces the association set and empties it",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { set: [{ id: "t2" }, { id: "t3" }] } },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t2", "t3"] } }),
  },
  {
    name: "m2m disconnect removes the association and keeps the row",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { disconnect: { id: "t1" } } },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t2"] } }),
  },
  {
    name: "m2m boolean disconnect is rejected, membership unchanged",
    expectReject: true,
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { disconnect: true as unknown as { id: string } } },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m delete removes the child row and all its associations",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await client.post.update({
        where: { id: "p2" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { delete: { id: "t1" } } },
      });
    },
    expected: m2mExpected({
      membership: { p1: ["t2"] },
      tags: { t2: "tag-2", t3: "tag-3" },
    }),
  },
  {
    name: "m2m delete of an unconnected record rejects, state unchanged",
    expectReject: true,
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: { tags: { delete: { id: "t1" } } },
      }),
    expected: m2mExpected(),
  },
  {
    name: "m2m deleteMany deletes only connected rows matching the filter",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      // Filter matches t1 (connected) and t3 (not connected); only t1 is
      // deleted. t3 survives.
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { deleteMany: { name: { in: ["tag-1", "tag-3"] } } } },
      });
    },
    expected: m2mExpected({
      membership: { p1: ["t2"] },
      tags: { t2: "tag-2", t3: "tag-3" },
    }),
  },
  {
    name: "m2m deleteMany true removes all connected rows",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { deleteMany: {} } },
      });
    },
    expected: m2mExpected({ tags: { t3: "tag-3" } }),
  },
  {
    name: "m2m connect combined with deleteMany in one update is rejected",
    expectReject: true,
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connect: { id: "t2" },
            deleteMany: { name: "tag-2" },
          },
        },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m nested update modifies only a connected record",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            update: { where: { id: "t1" }, data: { name: "tag-1-renamed" } },
          },
        },
      });
    },
    expected: m2mExpected({
      membership: { p1: ["t1"] },
      tags: { ...BASELINE_M2M_TAGS, t1: "tag-1-renamed" },
    }),
  },
  {
    name: "m2m nested update of an unconnected record rejects, state unchanged",
    expectReject: true,
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: { update: { where: { id: "t2" }, data: { name: "nope" } } },
        },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m nested upsert updates a connected record",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "never" },
              update: { name: "tag-1-upserted" },
            },
          },
        },
      });
    },
    expected: m2mExpected({
      membership: { p1: ["t1"] },
      tags: { ...BASELINE_M2M_TAGS, t1: "tag-1-upserted" },
    }),
  },
  {
    name: "m2m nested upsert creates and connects a missing record",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t9" },
              create: { id: "t9", name: "tag-9" },
              update: { name: "never" },
            },
          },
        },
      }),
    expected: m2mExpected({
      membership: { p1: ["t9"] },
      tags: { ...BASELINE_M2M_TAGS, t9: "tag-9" },
    }),
  },
  {
    name: "m2m nested upsert of an existing unconnected record rejects, state unchanged",
    expectReject: true,
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "never" },
              update: { name: "never" },
            },
          },
        },
      }),
    expected: m2mExpected(),
  },
];

// ---------------------------------------------------------------------------
// Group 4: self-referential many-to-many (own dump).
// ---------------------------------------------------------------------------

const selfRefM2mScenarios: Scenario<ManyToManySchema>[] = [
  {
    name: "self-referential m2m connect then disconnect",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Alice" } });
      await client.user.create({ data: { id: "u2", name: "Bob" } });
      await client.user.create({ data: { id: "u3", name: "Cara" } });
    },
    act: async (client) => {
      await client.user.update({
        where: { id: "u1" },
        data: { follows: { connect: [{ id: "u2" }, { id: "u3" }] } },
      });
      await client.user.update({
        where: { id: "u1" },
        data: { follows: { disconnect: { id: "u2" } } },
      });
    },
    expected: {
      follows: [{ userId: "u1", followsIds: ["u3"] }],
      followedBy: [{ userId: "u3", followedByIds: ["u1"] }],
    },
  },
];

async function dumpSelfRefM2m(
  client: SchemaClient<ManyToManySchema>
): Promise<PersistedState> {
  const users = await client.user.findMany({
    orderBy: { id: "asc" },
    include: {
      follows: { orderBy: { id: "asc" } },
      followedBy: { orderBy: { id: "asc" } },
    },
  });
  const follows: unknown[] = [];
  const followedBy: unknown[] = [];
  for (const user of users as {
    id: string;
    follows?: { id: string }[];
    followedBy?: { id: string }[];
  }[]) {
    const followsIds = (user.follows ?? []).map((u) => u.id).sort();
    const followedByIds = (user.followedBy ?? []).map((u) => u.id).sort();
    if (followsIds.length > 0) {
      follows.push({ userId: user.id, followsIds });
    }
    if (followedByIds.length > 0) {
      followedBy.push({ userId: user.id, followedByIds });
    }
  }
  return { follows, followedBy };
}

// ---------------------------------------------------------------------------
// Group 5: D4 — non-PK reference column changed mid-update.
// The child FK references org.code (unique, non-PK). Updating org.code while
// creating a member must thread the NEW code to the child in both modes.
// ---------------------------------------------------------------------------

type NonPkReferenceSchema = typeof nonPkReferenceSchema;

async function dumpNonPkReference(
  client: SchemaClient<NonPkReferenceSchema>
): Promise<PersistedState> {
  const [orgs, members] = await Promise.all([
    client.org.findMany({ orderBy: { id: "asc" } }),
    client.member.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { orgs, members };
}

const nonPkReferenceScenarios: Scenario<NonPkReferenceSchema>[] = [
  {
    name: "D4: updating the referenced non-PK column threads the new value to a nested create",
    seed: (client) => client.org.create({ data: { id: "org-1", code: "OLD" } }),
    act: (client) =>
      client.org.update({
        where: { id: "org-1" },
        data: {
          code: "NEW",
          members: { create: { id: "m1" } },
        },
      }),
    expected: {
      orgs: [{ id: "org-1", code: "NEW" }],
      members: [{ id: "m1", orgCode: "NEW" }],
    },
  },
];

// ---------------------------------------------------------------------------
// Group 5b: self-referential parent-holds-FK create. A nested `parent: { create }`
// inserts a same-model child before the top-level row; both modes must persist
// identical state (both rows, the parent's FK pointing at the child).
// ---------------------------------------------------------------------------

type SelfRefFkSchema = typeof selfRefFkSchema;

async function dumpSelfRefFk(
  client: SchemaClient<SelfRefFkSchema>
): Promise<PersistedState> {
  const categories = await client.category.findMany({ orderBy: { id: "asc" } });
  return { categories };
}

const selfRefFkScenarios: Scenario<SelfRefFkSchema>[] = [
  {
    name: "self-referential parent-holds-FK create persists both rows in both modes",
    act: (client) =>
      client.category.create({
        data: {
          id: "root",
          name: "Root",
          parent: { create: { id: "gp", name: "Grandparent" } },
        },
      }),
    expected: {
      categories: [
        { id: "gp", name: "Grandparent", parentId: null },
        { id: "root", name: "Root", parentId: "gp" },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Group 6: cross-step dependency (DESIGN.md §6.2.3). Within one relation, a
// create and a connectOrCreate for the SAME key across two steps.
//
// This is a DESIGN-SANCTIONED tx-vs-batch ASYMMETRY, pinned here so it is a
// contract rather than an accident. The transaction engine executes the
// create, then the connectOrCreate's probe observes the just-created row
// (own writes visible) and connects it — success. The batch engine resolves
// the connectOrCreate's "missing?" probe at plan time against committed
// state, which does not yet contain the create's own write, plans the create
// branch, and the second INSERT (or its guard) aborts the atomic unit — a
// fail-closed rejection, never a silent wrong branch. §6.2.3 states this
// residual cross-step dependency surfaces as an abort on planned mode where
// live mode succeeds.
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
    name: "cross-step: create then connectOrCreate the same key (design-sanctioned tx-vs-batch asymmetry)",
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
    // Unused (asymmetric path) but required by the Scenario shape; kept as the
    // transaction (live) end state for documentation.
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [{ id: "po-shared", title: "Created first", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
    asymmetric: {
      reason:
        "§6.2.3 residual cross-step dependency: live observes its own write and connects; planned resolves the probe against committed state and fails closed.",
      transaction: {
        reject: false,
        state: {
          users: [{ id: "u1", name: "Owner" }],
          posts: [{ id: "po-shared", title: "Created first", userId: "u1" }],
          profiles: [],
          tags: [],
          postTags: [],
        },
      },
      batch: { reject: true, state: CROSS_STEP_EMPTY },
    },
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

registerGroup("nested-write conformance: many-to-many (tx vs batch)", {
  schema: manyToManySchema,
  dump: dumpManyToMany,
  scenarios: m2mScenarios,
});

registerGroup("nested-write conformance: self-referential m2m (tx vs batch)", {
  schema: manyToManySchema,
  dump: dumpSelfRefM2m,
  scenarios: selfRefM2mScenarios,
});

registerGroup("nested-write conformance: D4 non-PK reference (tx vs batch)", {
  schema: nonPkReferenceSchema,
  dump: dumpNonPkReference,
  scenarios: nonPkReferenceScenarios,
});

registerGroup("nested-write conformance: self-referential FK (tx vs batch)", {
  schema: selfRefFkSchema,
  dump: dumpSelfRefFk,
  scenarios: selfRefFkScenarios,
});

registerGroup("nested-write conformance: cross-step dependency (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: crossStepScenarios,
});
