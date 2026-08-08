import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient, type VibORMClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { manyToManySchema } from "@tests/fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";

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
// insert into the model — the review found transaction strategy's old first-insert anchor
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

// T3c — the two create-root parent-held-FK declines V1 accepts-and-executes and V2
// deferred at T1 (outside the pre-T3c conformance census): a to-one `connect` by a
// NON-REFERENCED unique (the FK references `id`, the connect names `email`; V1 resolves
// it through a lookup subquery), and a SHARED-PRIMARY-KEY parent-held edge (the record's
// PK IS its FK, supplied by the fold, not scalar data). `crd_profile.userId` is both the
// PK and the FK to `crd_user.id`; `crd_note.userId` references `crd_user.id` but is
// connected by the non-referenced `email`.
const createRootFkDeclineSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      profile: s.oneToOne(() => profile).optional(),
      notes: s.oneToMany(() => note),
    })
    .map("conformance_crd_users");

  const profile = s
    .model({
      userId: s.string().id(),
      bio: s.string(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("conformance_crd_profiles");

  const note = s
    .model({
      id: s.string().id(),
      text: s.string(),
      userId: s.string().nullable(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
    })
    .map("conformance_crd_notes");

  return { user, profile, note };
})();

const createRootDependencySchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
      links: s
        .manyToMany(() => node)
        .A("sourceId")
        .B("targetId"),
      linkedBy: s.manyToMany(() => node),
    })
    .map("conformance_create_root_nodes");

  return { node };
})();

const membershipDependencySchema = (() => {
  const container = s
    .model({
      id: s.int().id(),
      nodes: s.oneToMany(() => node),
    })
    .map("conformance_membership_containers");

  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      containerId: s.int().nullable(),
      container: s
        .manyToOne(() => container)
        .fields("containerId")
        .references("id")
        .onUpdate("cascade")
        .optional(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .name("parent")
        .optional(),
      children: s.oneToMany(() => node).name("parent"),
      partnerId: s.int().unique().nullable(),
      partner: s
        .oneToOne(() => node)
        .fields("partnerId")
        .references("id")
        .name("partner")
        .optional(),
      partnerOf: s
        .oneToOne(() => node)
        .name("partner")
        .optional(),
    })
    .map("conformance_membership_nodes");

  return { container, node };
})();

const numericDependencySchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string(),
      items: s.oneToMany(() => item),
      profile: s.oneToOne(() => profile).optional(),
    })
    .map("conformance_dependency_owners");

  const item = s
    .model({
      id: s.int().id(),
      label: s.string(),
      ownerId: s.int().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("conformance_dependency_items");

  const profile = s
    .model({
      id: s.int().id(),
      bio: s.string(),
      ownerId: s.int().unique().nullable(),
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("conformance_dependency_profiles");

  return { owner, item, profile };
})();

const crossRelationTargetSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.oneToMany(() => record).name("primary"),
      secondaryRecords: s.oneToMany(() => record).name("secondary"),
    })
    .map("conformance_cross_target_accounts");

  const record = s
    .model({
      id: s.int().id(),
      primaryId: s.int().nullable(),
      secondaryId: s.int().nullable(),
      primary: s
        .manyToOne(() => account)
        .fields("primaryId")
        .references("id")
        .name("primary")
        .optional(),
      secondary: s
        .manyToOne(() => account)
        .fields("secondaryId")
        .references("id")
        .name("secondary")
        .optional(),
    })
    .map("conformance_cross_target_records");

  return { account, record };
})();

const transitiveTargetDependencySchema = (() => {
  const workspace = s
    .model({
      id: s.int().id(),
      projects: s.manyToMany(() => project).name("workspaceProjects"),
      tags: s.manyToMany(() => tag).name("workspaceTags"),
    })
    .map("conformance_transitive_workspaces");

  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.manyToMany(() => workspace).name("workspaceProjects"),
      tags: s.manyToMany(() => tag).name("projectTags"),
      components: s.manyToMany(() => component).name("projectComponents"),
    })
    .map("conformance_transitive_projects");

  const tag = s
    .model({
      id: s.int().id(),
      workspaces: s.manyToMany(() => workspace).name("workspaceTags"),
      projects: s.manyToMany(() => project).name("projectTags"),
      components: s.manyToMany(() => component).name("componentTags"),
    })
    .map("conformance_transitive_tags");

  const component = s
    .model({
      id: s.int().id(),
      projects: s.manyToMany(() => project).name("projectComponents"),
      tags: s.manyToMany(() => tag).name("componentTags"),
    })
    .map("conformance_transitive_components");

  return { workspace, project, tag, component };
})();

const transitiveCreateManySchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      cohorts: s.oneToMany(() => cohort),
      selectedItems: s.manyToMany(() => item).name("selectedItems"),
    })
    .map("conformance_transitive_create_many_owners");

  const item = s
    .model({
      id: s.int().id(),
      groupId: s.int().nullable(),
      creator: s
        .manyToOne(() => cohort)
        .fields("groupId")
        .references("id")
        .name("createdItems")
        .optional(),
      selectedBy: s.manyToMany(() => owner).name("selectedItems"),
    })
    .map("conformance_transitive_create_many_items");

  const cohort = s
    .model({
      id: s.int().id(),
      ownerId: s.int().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      createdItems: s.oneToMany(() => item).name("createdItems"),
    })
    .map("conformance_transitive_create_many_groups");

  return { owner, cohort, item };
})();

const transitivePredicateDependencySchema = (() => {
  const workspace = s
    .model({
      id: s.int().id(),
      projects: s.manyToMany(() => project).name("predicateProjects"),
      tags: s.manyToMany(() => tag).name("predicateWorkspaceTags"),
    })
    .map("conformance_transitive_predicate_workspaces");

  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.manyToMany(() => workspace).name("predicateProjects"),
      tags: s.manyToMany(() => tag).name("predicateProjectTags"),
    })
    .map("conformance_transitive_predicate_projects");

  const tag = s
    .model({
      id: s.int().id(),
      label: s.string(),
      workspaces: s.manyToMany(() => workspace).name("predicateWorkspaceTags"),
      projects: s.manyToMany(() => project).name("predicateProjectTags"),
    })
    .map("conformance_transitive_predicate_tags");

  return { workspace, project, tag };
})();

const transitiveMembershipDependencySchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .name("membershipParent")
        .optional(),
      children: s.oneToMany(() => node).name("membershipParent"),
      friends: s
        .manyToMany(() => node)
        .name("membershipFriends")
        .A("friendSourceId")
        .B("friendTargetId"),
      friendedBy: s.manyToMany(() => node).name("membershipFriends"),
      allies: s
        .manyToMany(() => node)
        .name("membershipAllies")
        .A("allySourceId")
        .B("allyTargetId"),
      alliedBy: s.manyToMany(() => node).name("membershipAllies"),
    })
    .map("conformance_transitive_membership_nodes");

  return { node };
})();

type SchemaClient<TSchema extends Schema> = VibORMClient<{
  schema: TSchema;
  driver: PGliteDriver;
}>;

type PersistedState = Record<string, unknown[]>;

// The observable result of running a scenario on one mode: whether the act
// rejected, plus the persisted state afterwards.
interface ErrorOutcome {
  name: string;
  code?: string | number;
  message: string;
}

interface Outcome {
  rejected: boolean;
  error?: ErrorOutcome;
  state: PersistedState;
}

interface Scenario<TSchema extends Schema> {
  name: string;
  seed?: (client: SchemaClient<TSchema>) => PromiseLike<unknown>;
  act: (client: SchemaClient<TSchema>) => PromiseLike<unknown>;
  // If set, the act is expected to reject in both modes. State must still be
  // byte-identical across modes and equal to `expected` (rolled-back state).
  expectReject?: boolean;
  expectedError?: string;
  expected: PersistedState;
}

interface SchemaGroup<TSchema extends Schema> {
  schema: TSchema;
  // Dump every table in a stable order so tx-vs-batch state is comparable.
  dump: (client: SchemaClient<TSchema>) => Promise<PersistedState>;
  scenarios: Scenario<TSchema>[];
}

function normalizeErrorOutcome(error: unknown): ErrorOutcome {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? error.code : undefined;
  const stableCode =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stableCode === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stableCode, message: error.message };
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
    // Seed stays OUTSIDE the act try/catch (a seed failure is a test error, not a
    // scenario reject).
    await scenario.seed?.(client);
    let rejected = false;
    let errorOutcome: ErrorOutcome | undefined;
    try {
      await scenario.act(client);
    } catch (error) {
      rejected = true;
      errorOutcome = normalizeErrorOutcome(error);
    }
    return {
      rejected,
      error: errorOutcome,
      state: await group.dump(client),
    };
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

        // Both modes must agree on whether the act rejected.
        expect(batch.rejected).toBe(transaction.rejected);
        expect(transaction.rejected).toBe(scenario.expectReject === true);
        // Every rejected scenario must expose the same stable error contract.
        // `expectedError` below is only an additional semantic substring pin.
        expect(batch.error).toEqual(transaction.error);
        if (scenario.expectedError) {
          expect(transaction.error?.message).toContain(scenario.expectedError);
        }
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
// Group 1b: to-one relation ops in update context, both FK directions.
// post.author is the FK-holder side (the FK lives on the row being updated:
// post.userId); user.profile is the inverse side (the FK lives on the related
// row: profile.userId). These validated inputs previously had no head-to-head
// execution coverage. Semantics per DESIGN.md §9 (update / disconnect / delete
// rows) and §5.3 (`disconnect: true` / `delete: true` are lax — a missing
// related row is a no-op, never an error).
// ---------------------------------------------------------------------------

