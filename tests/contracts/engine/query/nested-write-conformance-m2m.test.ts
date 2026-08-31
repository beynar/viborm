// Nested-write conformance: many-to-many slice.
//
// Every group here runs on `manyToManySchema` — the post *—* tag junction, the
// self-referential user *—* user junction, and the named alpha/beta junctions.
// Split out of the original single-file oracle so one process boots fewer
// PGlite databases; the shared two-substrate harness lives in
// `nested-write-conformance-fixtures`.

import {
  type PersistedState,
  registerGroup,
  type Scenario,
  type SchemaClient,
} from "@tests/contracts/engine/query/nested-write-conformance-fixtures";
import { manyToManySchema } from "@tests/fixtures/many-to-many-schema";

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
// Registration.
// ---------------------------------------------------------------------------

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

registerGroup("nested-write conformance: named m2m targets (tx vs batch)", {
  schema: manyToManySchema,
  dump: dumpNamedM2m,
  scenarios: namedM2mTargetScenarios,
});
