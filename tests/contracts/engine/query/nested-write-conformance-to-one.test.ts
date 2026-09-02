// Nested-write conformance: to-one edge slice.
//
// Every group here exercises a to-one edge: the to-one relation ops on
// `nestedWriteBehaviorSchema`, the create-root parent-held-FK declines, the D4
// non-PK reference column, and the self-referential parent-holds-FK create.
// Split out of the original single-file oracle so one process boots fewer
// PGlite databases; the shared two-substrate harness lives in
// `nested-write-conformance-fixtures`.

import { s } from "@schema";
import {
  dumpNestedWrite,
  type NestedWriteSchema,
  type PersistedState,
  registerGroup,
  type Scenario,
  type SchemaClient,
} from "@tests/contracts/engine/query/nested-write-conformance-fixtures";
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
      members: s.toMany(() => member),
    })
    .map("conformance_d4_orgs");

  const member = s
    .model({
      id: s.string().id(),
      orgCode: s.string().nullable(),
      org: s
        .toOne(() => org)
        .fields("orgCode")
        .references("code"),
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
        .toOne(() => category)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => category),
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
      profile: s.toOne(() => profile),
      notes: s.toMany(() => note),
    })
    .map("conformance_crd_users");

  const profile = s
    .model({
      userId: s.string().id(),
      bio: s.string(),
      user: s
        .toOne(() => user)
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
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("conformance_crd_notes");

  return { user, profile, note };
})();

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

registerGroup("nested-write conformance: to-one ops (tx vs batch)", {
  schema: nestedWriteBehaviorSchema,
  dump: dumpNestedWrite,
  scenarios: toOneScenarios,
});

registerGroup(
  "nested-write conformance: create-root FK declines (tx vs batch)",
  {
    schema: createRootFkDeclineSchema,
    dump: dumpCreateRootFkDecline,
    scenarios: createRootFkDeclineScenarios,
  }
);

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