const toOneScenarios: Scenario<NestedWriteSchema>[] = [
  {
    name: "to-one update (FK-holder side) updates the connected author",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Before",
          posts: { create: { id: "po1", title: "Post" } },
        },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: { author: { update: { name: "After" } } },
      }),
    expected: {
      users: [{ id: "u1", name: "After" }],
      posts: [{ id: "po1", title: "Post", userId: "u1" }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one update (FK-holder side) with nothing connected rejects, state unchanged",
    expectReject: true,
    seed: (client) =>
      client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          title: "Changed",
          author: { update: { name: "Nobody" } },
        },
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
    name: "to-one disconnect true (FK-holder side) nulls the FK, both rows survive",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Owner",
          posts: { create: { id: "po1", title: "Linked" } },
        },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: { author: { disconnect: true } },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [{ id: "po1", title: "Linked", userId: null }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one disconnect true (FK-holder side) with nothing connected is a no-op",
    seed: (client) =>
      client.post.create({
        data: { id: "po1", title: "Orphan", userId: null },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: {
          title: "Touched",
          author: { disconnect: true },
        },
      }),
    expected: {
      users: [],
      posts: [{ id: "po1", title: "Touched", userId: null }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one delete true (FK-holder side) nulls the FK then deletes the target",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Doomed",
          posts: { create: { id: "po1", title: "Survivor" } },
        },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "po1" },
        data: { author: { delete: true } },
      }),
    expected: {
      users: [],
      posts: [{ id: "po1", title: "Survivor", userId: null }],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one connect (inverse side) sets the FK on the related row",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Owner" } });
      await client.profile.create({
        data: { id: "pr1", bio: "orphan", userId: null },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { profile: { connect: { id: "pr1" } } },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [{ id: "pr1", bio: "orphan", userId: "u1" }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one connectOrCreate (inverse side) connects an existing profile",
    seed: async (client) => {
      await client.user.create({ data: { id: "u1", name: "Owner" } });
      await client.profile.create({
        data: { id: "pr1", bio: "existing", userId: null },
      });
    },
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            connectOrCreate: {
              where: { id: "pr1" },
              create: { id: "pr1", bio: "should not create" },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [{ id: "pr1", bio: "existing", userId: "u1" }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one connectOrCreate (inverse side) creates a missing profile",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Owner" } }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            connectOrCreate: {
              where: { id: "pr1" },
              create: { id: "pr1", bio: "created" },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [{ id: "pr1", bio: "created", userId: "u1" }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one update (inverse side) updates the connected profile",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Owner",
          profile: { create: { id: "pr1", bio: "old" } },
        },
      }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { profile: { update: { bio: "new" } } },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [{ id: "pr1", bio: "new", userId: "u1" }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one upsert (inverse side) creates then updates the profile",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Owner" } }),
    act: async (client) => {
      await client.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr1", bio: "Created" },
              update: { bio: "Unused" },
            },
          },
        },
      });
      await client.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr-unused", bio: "Should not create" },
              update: { bio: "Updated" },
            },
          },
        },
      });
    },
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [{ id: "pr1", bio: "Updated", userId: "u1" }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one disconnect true (inverse side) nulls the child FK",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Owner",
          profile: { create: { id: "pr1", bio: "kept" } },
        },
      }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { profile: { disconnect: true } },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [{ id: "pr1", bio: "kept", userId: null }],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one disconnect true (inverse side) with no related row is a no-op",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Owner" } }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          name: "Renamed",
          profile: { disconnect: true },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Renamed" }],
      posts: [],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    name: "to-one delete true (inverse side) deletes the related row",
    seed: (client) =>
      client.user.create({
        data: {
          id: "u1",
          name: "Owner",
          profile: { create: { id: "pr1", bio: "doomed" } },
        },
      }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: { profile: { delete: true } },
      }),
    expected: {
      users: [{ id: "u1", name: "Owner" }],
      posts: [],
      profiles: [],
      tags: [],
      postTags: [],
    },
  },
  {
    // DESIGN §5.3 pins `delete: true` as lax (requireAffected: false), so a
    // missing related row is a NO-OP in both modes. NOTE: this deliberately
    // diverges from Prisma, which throws P2025 ("depends on one or more
    // records that were required but not found") for nested delete of an
    // absent to-one record. The DESIGN is normative here.
    name: "to-one delete true (inverse side) with no related row is a no-op (DESIGN §5.3; Prisma would throw P2025)",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Owner" } }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          name: "Renamed",
          profile: { delete: true },
        },
      }),
    expected: {
      users: [{ id: "u1", name: "Renamed" }],
      posts: [],
      profiles: [],
      tags: [],
      postTags: [],
    },
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
    name: "m2m connectOrCreate string-selector array rejects unknown overlap",
    expectReject: true,
    expectedError:
      "depends on an earlier 'connectOrCreate' target write in the same nested write",
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
    expected: m2mExpected(),
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
    name: "m2m multi-item disconnect removes each listed association only",
    seed: m2mBaselineSeed,
    act: async (client) => {
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: { connect: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] },
        },
      });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { disconnect: [{ id: "t1" }, { id: "t2" }] } },
      });
    },
    expected: m2mExpected({ membership: { p1: ["t3"] } }),
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
    // RETARGETED by N6-U3 (own-write linearization, ATOM §4.1), from a rejection to an
    // accept-and-execute assertion on the SAME payload. `connect` reads nothing, so it
    // is a stage-3 pure adder and now runs AFTER the junction's `deleteMany`, whose
    // filter is therefore resolved against committed membership: t2 is not a member
    // when the removal runs, so the removal leaves it alone and the sibling `connect`
    // then attaches it. The old rejection was the ledger deriving legality over an
    // order the engine did not execute.
    name: "m2m connect after a deleteMany that cannot see it",
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
    expected: m2mExpected({ membership: { p1: ["t1", "t2"] } }),
  },
  {
    // RETARGETED by N6-U3, same reason as the scenario above and the sharper half of
    // it: a filtered removal never consumes a row the same call is about to add. The
    // removal runs first and finds no t9; `create` then inserts it and joins it. Prisma
    // with these keys in this order deletes the row it just created (measured on 7.9.1;
    // prisma/prisma#16606). The fixed order makes that unreachable in either spelling.
    name: "m2m create survives a deleteMany naming the same key",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            create: { id: "t9", name: "tag-9" },
            deleteMany: { id: "t9" },
          },
        },
      }),
    expected: m2mExpected({
      membership: { p1: ["t9"] },
      tags: { ...BASELINE_M2M_TAGS, t9: "tag-9" },
    }),
  },
  {
    name: "m2m overlapping set and deleteMany reject membership dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'set' membership write",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: { set: [{ id: "t1" }], deleteMany: { id: "t1" } },
        },
      }),
    expected: m2mExpected(),
  },
  {
    name: "m2m connectOrCreate then deleteMany rejects target dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'connectOrCreate' target write",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t9" },
              create: { id: "t9", name: "tag-9" },
            },
            deleteMany: { id: "t9" },
          },
        },
      }),
    expected: m2mExpected(),
  },
  {
    name: "m2m explicit delete then deleteMany rejects target dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'delete' target write",
    seed: async (client) => {
      await m2mBaselineSeed(client);
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: { delete: { id: "t1" }, deleteMany: { id: "t1" } },
        },
      }),
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m disconnect then deleteMany rejects membership dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'disconnect' membership write",
    seed: async (client) => {
      await m2mBaselineSeed(client);
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            disconnect: { id: "t1" },
            deleteMany: { id: "t1" },
          },
        },
      }),
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m update then deleteMany rejects target dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'update' target write",
    seed: async (client) => {
      await m2mBaselineSeed(client);
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            update: { where: { id: "t1" }, data: { name: "changed" } },
            deleteMany: { name: "changed" },
          },
        },
      }),
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m updateMany then deleteMany rejects filter dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'updateMany' target write",
    seed: async (client) => {
      await m2mBaselineSeed(client);
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            updateMany: { where: { id: "t1" }, data: { name: "changed" } },
            deleteMany: { name: "changed" },
          },
        },
      }),
    expected: m2mExpected({ membership: { p1: ["t1"] } }),
  },
  {
    name: "m2m multiple deleteMany filters reject internal dependency",
    expectReject: true,
    expectedError: "depends on an earlier 'deleteMany' target write",
    seed: async (client) => {
      await m2mBaselineSeed(client);
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: { tags: { deleteMany: [{ id: "t1" }, { id: "t2" }] } },
      }),
    expected: m2mExpected({ membership: { p1: ["t1", "t2"] } }),
  },
  {
    name: "standalone m2m deleteMany with no matching member is a no-op",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: { tags: { deleteMany: { name: "tag-1" } } },
      }),
    expected: m2mExpected(),
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
    // RETARGETED by N6-U3: the shape still rejects and still writes nothing, but the
    // rejection now comes from the row-level guard rather than the preflight. `upsert`
    // is a stage-1 named reader and `connect` a stage-3 adder, so the upsert's probe is
    // ordered FIRST and correctly reports what committed state says — t1 exists but is
    // not a member of p1. Adding a preflight check for the same fact would be a second
    // guard on one invariant (the AGENTS.md ban); the correlated probe already owns it.
    name: "m2m connect then overlapping upsert: the upsert's probe decides first",
    expectReject: true,
    expectedError: "Cannot upsert relation 'tags': target record was not found",
    seed: m2mBaselineSeed,
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connect: { id: "t1" },
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "create" },
              update: { name: "update" },
            },
          },
        },
      }),
    expected: m2mExpected(),
  },
  {
    // RETARGETED by N6-U3 — and this pair is the FORK ITSELF, made visible. The old
    // message blamed `deleteMany` for the `upsert`'s read; the new one blames `upsert`
    // for the `deleteMany`'s read. Both cannot be right, and the old one was derived
    // over `planRelationMutationSteps`' private order, which put `deleteMany` before
    // `upsert` while the engine emitted `upsert` first. The attribution now names the
    // sequence that actually runs. The shape still rejects (a junction `deleteMany`
    // resolves its filter against a membership the sibling upsert rewrites — ATOM §4.1
    // case ii, the class no ordering can fix) and still writes nothing.
    name: "m2m upsert then deleteMany: the removal cannot read past the upsert",
    expectReject: true,
    expectedError: "depends on an earlier 'upsert' target write",
    seed: async (client) => {
      await m2mBaselineSeed(client);
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            deleteMany: { id: "t1" },
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "create" },
              update: { name: "update" },
            },
          },
        },
      }),
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
    name: "self m2m connect then inverse upsert rejects shared junction dependency",
    seed: (client) => client.user.create({ data: { id: "u1", name: "Alice" } }),
    act: (client) =>
      client.user.update({
        where: { id: "u1" },
        data: {
          follows: { connect: { id: "u1" } },
          followedBy: {
            upsert: {
              where: { id: "u1" },
              create: { id: "u1", name: "create" },
              update: { name: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'connect' membership write",
    expected: { follows: [], followedBy: [] },
  },
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
// Group 5c: the create-family current row enters the target-existence ledger at
// its actual execution point: after parent-held FK relations, before related-
// held FK and M2M relations.
// ---------------------------------------------------------------------------

type CreateRootDependencySchema = typeof createRootDependencySchema;

async function dumpCreateRootDependency(
  client: SchemaClient<CreateRootDependencySchema>
): Promise<PersistedState> {
  const nodes = await client.node.findMany({ orderBy: { id: "asc" } });
  return { nodes };
}

const createRootDependencyScenarios: Scenario<CreateRootDependencySchema>[] = [
  {
    name: "after-parent self connectOrCreate cannot depend on the current insert",
    act: (client) =>
      client.node.create({
        data: {
          id: 1,
          label: "root",
          children: {
            connectOrCreate: {
              where: { id: 1 },
              create: { id: 1, label: "duplicate" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'create' target write",
    expected: { nodes: [] },
  },
  {
    name: "after-parent self connectOrCreate allows a disjoint numeric id",
    act: (client) =>
      client.node.create({
        data: {
          id: 1,
          label: "root",
          children: {
            connectOrCreate: {
              where: { id: 2 },
              create: { id: 2, label: "child" },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 1, label: "root", parentId: null },
        { id: 2, label: "child", parentId: 1 },
      ],
    },
  },
  {
    name: "before-parent self connect is unaffected by the future insert",
    act: (client) =>
      client.node.create({
        data: {
          id: 1,
          label: "root",
          parent: { connect: { id: 1 } },
        },
      }),
    expectReject: true,
    expectedError: "target record was not found",
    expected: { nodes: [] },
  },
  {
    name: "nested create keeps its before-parent decision ahead of its insert",
    act: (client) =>
      client.node.create({
        data: {
          id: 10,
          label: "outer",
          children: {
            create: {
              id: 1,
              label: "child",
              parent: { connect: { id: 1 } },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "target record was not found",
    expected: { nodes: [] },
  },
  {
    name: "missing top-level upsert applies the create-branch insert barrier",
    act: (client) =>
      client.node.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          label: "root",
          children: {
            connectOrCreate: {
              where: { id: 1 },
              create: { id: 1, label: "duplicate" },
            },
          },
        },
        update: { label: "unused" },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'create' target write",
    expected: { nodes: [] },
  },
];

async function dumpUpdatePredicateDependency(
  client: SchemaClient<CreateRootDependencySchema>
): Promise<PersistedState> {
  const records = await client.node.findMany({
    orderBy: { id: "asc" },
    include: { links: { orderBy: { id: "asc" } } },
  });
  const nodes: unknown[] = [];
  const links: unknown[] = [];
  for (const record of records as Array<{
    id: number;
    label: string;
    parentId: number | null;
    links?: Array<{ id: number }>;
  }>) {
    nodes.push({
      id: record.id,
      label: record.label,
      parentId: record.parentId,
    });
    const targetIds = (record.links ?? []).map((target) => target.id);
    if (targetIds.length > 0) links.push({ sourceId: record.id, targetIds });
  }
  return { nodes, links };
}

const UPDATE_PREDICATE_ERROR = "depends on an earlier 'update' target write";

const updatePredicateScenarios: Scenario<CreateRootDependencySchema>[] = [
  {
    name: "root id transition rejects a later self decision on the old id",
    seed: (client) => client.node.create({ data: { id: 1, label: "root" } }),
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          id: 2,
          links: {
            connectOrCreate: {
              where: { id: 1 },
              create: { id: 1, label: "old" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_PREDICATE_ERROR,
    expected: {
      nodes: [{ id: 1, label: "root", parentId: null }],
      links: [],
    },
  },
  {
    name: "root id transition rejects a later self decision on the new id",
    seed: (client) => client.node.create({ data: { id: 1, label: "root" } }),
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          id: { set: 2 },
          links: {
            connectOrCreate: {
              where: { id: 2 },
              create: { id: 2, label: "new" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_PREDICATE_ERROR,
    expected: {
      nodes: [{ id: 1, label: "root", parentId: null }],
      links: [],
    },
  },
  {
    name: "root id transition allows a disjoint numeric self decision",
    seed: (client) => client.node.create({ data: { id: 1, label: "root" } }),
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          id: 2,
          links: {
            connectOrCreate: {
              where: { id: 3 },
              create: { id: 3, label: "target" },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 2, label: "root", parentId: null },
        { id: 3, label: "target", parentId: null },
      ],
      links: [{ sourceId: 2, targetIds: [3] }],
    },
  },
  {
    name: "payload update does not block self connectOrCreate by id",
    seed: async (client) => {
      await client.node.create({ data: { id: 1, label: "before" } });
      await client.node.create({ data: { id: 2, label: "target" } });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          label: "after",
          links: {
            connectOrCreate: {
              where: { id: 2 },
              create: { id: 2, label: "unused" },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 1, label: "after", parentId: null },
        { id: 2, label: "target", parentId: null },
      ],
      links: [{ sourceId: 1, targetIds: [2] }],
    },
  },
  {
    name: "payload update does not block self upsert by id",
    seed: async (client) => {
      await client.node.create({ data: { id: 1, label: "before" } });
      await client.node.create({ data: { id: 2, label: "target" } });
      await client.node.update({
        where: { id: 1 },
        data: { links: { connect: { id: 2 } } },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          label: "after",
          links: {
            upsert: {
              where: { id: 2 },
              create: { id: 2, label: "unused" },
              update: { label: "target-after" },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 1, label: "after", parentId: null },
        { id: 2, label: "target-after", parentId: null },
      ],
      links: [{ sourceId: 1, targetIds: [2] }],
    },
  },
  {
    name: "nested payload update does not taint a sibling target decision",
    seed: async (client) => {
      await client.node.create({ data: { id: 10, label: "parent" } });
      await client.node.create({
        data: { id: 1, label: "child", parentId: 10 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 10 },
        data: {
          children: {
            update: {
              where: { id: 1 },
              data: { label: "after" },
            },
          },
          links: {
            connectOrCreate: {
              where: { id: 1 },
              create: { id: 1, label: "unused" },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 1, label: "after", parentId: 10 },
        { id: 10, label: "parent", parentId: null },
      ],
      links: [{ sourceId: 10, targetIds: [1] }],
    },
  },
  {
    name: "payload update conflicts with a recursive m2m deleteMany filter",
    seed: async (client) => {
      await client.node.create({ data: { id: 1, label: "before" } });
      await client.node.update({
        where: { id: 1 },
        data: { links: { connect: { id: 1 } } },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          label: "after",
          links: { deleteMany: { AND: [{ label: "after" }] } },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_PREDICATE_ERROR,
    expected: {
      nodes: [{ id: 1, label: "before", parentId: null }],
      links: [{ sourceId: 1, targetIds: [1] }],
    },
  },
  {
    name: "nested to-many update rejects its old selector inside the child",
    seed: async (client) => {
      await client.node.create({ data: { id: 10, label: "parent" } });
      await client.node.create({
        data: { id: 1, label: "child", parentId: 10 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 10 },
        data: {
          children: {
            update: {
              where: { id: 1 },
              data: {
                id: 2,
                links: {
                  connectOrCreate: {
                    where: { id: 1 },
                    create: { id: 1, label: "old" },
                  },
                },
              },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_PREDICATE_ERROR,
    expected: {
      nodes: [
        { id: 1, label: "child", parentId: 10 },
        { id: 10, label: "parent", parentId: null },
      ],
      links: [],
    },
  },
  {
    name: "nested to-many update allows a disjoint child decision",
    seed: async (client) => {
      await client.node.create({ data: { id: 10, label: "parent" } });
      await client.node.create({
        data: { id: 1, label: "child", parentId: 10 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 10 },
        data: {
          children: {
            update: {
              where: { id: 1 },
              data: {
                id: 2,
                links: {
                  connectOrCreate: {
                    where: { id: 3 },
                    create: { id: 3, label: "target" },
                  },
                },
              },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 2, label: "child", parentId: 10 },
        { id: 3, label: "target", parentId: null },
        { id: 10, label: "parent", parentId: null },
      ],
      links: [{ sourceId: 2, targetIds: [3] }],
    },
  },
  {
    name: "nested to-one update uses an unknown child selector conservatively",
    seed: async (client) => {
      await client.node.create({ data: { id: 1, label: "parent" } });
      await client.node.create({
        data: { id: 10, label: "root", parentId: 1 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 10 },
        data: {
          parent: {
            update: {
              id: 2,
              links: {
                connectOrCreate: {
                  where: { id: 3 },
                  create: { id: 3, label: "target" },
                },
              },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_PREDICATE_ERROR,
    expected: {
      nodes: [
        { id: 1, label: "parent", parentId: null },
        { id: 10, label: "root", parentId: 1 },
      ],
      links: [],
    },
  },
  {
    name: "existing top-level upsert uses its exact pk for disjointness",
    seed: (client) => client.node.create({ data: { id: 1, label: "root" } }),
    act: (client) =>
      client.node.upsert({
        where: { id: 1 },
        create: { id: 1, label: "unused" },
        update: {
          id: 2,
          links: {
            connectOrCreate: {
              where: { id: 3 },
              create: { id: 3, label: "target" },
            },
          },
        },
      }),
    expected: {
      nodes: [
        { id: 2, label: "root", parentId: null },
        { id: 3, label: "target", parentId: null },
      ],
      links: [{ sourceId: 2, targetIds: [3] }],
    },
  },
];

type MembershipDependencySchema = typeof membershipDependencySchema;

async function dumpMembershipDependency(
  client: SchemaClient<MembershipDependencySchema>
): Promise<PersistedState> {
  const [containers, nodes] = await Promise.all([
    client.container.findMany({ orderBy: { id: "asc" } }),
    client.node.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { containers, nodes };
}

const UPDATE_MEMBERSHIP_ERROR =
  "depends on an earlier 'update' membership write";

async function seedCrossScopeMembershipBase(
  client: SchemaClient<MembershipDependencySchema>
): Promise<void> {
  await client.container.create({ data: { id: 10 } });
  await client.node.create({
    data: { id: 9, label: "nine", containerId: 10 },
  });
  await client.node.create({
    data: { id: 1, label: "one", containerId: 10, parentId: 9 },
  });
  await client.node.create({
    data: { id: 4, label: "four", containerId: 10 },
  });
}

async function seedCrossScopeMembershipWithTarget(
  client: SchemaClient<MembershipDependencySchema>
): Promise<void> {
  await seedCrossScopeMembershipBase(client);
  await client.node.create({ data: { id: 2, label: "two" } });
}

function runCrossScopeMembershipMutation(
  client: SchemaClient<MembershipDependencySchema>,
  firstOperation: "connect" | "connectOrCreate" | "create",
  laterNodeId: 1 | 4
): PromiseLike<unknown> {
  const partnerOf =
    firstOperation === "create"
      ? { create: { id: 2, label: "two" } }
      : firstOperation === "connect"
        ? { connect: { id: 2 } }
        : {
            connectOrCreate: {
              where: { id: 2 },
              create: { id: 2, label: "unused" },
            },
          };

  return client.node.update({
    where: { id: 9 },
    data: {
      children: {
        update: {
          where: { id: 1 },
          data: { partnerOf },
        },
      },
      container: {
        update: {
          nodes: {
            update: {
              where: { id: laterNodeId },
              data: {
                partnerOf: {
                  upsert: {
                    create: { id: 3, label: "three" },
                    update: { label: "updated" },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

const CROSS_SCOPE_MEMBERSHIP_BASE_NODES: unknown[] = [
  {
    id: 1,
    label: "one",
    containerId: 10,
    parentId: 9,
    partnerId: null,
  },
  {
    id: 4,
    label: "four",
    containerId: 10,
    parentId: null,
    partnerId: null,
  },
  {
    id: 9,
    label: "nine",
    containerId: 10,
    parentId: null,
    partnerId: null,
  },
];

const CROSS_SCOPE_MEMBERSHIP_BASE: PersistedState = {
  containers: [{ id: 10 }],
  nodes: CROSS_SCOPE_MEMBERSHIP_BASE_NODES,
};

const CROSS_SCOPE_MEMBERSHIP_WITH_TARGET: PersistedState = {
  containers: [{ id: 10 }],
  nodes: [
    CROSS_SCOPE_MEMBERSHIP_BASE_NODES[0],
    {
      id: 2,
      label: "two",
      containerId: null,
      parentId: null,
      partnerId: null,
    },
    ...CROSS_SCOPE_MEMBERSHIP_BASE_NODES.slice(1),
  ],
};

const CROSS_SCOPE_MEMBERSHIP_DISJOINT: PersistedState = {
  containers: [{ id: 10 }],
  nodes: [
    CROSS_SCOPE_MEMBERSHIP_BASE_NODES[0],
    {
      id: 2,
      label: "two",
      containerId: null,
      parentId: null,
      partnerId: 1,
    },
    {
      id: 3,
      label: "three",
      containerId: null,
      parentId: null,
      partnerId: 4,
    },
    ...CROSS_SCOPE_MEMBERSHIP_BASE_NODES.slice(1),
  ],
};

const membershipDependencyScenarios: Scenario<MembershipDependencySchema>[] = [
  {
    name: "nested create membership rejects a later cross-scope to-one upsert",
    seed: seedCrossScopeMembershipBase,
    act: (client) => runCrossScopeMembershipMutation(client, "create", 1),
    expectReject: true,
    expectedError: "depends on an earlier 'create' membership write",
    expected: CROSS_SCOPE_MEMBERSHIP_BASE,
  },
  {
    name: "nested create membership allows a disjoint cross-scope to-one upsert",
    seed: seedCrossScopeMembershipBase,
    act: (client) => runCrossScopeMembershipMutation(client, "create", 4),
    expected: CROSS_SCOPE_MEMBERSHIP_DISJOINT,
  },
  {
    name: "connectOrCreate membership rejects a later cross-scope to-one upsert",
    seed: seedCrossScopeMembershipWithTarget,
    act: (client) =>
      runCrossScopeMembershipMutation(client, "connectOrCreate", 1),
    expectReject: true,
    expectedError: "depends on an earlier 'connectOrCreate' membership write",
    expected: CROSS_SCOPE_MEMBERSHIP_WITH_TARGET,
  },
  {
    name: "connectOrCreate membership allows a disjoint cross-scope to-one upsert",
    seed: seedCrossScopeMembershipWithTarget,
    act: (client) =>
      runCrossScopeMembershipMutation(client, "connectOrCreate", 4),
    expected: CROSS_SCOPE_MEMBERSHIP_DISJOINT,
  },
  {
    name: "found connect membership rejects a later cross-scope to-one upsert",
    seed: seedCrossScopeMembershipWithTarget,
    act: (client) => runCrossScopeMembershipMutation(client, "connect", 1),
    expectReject: true,
    expectedError: "depends on an earlier 'connect' membership write",
    expected: CROSS_SCOPE_MEMBERSHIP_WITH_TARGET,
  },
  {
    name: "self to-one inverse upsert rejects a current-row FK membership move",
    seed: async (client) => {
      await client.node.create({
        data: { id: 1, label: "one", partnerId: 1 },
      });
      await client.node.create({ data: { id: 2, label: "two" } });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          partnerId: 2,
          partnerOf: {
            upsert: {
              create: { id: 3, label: "three" },
              update: { label: "occupied" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_MEMBERSHIP_ERROR,
    expected: {
      containers: [],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: null,
          parentId: null,
          partnerId: 1,
        },
        {
          id: 2,
          label: "two",
          containerId: null,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "direct self partner update consumes the rebound FK and stays legal",
    seed: async (client) => {
      await client.node.create({
        data: { id: 1, label: "one", partnerId: 1 },
      });
      await client.node.create({ data: { id: 2, label: "two" } });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          partnerId: 2,
          partner: { update: { label: "rebound" } },
        },
      }),
    expected: {
      containers: [],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: null,
          parentId: null,
          partnerId: 2,
        },
        {
          id: 2,
          label: "rebound",
          containerId: null,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "inverse root seed does not taint a direct relation in the same write",
    seed: async (client) => {
      await client.node.create({
        data: { id: 1, label: "one", partnerId: 1 },
      });
      await client.node.create({ data: { id: 2, label: "two" } });
      await client.node.create({ data: { id: 3, label: "three" } });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          partnerId: 2,
          partner: { update: { label: "rebound" } },
          partnerOf: { connect: { id: 3 } },
        },
      }),
    expected: {
      containers: [],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: null,
          parentId: null,
          partnerId: 2,
        },
        {
          id: 2,
          label: "rebound",
          containerId: null,
          parentId: null,
          partnerId: null,
        },
        {
          id: 3,
          label: "three",
          containerId: null,
          parentId: null,
          partnerId: 1,
        },
      ],
    },
  },
  ...(["direct-first", "inverse-first"] as const).map(
    (order): Scenario<MembershipDependencySchema> => ({
      name: `self parent and inverse disjoint updates stay legal (${order})`,
      seed: async (client) => {
        await client.node.create({
          data: { id: 1, label: "one", parentId: 1 },
        });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 3, label: "three", parentId: 1 },
        });
      },
      act: (client) => {
        const parent = { update: { label: "parent-updated" } };
        const children = {
          update: {
            where: { id: 3 },
            data: { label: "child-updated" },
          },
        };
        const relations =
          order === "direct-first"
            ? { parent, children }
            : { children, parent };
        return client.node.update({
          where: { id: 1 },
          data: { parentId: 2, ...relations },
        });
      },
      expected: {
        containers: [],
        nodes: [
          {
            id: 1,
            label: "one",
            containerId: null,
            parentId: 2,
            partnerId: null,
          },
          {
            id: 2,
            label: "parent-updated",
            containerId: null,
            parentId: null,
            partnerId: null,
          },
          {
            id: 3,
            label: "child-updated",
            containerId: null,
            parentId: 1,
            partnerId: null,
          },
        ],
      },
    })
  ),
  {
    name: "self to-many inverse update rejects the moved current row",
    seed: async (client) => {
      await client.node.create({
        data: { id: 1, label: "one", parentId: 1 },
      });
      await client.node.create({
        data: { id: 2, label: "two", parentId: 1 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          parentId: 2,
          children: {
            update: { where: { id: 1 }, data: { label: "moved" } },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_MEMBERSHIP_ERROR,
    expected: {
      containers: [],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: null,
          parentId: 1,
          partnerId: null,
        },
        {
          id: 2,
          label: "two",
          containerId: null,
          parentId: 1,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "self to-many inverse update allows a disjoint numeric target",
    seed: async (client) => {
      await client.node.create({
        data: { id: 1, label: "one", parentId: 1 },
      });
      await client.node.create({
        data: { id: 2, label: "two", parentId: 1 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          parentId: 2,
          children: {
            update: { where: { id: 2 }, data: { label: "updated" } },
          },
        },
      }),
    expected: {
      containers: [],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: null,
          parentId: 2,
          partnerId: null,
        },
        {
          id: 2,
          label: "updated",
          containerId: null,
          parentId: 1,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "direct self parent update stays legal after scalar FK rebind",
    seed: async (client) => {
      await client.node.create({
        data: { id: 1, label: "one", parentId: 1 },
      });
      await client.node.create({ data: { id: 2, label: "two" } });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          parentId: 2,
          parent: { update: { label: "rebound" } },
        },
      }),
    expected: {
      containers: [],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: null,
          parentId: 2,
          partnerId: null,
        },
        {
          id: 2,
          label: "rebound",
          containerId: null,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "nested to-many child update carries its selector into inverse membership",
    seed: async (client) => {
      await client.container.create({ data: { id: 10 } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10, partnerId: 1 },
      });
      await client.node.create({ data: { id: 2, label: "two" } });
    },
    act: (client) =>
      client.container.update({
        where: { id: 10 },
        data: {
          nodes: {
            update: {
              where: { id: 1 },
              data: {
                partnerId: 2,
                partnerOf: {
                  upsert: {
                    create: { id: 3, label: "three" },
                    update: { label: "occupied" },
                  },
                },
              },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_MEMBERSHIP_ERROR,
    expected: {
      containers: [{ id: 10 }],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: 10,
          parentId: null,
          partnerId: 1,
        },
        {
          id: 2,
          label: "two",
          containerId: null,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "same-node non-self FK rebind rejects inverse descent through the final target",
    seed: async (client) => {
      await client.container.create({ data: { id: 10 } });
      await client.container.create({ data: { id: 20 } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          containerId: 20,
          container: {
            update: {
              nodes: {
                update: { where: { id: 1 }, data: { label: "after" } },
              },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_MEMBERSHIP_ERROR,
    expected: {
      containers: [{ id: 10 }, { id: 20 }],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: 10,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "same-node non-self FK rebind allows a disjoint inverse holder",
    seed: async (client) => {
      await client.container.create({ data: { id: 10 } });
      await client.container.create({ data: { id: 20 } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10 },
      });
      await client.node.create({
        data: { id: 3, label: "three", containerId: 20 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 1 },
        data: {
          containerId: 20,
          container: {
            update: {
              nodes: {
                update: { where: { id: 3 }, data: { label: "after" } },
              },
            },
          },
        },
      }),
    expected: {
      containers: [{ id: 10 }, { id: 20 }],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: 20,
          parentId: null,
          partnerId: null,
        },
        {
          id: 3,
          label: "after",
          containerId: 20,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "non-self nested FK rebind rejects a later inverse read of the same holder",
    seed: async (client) => {
      await client.container.create({ data: { id: 10 } });
      await client.container.create({ data: { id: 20 } });
      await client.node.create({
        data: { id: 9, label: "root", containerId: 10 },
      });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10, parentId: 9 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 9 },
        data: {
          children: {
            update: { where: { id: 1 }, data: { containerId: 20 } },
          },
          container: {
            update: {
              nodes: {
                update: { where: { id: 1 }, data: { label: "after" } },
              },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: UPDATE_MEMBERSHIP_ERROR,
    expected: {
      containers: [{ id: 10 }, { id: 20 }],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: 10,
          parentId: 9,
          partnerId: null,
        },
        {
          id: 9,
          label: "root",
          containerId: 10,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "non-self nested FK rebind allows a disjoint inverse holder",
    seed: async (client) => {
      await client.container.create({ data: { id: 10 } });
      await client.container.create({ data: { id: 20 } });
      await client.node.create({
        data: { id: 9, label: "root", containerId: 10 },
      });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10, parentId: 9 },
      });
      await client.node.create({
        data: { id: 3, label: "three", containerId: 10 },
      });
    },
    act: (client) =>
      client.node.update({
        where: { id: 9 },
        data: {
          children: {
            update: { where: { id: 1 }, data: { containerId: 20 } },
          },
          container: {
            update: {
              nodes: {
                update: { where: { id: 3 }, data: { label: "after" } },
              },
            },
          },
        },
      }),
    expected: {
      containers: [{ id: 10 }, { id: 20 }],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: 20,
          parentId: 9,
          partnerId: null,
        },
        {
          id: 3,
          label: "after",
          containerId: 10,
          parentId: null,
          partnerId: null,
        },
        {
          id: 9,
          label: "root",
          containerId: 10,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
  {
    name: "non-self child-holds cascade keeps membership through a key transition",
    seed: async (client) => {
      await client.container.create({ data: { id: 10 } });
      await client.node.create({
        data: { id: 1, label: "before", containerId: 10 },
      });
    },
    act: (client) =>
      client.container.update({
        where: { id: 10 },
        data: {
          id: 11,
          nodes: {
            update: { where: { id: 1 }, data: { label: "after" } },
          },
        },
      }),
    expected: {
      containers: [{ id: 11 }],
      nodes: [
        {
          id: 1,
          label: "after",
          containerId: 11,
          parentId: null,
          partnerId: null,
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Group 6: same-relation own-write decisions over numeric identities. Unequal
// integers are the portable disjoint control; overlapping or unknown target /
// membership dependencies reject before either execution mode writes.
// ---------------------------------------------------------------------------

type NumericDependencySchema = typeof numericDependencySchema;

async function dumpNumericDependency(
  client: SchemaClient<NumericDependencySchema>
): Promise<PersistedState> {
  const [owners, items, profiles] = await Promise.all([
    client.owner.findMany({ orderBy: { id: "asc" } }),
    client.item.findMany({ orderBy: { id: "asc" } }),
    client.profile.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { owners, items, profiles };
}

const OWN_WRITE_ERROR = "depends on an earlier";

const numericDependencyScenarios: Scenario<NumericDependencySchema>[] = [
  {
    // RETARGETED by N6-U3: still rejects, still writes nothing, different guard. The
    // nested `update` is a stage-1 named reader and `create` a stage-3 adder, so the
    // update's correlated probe runs first and truthfully reports that item 1 is not
    // among owner 1's children. A payload that both creates a row and updates it is a
    // row-level not-found here, not a planning-soundness failure.
    name: "create then overlapping update: the update's probe runs first",
    seed: (client) => client.owner.create({ data: { id: 1, name: "Owner" } }),
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            create: { id: 1, label: "created" },
            update: { where: { id: 1 }, data: { label: "updated" } },
          },
        },
      }),
    expectReject: true,
    expectedError:
      "Cannot update relation 'items': target record was not found",
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [],
      profiles: [],
    },
  },
  {
    name: "create then disjoint numeric update is allowed",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            create: { id: 2, label: "created" },
            update: { where: { id: 1 }, data: { label: "after" } },
          },
        },
      }),
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [
        { id: 1, label: "after", ownerId: 1 },
        { id: 2, label: "created", ownerId: 1 },
      ],
      profiles: [],
    },
  },
  {
    // RETARGETED by N6-U3, same reading as the create/update pair above: the update's
    // correlated probe is ordered before the adder that would make it a member.
    name: "connect then overlapping update: the update's probe runs first",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "free", ownerId: null },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            connect: { id: 1 },
            update: { where: { id: 1 }, data: { label: "changed" } },
          },
        },
      }),
    expectReject: true,
    expectedError:
      "Cannot update relation 'items': target record was not found",
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "free", ownerId: null }],
      profiles: [],
    },
  },
  {
    // RETARGETED by N6-U3: the upsert is a stage-1 named reader, so its correlated
    // probe runs before the stage-3 `connect` that would make item 1 a member, and it
    // reports what committed state says. Rejects, writes nothing, different guard.
    name: "connect then overlapping upsert: the upsert's probe decides first",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "free", ownerId: null },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            connect: { id: 1 },
            upsert: {
              where: { id: 1 },
              create: { id: 1, label: "created" },
              update: { label: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError:
      "Cannot upsert relation 'items': target record was not found",
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "free", ownerId: null }],
      profiles: [],
    },
  },
  {
    name: "disconnect then to-one upsert rejects",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.profile.create({
        data: { id: 1, bio: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          profile: {
            disconnect: true,
            upsert: {
              create: { id: 2, bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: OWN_WRITE_ERROR,
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [],
      profiles: [{ id: 1, bio: "before", ownerId: 1 }],
    },
  },
  {
    name: "delete then to-one upsert rejects",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.profile.create({
        data: { id: 1, bio: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          profile: {
            delete: true,
            upsert: {
              create: { id: 2, bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: OWN_WRITE_ERROR,
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [],
      profiles: [{ id: 1, bio: "before", ownerId: 1 }],
    },
  },
  {
    name: "delete then overlapping set rejects",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: { items: { delete: { id: 1 }, set: [{ id: 1 }] } },
      }),
    expectReject: true,
    expectedError: OWN_WRITE_ERROR,
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "before", ownerId: 1 }],
      profiles: [],
    },
  },
  {
    name: "overlapping update array rejects",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            update: [
              { where: { id: 1 }, data: { label: "first" } },
              { where: { id: 1 }, data: { label: "second" } },
            ],
          },
        },
      }),
    expectReject: true,
    expectedError: OWN_WRITE_ERROR,
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "before", ownerId: 1 }],
      profiles: [],
    },
  },
  {
    name: "disjoint numeric update array is allowed",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({ data: { id: 1, label: "a", ownerId: 1 } });
      await client.item.create({ data: { id: 2, label: "b", ownerId: 1 } });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            update: [
              { where: { id: 1 }, data: { label: "one" } },
              { where: { id: 2 }, data: { label: "two" } },
            ],
          },
        },
      }),
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [
        { id: 1, label: "one", ownerId: 1 },
        { id: 2, label: "two", ownerId: 1 },
      ],
      profiles: [],
    },
  },
  {
    name: "overlapping upsert array rejects",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            upsert: [
              {
                where: { id: 1 },
                create: { id: 1, label: "create-1" },
                update: { label: "first" },
              },
              {
                where: { id: 1 },
                create: { id: 1, label: "create-2" },
                update: { label: "second" },
              },
            ],
          },
        },
      }),
    expectReject: true,
    expectedError: OWN_WRITE_ERROR,
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "before", ownerId: 1 }],
      profiles: [],
    },
  },
  {
    name: "disjoint numeric upsert array is allowed",
    seed: (client) => client.owner.create({ data: { id: 1, name: "Owner" } }),
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            upsert: [
              {
                where: { id: 1 },
                create: { id: 1, label: "one" },
                update: { label: "updated-one" },
              },
              {
                where: { id: 2 },
                create: { id: 2, label: "two" },
                update: { label: "updated-two" },
              },
            ],
          },
        },
      }),
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [
        { id: 1, label: "one", ownerId: 1 },
        { id: 2, label: "two", ownerId: 1 },
      ],
      profiles: [],
    },
  },
  {
    name: "to-one update slot mutation then upsert rejects",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.profile.create({
        data: { id: 1, bio: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          profile: {
            update: { ownerId: null },
            upsert: {
              create: { id: 2, bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'update' membership write",
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [],
      profiles: [{ id: 1, bio: "before", ownerId: 1 }],
    },
  },
  {
    // RETARGETED by N6-U3, from a rejection to an accept-and-execute assertion on the
    // SAME payload. `upsert` is a stage-1 named reader and `updateMany` a stage-2
    // unbounded writer, so the upsert's probe is ordered before the bulk write that
    // used to invalidate it — the dependency is dissolved by the order, not excused.
    // The targeted arm writes "updated", the sweep then writes "changed" over it.
    name: "upsert then updateMany: the targeted arm runs before the sweep",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            updateMany: { where: { id: 1 }, data: { label: "changed" } },
            upsert: {
              where: { id: 1 },
              create: { id: 1, label: "created" },
              update: { label: "updated" },
            },
          },
        },
      }),
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "changed", ownerId: 1 }],
      profiles: [],
    },
  },
  {
    // RETARGETED by N6-U3, same reading: the upsert's probe precedes the filtered
    // removal, so the pair composes as written and the removal has the last word — the
    // row is updated and then deleted. On a CHILD-HELD relation `deleteMany` reads
    // nothing, which is why it can sit behind every reader; its many-to-many sibling
    // must read membership and is the one case ordering cannot rescue (ATOM §4.1 ii).
    name: "upsert then deleteMany: the removal has the last word",
    seed: async (client) => {
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.item.create({
        data: { id: 1, label: "before", ownerId: 1 },
      });
    },
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          items: {
            deleteMany: { id: 1 },
            upsert: {
              where: { id: 1 },
              create: { id: 1, label: "created" },
              update: { label: "updated" },
            },
          },
        },
      }),
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [],
      profiles: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Group 7: cross-relation target-row dependencies. Target writes flow across
// sibling relation fields when they address the same model; membership stays
// local to the physical relation.
// ---------------------------------------------------------------------------

type CrossRelationTargetSchema = typeof crossRelationTargetSchema;

async function dumpCrossRelationTarget(
  client: SchemaClient<CrossRelationTargetSchema>
): Promise<PersistedState> {
  const [accounts, records] = await Promise.all([
    client.account.findMany({ orderBy: { id: "asc" } }),
    client.record.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { accounts, records };
}

const crossRelationTargetScenarios: Scenario<CrossRelationTargetSchema>[] = [
  {
    // RETARGETED by N6-U3: rejects, writes nothing, different guard. On a PARENT-HELD
    // to-one the FK is one column of the parent row, so two kinds on it are two values
    // for one column — V2 has always refused that arity outright, and now that the
    // preflight no longer intercepts first (its `connect` read is ordered before the
    // `create` write) that older, more specific refusal is the one the caller sees.
    name: "parent-holds create then connect on one relation is a to-one arity refusal",
    seed: (client) =>
      client.record.create({
        data: { id: 1, primaryId: null, secondaryId: null },
      }),
    act: (client) =>
      client.record.update({
        where: { id: 1 },
        data: {
          primary: {
            create: { id: 2, label: "created" },
            connect: { id: 2 },
          },
        },
      }),
    expectReject: true,
    expectedError:
      "supports one mutation kind on the to-one relation 'primary'",
    expected: {
      accounts: [],
      records: [{ id: 1, primaryId: null, secondaryId: null }],
    },
  },
  {
    name: "sibling create then parent-holds connect rejects same target",
    seed: (client) =>
      client.record.create({
        data: { id: 1, primaryId: null, secondaryId: null },
      }),
    act: (client) =>
      client.record.update({
        where: { id: 1 },
        data: {
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 2 } },
        },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'create' target write",
    expected: {
      accounts: [],
      records: [{ id: 1, primaryId: null, secondaryId: null }],
    },
  },
  {
    name: "sibling create and disjoint numeric connect are allowed",
    seed: async (client) => {
      await client.account.create({ data: { id: 1, label: "existing" } });
      await client.record.create({
        data: { id: 1, primaryId: null, secondaryId: null },
      });
    },
    act: (client) =>
      client.record.update({
        where: { id: 1 },
        data: {
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 1 } },
        },
      }),
    expected: {
      accounts: [
        { id: 1, label: "existing" },
        { id: 2, label: "created" },
      ],
      records: [{ id: 1, primaryId: 2, secondaryId: 1 }],
    },
  },
  {
    name: "create-family sibling create then connect observes the earlier insert",
    act: (client) =>
      client.record.create({
        data: {
          id: 1,
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 2 } },
        },
      }),
    expected: {
      accounts: [{ id: 2, label: "created" }],
      records: [{ id: 1, primaryId: 2, secondaryId: 2 }],
    },
  },
];

type NamedM2mSchema = typeof manyToManySchema;

async function dumpNamedM2m(
  client: SchemaClient<NamedM2mSchema>
): Promise<PersistedState> {
  const [alphas, betas] = await Promise.all([
    client.alpha.findMany({
      orderBy: { id: "asc" },
      include: {
        likes: { orderBy: { id: "asc" } },
        stars: { orderBy: { id: "asc" } },
      },
    }),
    client.beta.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { alphas, betas };
}

const namedM2mTargetScenarios: Scenario<NamedM2mSchema>[] = [
  {
    name: "named likes create then stars connectOrCreate rejects target dependency",
    seed: (client) => client.alpha.create({ data: { id: "a1" } }),
    act: (client) =>
      client.alpha.update({
        where: { id: "a1" },
        data: {
          likes: { create: { id: "b1" } },
          stars: {
            connectOrCreate: {
              where: { id: "b1" },
              create: { id: "b1" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'create' target write",
    expected: {
      alphas: [{ id: "a1", likes: [], stars: [] }],
      betas: [],
    },
  },
  {
    name: "named likes membership does not taint distinct stars membership",
    seed: async (client) => {
      await client.alpha.create({ data: { id: "a1" } });
      await client.beta.create({ data: { id: "b1" } });
    },
    act: (client) =>
      client.alpha.update({
        where: { id: "a1" },
        data: {
          likes: { connect: { id: "b1" } },
          stars: { set: [{ id: "b1" }] },
        },
      }),
    expected: {
      alphas: [
        {
          id: "a1",
          likes: [{ id: "b1" }],
          stars: [{ id: "b1" }],
        },
      ],
      betas: [{ id: "b1" }],
    },
  },
];

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

type TransitiveTargetDependencySchema = typeof transitiveTargetDependencySchema;

async function dumpTransitiveTargetDependency(
  client: SchemaClient<TransitiveTargetDependencySchema>
): Promise<PersistedState> {
  const [workspaces, projects, tags] = await Promise.all([
    client.workspace.findMany({
      orderBy: { id: "asc" },
      include: {
        projects: { orderBy: { id: "asc" } },
        tags: { orderBy: { id: "asc" } },
      },
    }),
    client.project.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { workspaces, projects, tags };
}

const TRANSITIVE_TARGET_SEED: PersistedState = {
  workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [] }],
  projects: [{ id: 1, tags: [] }],
  tags: [],
};

const transitiveTargetDependencyScenarios: Scenario<TransitiveTargetDependencySchema>[] =
  [
    {
      name: "nested create then later root connectOrCreate rejects",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: { tags: { create: { id: 100 } } },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: TRANSITIVE_TARGET_SEED,
    },
    {
      name: "nested create and disjoint later root connectOrCreate succeed",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: { tags: { create: { id: 100 } } },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 101 },
                create: { id: 101 },
              },
            },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [{ id: 101 }] }],
        projects: [{ id: 1, tags: [{ id: 100 }] }],
        tags: [{ id: 100 }, { id: 101 }],
      },
    },
    {
      name: "outer create then nested connectOrCreate rejects",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            tags: { create: { id: 100 } },
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  tags: {
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: TRANSITIVE_TARGET_SEED,
    },
    {
      name: "outer create and disjoint nested connectOrCreate succeed",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            tags: { create: { id: 100 } },
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  tags: {
                    connectOrCreate: {
                      where: { id: 101 },
                      create: { id: 101 },
                    },
                  },
                },
              },
            },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [{ id: 100 }] }],
        projects: [{ id: 1, tags: [{ id: 101 }] }],
        tags: [{ id: 100 }, { id: 101 }],
      },
    },
    {
      // RETARGETED TWICE, both times by an absorption that moved the boundary this
      // payload used to stop at, and both times WITHOUT changing what it persists.
      //
      // N6-U3 first: the inner `tags: { create, connectOrCreate }` is the same sibling
      // pair as the top-level cross-step case, one level deeper — the linearization is
      // ONE order and applies at every depth, so the preflight stopped intercepting it
      // and what surfaced was the m2m connectOrCreate's refusal of nested relation
      // writes in its data (the OUTER `projects.connectOrCreate` create arm carries
      // `tags`, and `projects` is itself many-to-many here).
      //
      // E2-U2 now absorbs exactly that create arm, so the payload reaches the inner
      // pair — and lands on the answer its `upsert` twin below has always given: the
      // adopt arm's probe runs before the sibling `create`'s INSERT (ATOM §4.1), so the
      // duplicate insert meets the unique constraint. Same class as the twin, same
      // persisted state as before (rejects, writes nothing) — the assertion that
      // carries the contract is unchanged.
      name: "connectOrCreate payload's inner sibling pair hits the unique constraint",
      seed: (client) => client.workspace.create({ data: { id: 1 } }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              connectOrCreate: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: {
                    create: { id: 100 },
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "Unique constraint violation",
      expected: {
        workspaces: [{ id: 1, projects: [], tags: [] }],
        projects: [],
        tags: [],
      },
    },
    {
      // RETARGETED by N6-U3, same reading as the connectOrCreate scenario above: the
      // inner `create` + `connectOrCreate` on one key linearizes with the adopt's probe
      // first, so the duplicate insert is refused by the unique constraint rather than
      // by the preflight. Rejects, writes nothing.
      name: "upsert create alternative's inner sibling pair hits the unique constraint",
      seed: (client) => client.workspace.create({ data: { id: 1 } }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: {
                    create: { id: 100 },
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
                update: {},
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "Unique constraint violation",
      expected: {
        workspaces: [{ id: 1, projects: [], tags: [] }],
        projects: [],
        tags: [],
      },
    },
    {
      name: "selected top-level upsert create branch gets inherited traversal",
      act: (client) =>
        client.workspace.upsert({
          where: { id: 1 },
          create: {
            id: 1,
            projects: {
              create: {
                id: 1,
                tags: { create: { id: 100 } },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
          update: {},
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: { workspaces: [], projects: [], tags: [] },
    },
    {
      name: "selected top-level upsert update branch gets inherited traversal",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.upsert({
          where: { id: 1 },
          create: { id: 1 },
          update: {
            projects: {
              update: {
                where: { id: 1 },
                data: { tags: { create: { id: 100 } } },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: TRANSITIVE_TARGET_SEED,
    },
  ];

const alternativeBranchDependencyScenarios: Scenario<TransitiveTargetDependencySchema>[] =
  [
    {
      name: "upsert alternatives may repeat a nested connectOrCreate key when the target exists",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: {
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
                update: {
                  tags: {
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
              },
            },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [] }],
        projects: [{ id: 1, tags: [{ id: 100 }] }],
        tags: [{ id: 100 }],
      },
    },
    {
      name: "upsert alternatives may repeat a nested connectOrCreate key when the target is missing",
      seed: (client) => client.workspace.create({ data: { id: 1 } }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: {
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
                update: {
                  tags: {
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
              },
            },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [] }],
        projects: [{ id: 1, tags: [{ id: 100 }] }],
        tags: [{ id: 100 }],
      },
    },
    {
      // RETARGETED by N6-U3, same reading, on the upsert's UPDATE alternative.
      name: "upsert update alternative's inner sibling pair hits the unique constraint",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: { id: 1 },
                update: {
                  tags: {
                    create: { id: 100 },
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "Unique constraint violation",
      expected: TRANSITIVE_TARGET_SEED,
    },
    {
      name: "a connectOrCreate create alternative inherits earlier sibling writes",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            tags: { create: { id: 100 } },
            projects: {
              connectOrCreate: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: {
                    connectOrCreate: {
                      where: { id: 100 },
                      create: { id: 100 },
                    },
                  },
                },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: TRANSITIVE_TARGET_SEED,
    },
    {
      name: "a later sibling sees writes from a connectOrCreate create alternative",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              connectOrCreate: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: { create: { id: 100 } },
                },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: TRANSITIVE_TARGET_SEED,
    },
    {
      name: "a later sibling sees writes from an upsert create alternative",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: { create: { id: 100 } },
                },
                update: {},
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: TRANSITIVE_TARGET_SEED,
    },
    {
      name: "a later sibling sees writes from an upsert update alternative",
      seed: (client) => client.workspace.create({ data: { id: 1 } }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: { id: 1 },
                update: { tags: { create: { id: 100 } } },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: {
        workspaces: [{ id: 1, projects: [], tags: [] }],
        projects: [],
        tags: [],
      },
    },
    {
      name: "merged alternative writes allow a numerically disjoint later sibling",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 1 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: {
                  id: 1,
                  tags: { create: { id: 100 } },
                },
                update: { tags: { create: { id: 101 } } },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 102 },
                create: { id: 102 },
              },
            },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [{ id: 102 }] }],
        projects: [{ id: 1, tags: [{ id: 101 }] }],
        tags: [{ id: 101 }, { id: 102 }],
      },
    },
    {
      name: "upsert array merges a mismatched create identity before the next input",
      seed: (client) => client.workspace.create({ data: { id: 1 } }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: [
                {
                  where: { id: 100 },
                  create: { id: 101 },
                  update: {},
                },
                {
                  where: { id: 101 },
                  create: { id: 102 },
                  update: {},
                },
              ],
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'upsert' target write",
      expected: {
        workspaces: [{ id: 1, projects: [], tags: [] }],
        projects: [],
        tags: [],
      },
    },
    {
      name: "upsert array keeps the found branch membership on its selector",
      seed: (client) =>
        client.workspace.create({
          data: { id: 1, projects: { create: { id: 100 } } },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: [
                {
                  where: { id: 100 },
                  create: { id: 101 },
                  update: {},
                },
                {
                  where: { id: 100 },
                  create: { id: 102 },
                  update: {},
                },
              ],
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'upsert' membership write",
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 100 }], tags: [] }],
        projects: [{ id: 100, tags: [] }],
        tags: [],
      },
    },
  ];

async function dumpDeepTransitiveTargetDependency(
  client: SchemaClient<TransitiveTargetDependencySchema>
): Promise<PersistedState> {
  const [workspaces, projects, components, tags] = await Promise.all([
    client.workspace.findMany({
      orderBy: { id: "asc" },
      include: {
        projects: { orderBy: { id: "asc" } },
        tags: { orderBy: { id: "asc" } },
      },
    }),
    client.project.findMany({
      orderBy: { id: "asc" },
      include: { components: { orderBy: { id: "asc" } } },
    }),
    client.component.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { workspaces, projects, components, tags };
}

const DEEP_TRANSITIVE_TARGET_SEED: PersistedState = {
  workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [] }],
  projects: [{ id: 1, components: [{ id: 1 }] }],
  components: [{ id: 1, tags: [] }],
  tags: [],
};

const deepTransitiveTargetScenarios: Scenario<TransitiveTargetDependencySchema>[] =
  [
    {
      name: "deep nested update create then root decision rejects",
      seed: (client) =>
        client.workspace.create({
          data: {
            id: 1,
            projects: {
              create: { id: 1, components: { create: { id: 1 } } },
            },
          },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  components: {
                    update: {
                      where: { id: 1 },
                      data: { tags: { create: { id: 100 } } },
                    },
                  },
                },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100 },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'create' target write",
      expected: DEEP_TRANSITIVE_TARGET_SEED,
    },
    {
      name: "deep nested update create and disjoint root decision succeed",
      seed: (client) =>
        client.workspace.create({
          data: {
            id: 1,
            projects: {
              create: { id: 1, components: { create: { id: 1 } } },
            },
          },
        }),
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  components: {
                    update: {
                      where: { id: 1 },
                      data: { tags: { create: { id: 100 } } },
                    },
                  },
                },
              },
            },
            tags: {
              connectOrCreate: {
                where: { id: 101 },
                create: { id: 101 },
              },
            },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projects: [{ id: 1 }], tags: [{ id: 101 }] }],
        projects: [{ id: 1, components: [{ id: 1 }] }],
        components: [{ id: 1, tags: [{ id: 100 }] }],
        tags: [{ id: 100 }, { id: 101 }],
      },
    },
  ];

type TransitiveCreateManySchema = typeof transitiveCreateManySchema;

async function dumpTransitiveCreateMany(
  client: SchemaClient<TransitiveCreateManySchema>
): Promise<PersistedState> {
  const [owners, cohorts, items] = await Promise.all([
    client.owner.findMany({ orderBy: { id: "asc" } }),
    client.cohort.findMany({ orderBy: { id: "asc" } }),
    client.item.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { owners, cohorts, items };
}

const transitiveCreateManyScenarios: Scenario<TransitiveCreateManySchema>[] = [
  {
    name: "nested createMany then later decision rejects",
    seed: (client) =>
      client.owner.create({
        data: { id: 1, cohorts: { create: { id: 1 } } },
      }),
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          cohorts: {
            update: {
              where: { id: 1 },
              data: {
                createdItems: { createMany: { data: [{ id: 100 }] } },
              },
            },
          },
          selectedItems: {
            connectOrCreate: {
              where: { id: 100 },
              create: { id: 100 },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "depends on an earlier 'createMany' target write",
    expected: {
      owners: [{ id: 1 }],
      cohorts: [{ id: 1, ownerId: 1 }],
      items: [],
    },
  },
  {
    name: "nested createMany and disjoint later decision succeed",
    seed: (client) =>
      client.owner.create({
        data: { id: 1, cohorts: { create: { id: 1 } } },
      }),
    act: (client) =>
      client.owner.update({
        where: { id: 1 },
        data: {
          cohorts: {
            update: {
              where: { id: 1 },
              data: {
                createdItems: { createMany: { data: [{ id: 100 }] } },
              },
            },
          },
          selectedItems: {
            connectOrCreate: {
              where: { id: 101 },
              create: { id: 101 },
            },
          },
        },
      }),
    expected: {
      owners: [{ id: 1 }],
      cohorts: [{ id: 1, ownerId: 1 }],
      items: [
        { id: 100, groupId: 1 },
        { id: 101, groupId: null },
      ],
    },
  },
];

type TransitivePredicateDependencySchema =
  typeof transitivePredicateDependencySchema;

async function dumpTransitivePredicateDependency(
  client: SchemaClient<TransitivePredicateDependencySchema>
): Promise<PersistedState> {
  const [workspaces, projects, tags] = await Promise.all([
    client.workspace.findMany({
      orderBy: { id: "asc" },
      include: {
        projects: { orderBy: { id: "asc" } },
        tags: { orderBy: { id: "asc" } },
      },
    }),
    client.project.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
  ]);
  return {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      projectIds: workspace.projects.map((project) => project.id),
      tagIds: workspace.tags.map((tag) => tag.id),
    })),
    projects: projects.map((project) => ({
      id: project.id,
      tagIds: project.tags.map((tag) => tag.id),
    })),
    tags,
  };
}

async function seedTransitivePredicateDependency(
  client: SchemaClient<TransitivePredicateDependencySchema>
): Promise<void> {
  await client.workspace.create({ data: { id: 1 } });
  await client.project.create({ data: { id: 1 } });
  await client.tag.create({ data: { id: 100, label: "old" } });
  await client.workspace.update({
    where: { id: 1 },
    data: {
      projects: { connect: { id: 1 } },
      tags: { connect: { id: 100 } },
    },
  });
  await client.project.update({
    where: { id: 1 },
    data: { tags: { connect: { id: 100 } } },
  });
}

const TRANSITIVE_PREDICATE_SEED: PersistedState = {
  workspaces: [{ id: 1, projectIds: [1], tagIds: [100] }],
  projects: [{ id: 1, tagIds: [100] }],
  tags: [{ id: 100, label: "old" }],
};

const transitivePredicateDependencyScenarios: Scenario<TransitivePredicateDependencySchema>[] =
  [
    {
      name: "nested predicate update rejects a later overlapping root filter",
      seed: seedTransitivePredicateDependency,
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  tags: {
                    update: {
                      where: { id: 100 },
                      data: { label: "after" },
                    },
                  },
                },
              },
            },
            tags: { deleteMany: { label: "after" } },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'update' target write",
      expected: TRANSITIVE_PREDICATE_SEED,
    },
    {
      name: "nested predicate update allows a later identity-only root filter",
      seed: seedTransitivePredicateDependency,
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  tags: {
                    update: {
                      where: { id: 100 },
                      data: { label: "after" },
                    },
                  },
                },
              },
            },
            tags: { deleteMany: { id: 100 } },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projectIds: [1], tagIds: [] }],
        projects: [{ id: 1, tagIds: [] }],
        tags: [],
      },
    },
    {
      name: "nested predicate update allows a numerically disjoint root filter",
      seed: seedTransitivePredicateDependency,
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              update: {
                where: { id: 1 },
                data: {
                  tags: {
                    update: {
                      where: { id: 100 },
                      data: { label: "after" },
                    },
                  },
                },
              },
            },
            tags: { deleteMany: { id: 101, label: "after" } },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projectIds: [1], tagIds: [100] }],
        projects: [{ id: 1, tagIds: [100] }],
        tags: [{ id: 100, label: "after" }],
      },
    },
    {
      name: "upsert update alternative exports its predicate delta to a later filter",
      seed: seedTransitivePredicateDependency,
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: { id: 1 },
                update: {
                  tags: {
                    update: {
                      where: { id: 100 },
                      data: { label: "after" },
                    },
                  },
                },
              },
            },
            tags: { deleteMany: { label: "after" } },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'update' target write",
      expected: TRANSITIVE_PREDICATE_SEED,
    },
    {
      name: "upsert update alternative predicate delta ignores an id-only filter",
      seed: seedTransitivePredicateDependency,
      act: (client) =>
        client.workspace.update({
          where: { id: 1 },
          data: {
            projects: {
              upsert: {
                where: { id: 1 },
                create: { id: 1 },
                update: {
                  tags: {
                    update: {
                      where: { id: 100 },
                      data: { label: "after" },
                    },
                  },
                },
              },
            },
            tags: { deleteMany: { id: 100 } },
          },
        }),
      expected: {
        workspaces: [{ id: 1, projectIds: [1], tagIds: [] }],
        projects: [{ id: 1, tagIds: [] }],
        tags: [],
      },
    },
  ];

type TransitiveMembershipDependencySchema =
  typeof transitiveMembershipDependencySchema;

async function dumpTransitiveMembershipDependency(
  client: SchemaClient<TransitiveMembershipDependencySchema>
): Promise<PersistedState> {
  const records = await client.node.findMany({
    orderBy: { id: "asc" },
    include: {
      friends: { orderBy: { id: "asc" } },
      allies: { orderBy: { id: "asc" } },
    },
  });
  return {
    nodes: records.map((node) => ({
      id: node.id,
      label: node.label,
      parentId: node.parentId,
    })),
    friends: records.flatMap((node) =>
      node.friends.map((friend) => ({ sourceId: node.id, targetId: friend.id }))
    ),
    allies: records.flatMap((node) =>
      node.allies.map((ally) => ({ sourceId: node.id, targetId: ally.id }))
    ),
  };
}

const transitiveMembershipDependencyScenarios: Scenario<TransitiveMembershipDependencySchema>[] =
  [
    {
      name: "provably disjoint m2m connect and deleteMany execute together",
      seed: async (client) => {
        await client.node.create({ data: { id: 1, label: "one" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({ data: { id: 3, label: "three" } });
        await client.node.update({
          where: { id: 1 },
          data: { friends: { connect: { id: 3 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 1 },
          data: {
            friends: {
              connect: { id: 2 },
              deleteMany: { id: 3 },
            },
          },
        }),
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: null },
          { id: 2, label: "two", parentId: null },
        ],
        friends: [{ sourceId: 1, targetId: 2 }],
        allies: [],
      },
    },
    {
      name: "nested physical membership rejects a later same-edge root update",
      seed: async (client) => {
        await client.node.create({
          data: { id: 1, label: "one", parentId: 1 },
        });
        await client.node.create({ data: { id: 2, label: "two" } });
      },
      act: (client) =>
        client.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 1 },
                data: { friends: { connect: { id: 2 } } },
              },
            },
            friends: {
              update: { where: { id: 2 }, data: { label: "after" } },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'connect' membership write",
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 1 },
          { id: 2, label: "two", parentId: null },
        ],
        friends: [],
        allies: [],
      },
    },
    {
      name: "nested physical membership rejects a later same-edge root upsert",
      seed: async (client) => {
        await client.node.create({
          data: { id: 1, label: "one", parentId: 1 },
        });
        await client.node.create({ data: { id: 2, label: "two" } });
      },
      act: (client) =>
        client.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 1 },
                data: { friends: { connect: { id: 2 } } },
              },
            },
            friends: {
              upsert: {
                where: { id: 2 },
                create: { id: 2, label: "created" },
                update: { label: "after" },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'connect' membership write",
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 1 },
          { id: 2, label: "two", parentId: null },
        ],
        friends: [],
        allies: [],
      },
    },
    {
      name: "nested physical membership allows a disjoint target endpoint",
      seed: async (client) => {
        await client.node.create({
          data: { id: 1, label: "one", parentId: 1 },
        });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({ data: { id: 3, label: "three" } });
        await client.node.update({
          where: { id: 1 },
          data: { friends: { connect: { id: 3 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 1 },
                data: { friends: { connect: { id: 2 } } },
              },
            },
            friends: {
              update: { where: { id: 3 }, data: { label: "after" } },
            },
          },
        }),
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 1 },
          { id: 2, label: "two", parentId: null },
          { id: 3, label: "after", parentId: null },
        ],
        friends: [
          { sourceId: 1, targetId: 2 },
          { sourceId: 1, targetId: 3 },
        ],
        allies: [],
      },
    },
    {
      name: "nested physical membership allows a disjoint source endpoint",
      seed: async (client) => {
        await client.node.create({ data: { id: 1, label: "one" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 3, label: "three", parentId: 1 },
        });
        await client.node.update({
          where: { id: 1 },
          data: { friends: { connect: { id: 2 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 3 },
                data: { friends: { connect: { id: 2 } } },
              },
            },
            friends: {
              update: { where: { id: 2 }, data: { label: "after" } },
            },
          },
        }),
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: null },
          { id: 2, label: "after", parentId: null },
          { id: 3, label: "three", parentId: 1 },
        ],
        friends: [
          { sourceId: 1, targetId: 2 },
          { sourceId: 3, targetId: 2 },
        ],
        allies: [],
      },
    },
    {
      name: "nested physical membership stays isolated by named junction scope",
      seed: async (client) => {
        await client.node.create({
          data: { id: 1, label: "one", parentId: 1 },
        });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.update({
          where: { id: 1 },
          data: { allies: { connect: { id: 2 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 1 },
                data: { friends: { connect: { id: 2 } } },
              },
            },
            allies: {
              update: { where: { id: 2 }, data: { label: "after" } },
            },
          },
        }),
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 1 },
          { id: 2, label: "after", parentId: null },
        ],
        friends: [{ sourceId: 1, targetId: 2 }],
        allies: [{ sourceId: 1, targetId: 2 }],
      },
    },
    {
      name: "nested scalar FK rebind rejects a later inverse read of the same holder",
      seed: async (client) => {
        await client.node.create({ data: { id: 10, label: "root" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 1, label: "one", parentId: 10 },
        });
        await client.node.update({
          where: { id: 10 },
          data: { friends: { connect: { id: 1 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 10 },
          data: {
            friends: {
              update: { where: { id: 1 }, data: { parentId: 2 } },
            },
            children: {
              update: { where: { id: 1 }, data: { label: "after" } },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'update' membership write",
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 10 },
          { id: 2, label: "two", parentId: null },
          { id: 10, label: "root", parentId: null },
        ],
        friends: [{ sourceId: 10, targetId: 1 }],
        allies: [],
      },
    },
    {
      name: "nested scalar FK rebind rejects a later inverse upsert of the same holder",
      seed: async (client) => {
        await client.node.create({ data: { id: 10, label: "root" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 1, label: "one", parentId: 10 },
        });
        await client.node.update({
          where: { id: 10 },
          data: { friends: { connect: { id: 1 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 10 },
          data: {
            friends: {
              update: { where: { id: 1 }, data: { parentId: 2 } },
            },
            children: {
              upsert: {
                where: { id: 1 },
                create: { id: 1, label: "created" },
                update: { label: "after" },
              },
            },
          },
        }),
      expectReject: true,
      expectedError: "depends on an earlier 'update' membership write",
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 10 },
          { id: 2, label: "two", parentId: null },
          { id: 10, label: "root", parentId: null },
        ],
        friends: [{ sourceId: 10, targetId: 1 }],
        allies: [],
      },
    },
    {
      name: "nested scalar FK rebind allows a disjoint inverse holder",
      seed: async (client) => {
        await client.node.create({ data: { id: 10, label: "root" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 1, label: "one", parentId: 10 },
        });
        await client.node.create({
          data: { id: 3, label: "three", parentId: 10 },
        });
        await client.node.update({
          where: { id: 10 },
          data: { friends: { connect: { id: 1 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 10 },
          data: {
            friends: {
              update: { where: { id: 1 }, data: { parentId: 2 } },
            },
            children: {
              update: { where: { id: 3 }, data: { label: "after" } },
            },
          },
        }),
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 2 },
          { id: 2, label: "two", parentId: null },
          { id: 3, label: "after", parentId: 10 },
          { id: 10, label: "root", parentId: null },
        ],
        friends: [{ sourceId: 10, targetId: 1 }],
        allies: [],
      },
    },
    {
      name: "nested scalar FK rebind does not leak into a direct relation read",
      seed: async (client) => {
        await client.node.create({ data: { id: 1, label: "one" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 10, label: "root", parentId: 1 },
        });
        await client.node.update({
          where: { id: 1 },
          data: { parentId: 10 },
        });
        await client.node.update({
          where: { id: 10 },
          data: { friends: { connect: { id: 1 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 10 },
          data: {
            friends: {
              update: { where: { id: 1 }, data: { parentId: 2 } },
            },
            parent: { update: { label: "after" } },
          },
        }),
      expected: {
        nodes: [
          { id: 1, label: "after", parentId: 2 },
          { id: 2, label: "two", parentId: null },
          { id: 10, label: "root", parentId: 1 },
        ],
        friends: [{ sourceId: 10, targetId: 1 }],
        allies: [],
      },
    },
    {
      name: "nested identity transition exports the exact final membership source",
      seed: async (client) => {
        await client.node.create({ data: { id: 10, label: "root" } });
        await client.node.create({ data: { id: 2, label: "two" } });
        await client.node.create({
          data: { id: 1, label: "one", parentId: 10 },
        });
        await client.node.create({
          data: { id: 3, label: "three", parentId: 10 },
        });
        await client.node.update({
          where: { id: 3 },
          data: { friends: { connect: { id: 2 } } },
        });
      },
      act: (client) =>
        client.node.update({
          where: { id: 10 },
          data: {
            children: {
              update: [
                {
                  where: { id: 1 },
                  data: { id: 4, friends: { connect: { id: 2 } } },
                },
                {
                  where: { id: 3 },
                  data: {
                    friends: {
                      update: { where: { id: 2 }, data: { label: "after" } },
                    },
                  },
                },
              ],
            },
          },
        }),
      expected: {
        nodes: [
          { id: 2, label: "after", parentId: null },
          { id: 3, label: "three", parentId: 10 },
          { id: 4, label: "one", parentId: 10 },
          { id: 10, label: "root", parentId: null },
        ],
        friends: [
          { sourceId: 3, targetId: 2 },
          { sourceId: 4, targetId: 2 },
        ],
        allies: [],
      },
    },
  ];

type CreateRootFkDeclineSchema = typeof createRootFkDeclineSchema;

async function dumpCreateRootFkDecline(
  client: SchemaClient<CreateRootFkDeclineSchema>
): Promise<PersistedState> {
  const [users, profiles, notes] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.profile.findMany({ orderBy: { userId: "asc" } }),
    client.note.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, profiles, notes };
}

// T3c — the two create-root parent-held-FK declines, now absorbed and run natively.
// Each is a V1 accept-and-execute shape the pre-T3c census did not cover; adding them
// here makes the census machinery see them, so the final zero includes them.
const createRootFkDeclineScenarios: Scenario<CreateRootFkDeclineSchema>[] = [
  {
    name: "to-one connect by a non-referenced unique resolves through a lookup subquery",
    seed: (client) =>
      client.user.create({ data: { id: "u1", email: "a@x", name: "A" } }),
    act: (client) =>
      client.note.create({
        data: { id: "n1", text: "hi", author: { connect: { email: "a@x" } } },
      }),
    expected: {
      users: [{ id: "u1", email: "a@x", name: "A" }],
      profiles: [],
      notes: [{ id: "n1", text: "hi", userId: "u1" }],
    },
  },
  {
    name: "shared-primary-key parent-held connect sets the record PK from the fold",
    seed: (client) =>
      client.user.create({ data: { id: "u1", email: "a@x", name: "A" } }),
    act: (client) =>
      client.profile.create({
        data: { bio: "b", user: { connect: { id: "u1" } } },
      }),
    expected: {
      users: [{ id: "u1", email: "a@x", name: "A" }],
      profiles: [{ userId: "u1", bio: "b" }],
      notes: [],
    },
  },
  {
    name: "shared-primary-key parent-held create threads the literal target id to the record PK",
    act: (client) =>
      client.profile.create({
        data: {
          bio: "b2",
          user: { create: { id: "u2", email: "b@x", name: "B" } },
        },
      }),
    expected: {
      users: [{ id: "u2", email: "b@x", name: "B" }],
      profiles: [{ userId: "u2", bio: "b2" }],
      notes: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

registerGroup(
  "nested-write conformance: create-root FK declines (tx vs batch)",
  {
    schema: createRootFkDeclineSchema,
    dump: dumpCreateRootFkDecline,
    scenarios: createRootFkDeclineScenarios,
  }
);

registerGroup("nested-write conformance: FK relations (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: fkScenarios,
});

registerGroup("nested-write conformance: to-one ops (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: toOneScenarios,
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

registerGroup("nested-write conformance: create root barrier (tx vs batch)", {
  schema: createRootDependencySchema,
  dump: dumpCreateRootDependency,
  scenarios: createRootDependencyScenarios,
});

registerGroup("nested-write conformance: update predicate root (tx vs batch)", {
  schema: createRootDependencySchema,
  dump: dumpUpdatePredicateDependency,
  scenarios: updatePredicateScenarios,
});

registerGroup(
  "nested-write conformance: update membership root (tx vs batch)",
  {
    schema: membershipDependencySchema,
    dump: dumpMembershipDependency,
    scenarios: membershipDependencyScenarios,
  }
);

registerGroup(
  "nested-write conformance: own-write dependencies (tx vs batch)",
  {
    schema: numericDependencySchema,
    dump: dumpNumericDependency,
    scenarios: numericDependencyScenarios,
  }
);

registerGroup(
  "nested-write conformance: cross-relation targets (tx vs batch)",
  {
    schema: crossRelationTargetSchema,
    dump: dumpCrossRelationTarget,
    scenarios: crossRelationTargetScenarios,
  }
);

registerGroup("nested-write conformance: named m2m targets (tx vs batch)", {
  schema: manyToManySchema,
  dump: dumpNamedM2m,
  scenarios: namedM2mTargetScenarios,
});

registerGroup("nested-write conformance: cross-step dependency (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: crossStepScenarios,
});

registerGroup(
  "nested-write conformance: transitive target dependencies (tx vs batch)",
  {
    schema: transitiveTargetDependencySchema,
    dump: dumpTransitiveTargetDependency,
    scenarios: transitiveTargetDependencyScenarios,
  }
);

registerGroup(
  "nested-write conformance: alternative branch dependencies (tx vs batch)",
  {
    schema: transitiveTargetDependencySchema,
    dump: dumpTransitiveTargetDependency,
    scenarios: alternativeBranchDependencyScenarios,
  }
);

registerGroup(
  "nested-write conformance: deep transitive target dependencies (tx vs batch)",
  {
    schema: transitiveTargetDependencySchema,
    dump: dumpDeepTransitiveTargetDependency,
    scenarios: deepTransitiveTargetScenarios,
  }
);

registerGroup(
  "nested-write conformance: transitive createMany dependencies (tx vs batch)",
  {
    schema: transitiveCreateManySchema,
    dump: dumpTransitiveCreateMany,
    scenarios: transitiveCreateManyScenarios,
  }
);

registerGroup(
  "nested-write conformance: transitive predicate dependencies (tx vs batch)",
  {
    schema: transitivePredicateDependencySchema,
    dump: dumpTransitivePredicateDependency,
    scenarios: transitivePredicateDependencyScenarios,
  }
);

registerGroup(
  "nested-write conformance: transitive membership dependencies (tx vs batch)",
  {
    schema: transitiveMembershipDependencySchema,
    dump: dumpTransitiveMembershipDependency,
    scenarios: transitiveMembershipDependencyScenarios,
  }
);
