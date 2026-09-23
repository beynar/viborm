// Nested-write conformance: root-scope dependency slice.
//
// The create-family root barrier and the update-family predicate root run on
// `createRootDependencySchema`; the same-relation own-write decisions run on
// `numericDependencySchema`. Both ask the same question — when does the root
// row's own write enter the dependency ledger. Split out of the original
// single-file oracle so one process boots fewer PGlite databases; the shared
// two-substrate harness lives in `nested-write-conformance-fixtures`.

import { s } from "@schema";
import {
  type PersistedState,
  registerGroup,
  type Scenario,
  type SchemaClient,
} from "@tests/contracts/engine/query/nested-write-conformance-fixtures";

const createRootDependencySchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("tree"),
      children: s.toMany(() => node).name("tree"),
      links: s
        .toMany(() => node)
        .name("link")
        .source("sourceId")
        .target("targetId"),
      linkedBy: s.toMany(() => node).name("link"),
    })
    .map("conformance_create_root_nodes");

  return { node };
})();

const numericDependencySchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string(),
      items: s.toMany(() => item),
      profile: s.toOne(() => profile),
    })
    .map("conformance_dependency_owners");

  const item = s
    .model({
      id: s.int().id(),
      label: s.string(),
      ownerId: s.int().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("conformance_dependency_items");

  const profile = s
    .model({
      id: s.int().id(),
      bio: s.string(),
      ownerId: s.int().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("conformance_dependency_profiles");

  return { owner, item, profile };
})();

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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'create'
    // target write"); now the after-parent lookup is an ordered observation
    // taken after the root's own insert, so it finds the row that insert made.
    name: "after-parent self connectOrCreate observes the current insert",
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
    expected: { nodes: [{ id: 1, label: "root", parentId: 1 }] },
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
    // N1 (D-51): pinned the retired engine's lax "target record was not found".
    // `parent` is parent-held, so the root's OWN insert CONSUMES this lookup
    // while being the only producer of its target — the one shape no order
    // satisfies — and it keeps the inherited dependency sentence
    // (`AGENTS.md`, "A dependent read is an ordered observation (N1, D-51)").
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
    expectedError:
      "Nested operation 'connect' on relation 'parent' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.",
    expected: { nodes: [] },
  },
  {
    // N1 (D-51) / D-52: pinned the retired engine's lax "target record was not
    // found". The enclosing `children` edge assigns the nested row
    // `parentId = 10` and its own `parent: { connect: { id: 1 } }` assigns
    // `parentId = 1`: two final assignments for one column, a membership fact
    // no placement can satisfy, so the refusal is kept and answers at
    // assignment composition, ahead of any dependency question.
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
    expectedError:
      "query-engine-v2 create has conflicting final assignments for column 'parentId' on relation 'parent'.",
    expected: { nodes: [] },
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'create'
    // target write"); now the create branch executes and its after-parent
    // lookup observes the insert that branch just made.
    name: "missing top-level upsert observes its create-branch insert",
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
    expected: { nodes: [{ id: 1, label: "root", parentId: 1 }] },
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

const updatePredicateScenarios: Scenario<CreateRootDependencySchema>[] = [
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // target write"); now the m2m lookup is an ordered observation taken after
    // the root's own id transition, which left the old id free, so the
    // connectOrCreate takes its create arm.
    name: "root id transition frees the old id for a later self decision",
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
    expected: {
      nodes: [
        { id: 1, label: "old", parentId: null },
        { id: 2, label: "root", parentId: null },
      ],
      links: [{ sourceId: 2, targetIds: [1] }],
    },
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // target write"); now the observation after the id transition finds the
    // root under its new id, so the connectOrCreate links the root to itself.
    name: "root id transition is observed under its new id by a later self decision",
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
    expected: {
      nodes: [{ id: 2, label: "root", parentId: null }],
      links: [{ sourceId: 2, targetIds: [2] }],
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // target write"); now the junction capture moves behind the root's own
    // update, so the filter matches the label that update just wrote and the
    // deleteMany removes the row — which is the root itself on this self edge.
    name: "payload update is observed by a recursive m2m deleteMany filter",
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
    expected: { nodes: [], links: [] },
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // target write"); now the child's m2m lookup is observed after the child's
    // own id transition, which left the old selector free to be created.
    name: "nested to-many update frees its old selector inside the child",
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
    expected: {
      nodes: [
        { id: 1, label: "old", parentId: null },
        { id: 2, label: "child", parentId: 10 },
        { id: 10, label: "parent", parentId: null },
      ],
      links: [{ sourceId: 2, targetIds: [1] }],
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // target write"); now the child identity transition executes and the
    // root's own parentId, assigned before it, still names the old id — the
    // database's foreign key answers (rule 5), and nothing commits.
    name: "nested to-one update executes its child identity transition: the foreign key answers",
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
    expectedError: "Foreign key constraint violation",
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

// ---------------------------------------------------------------------------
// Group 6: same-relation own-write decisions over numeric identities. Unequal
// integers are the portable disjoint control; an overlapping target or
// membership is an ordered observation taken after the write it overlaps
// (N1, D-51), so the members run in the body's canonical verb order and the
// last one has the last word — a refusal here names an execution fact (a
// target absent at its observation, a combination admission refuses).
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
            // @ts-expect-error - not an executable replacement pair
            upsert: {
              create: { id: 2, bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "Unsupported to-one operation combination",
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
            // @ts-expect-error - not an executable replacement pair
            upsert: {
              create: { id: 2, bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "Unsupported to-one operation combination",
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [],
      profiles: [{ id: 1, bio: "before", ownerId: 1 }],
    },
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier" write);
    // now `delete` runs before `set` in the collection order, and the set's
    // target lookup — which shares the set's origin and lands ahead of the
    // set's own clear — is an ordered observation taken after that delete,
    // so it finds no row and the relation body raises its own correlated
    // refusal. Nothing commits on either substrate: the observation's
    // required row rides its batch as a premise ahead of the projection.
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
    expectedError: "Cannot set relation 'items': target record was not found.",
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "before", ownerId: 1 }],
      profiles: [],
    },
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier"); now the
    // two members run in series and the second observes the first's write, so
    // the last member has the last word.
    name: "overlapping update array applies both members in order",
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
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "second", ownerId: 1 }],
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier"); now both
    // members run in series, each upsert observing the previous write, so both
    // find the row and the last update has the last word.
    name: "overlapping upsert array applies both members in order",
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
    expected: {
      owners: [{ id: 1, name: "Owner" }],
      items: [{ id: 1, label: "second", ownerId: 1 }],
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
            // N1 — the modify is a plain scalar assignment. It used to be
            // `{ ownerId: null }`, which the parse boundary now refuses on its own
            // (the relation owns that column), so the case would no longer reach the
            // composition rule it exists to measure.
            update: { bio: "mutated" },
            // @ts-expect-error - a mutator cannot compose with upsert
            upsert: {
              create: { id: 2, bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      }),
    expectReject: true,
    expectedError: "Unsupported to-one operation combination",
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
// Registration.
// ---------------------------------------------------------------------------

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
  "nested-write conformance: own-write dependencies (tx vs batch)",
  {
    schema: numericDependencySchema,
    dump: dumpNumericDependency,
    scenarios: numericDependencyScenarios,
  }
);
