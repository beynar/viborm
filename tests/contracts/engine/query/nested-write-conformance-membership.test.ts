// Nested-write conformance: membership dependency slice.
//
// The update-family membership root runs on `membershipDependencySchema`; the
// transitive membership barriers run on `transitiveMembershipDependencySchema`.
// Both pin when a physical membership write blocks a later same-edge decision.
// Split out of the original single-file oracle so one process boots fewer
// PGlite databases; the shared two-substrate harness lives in
// `nested-write-conformance-fixtures`.

import { s } from "@schema";
import {
  type PersistedState,
  registerGroup,
  type Scenario,
  type SchemaClient,
} from "@tests/contracts/engine/query/nested-write-conformance-fixtures";

const membershipDependencySchema = (() => {
  const container = s
    .model({
      id: s.int().id(),
      nodes: s.toMany(() => node),
    })
    .map("conformance_membership_containers");

  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      containerId: s.int().nullable(),
      container: s
        .toOne(() => container)
        .fields("containerId")
        .references("id")
        .onUpdate("cascade"),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("parent"),
      children: s.toMany(() => node).name("parent"),
      partnerId: s.int().unique().nullable(),
      partner: s
        .toOne(() => node)
        .fields("partnerId")
        .references("id")
        .name("partner"),
      partnerOf: s.toOne(() => node).name("partner"),
    })
    .map("conformance_membership_nodes");

  return { container, node };
})();

const transitiveMembershipDependencySchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("membershipParent"),
      children: s.toMany(() => node).name("membershipParent"),
      friends: s
        .toMany(() => node)
        .name("membershipFriends")
        .source("friendSourceId")
        .target("friendTargetId"),
      friendedBy: s.toMany(() => node).name("membershipFriends"),
      allies: s
        .toMany(() => node)
        .name("membershipAllies")
        .source("allySourceId")
        .target("allyTargetId"),
      alliedBy: s.toMany(() => node).name("membershipAllies"),
    })
    .map("conformance_transitive_membership_nodes");

  return { node };
})();

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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'create'
    // membership write"); now both partner writes execute in relation
    // declaration order. `container` runs before `children`, so the cross-scope
    // upsert observes node 1's empty partner slot and creates node 3 in it; the
    // nested create of node 2 then claims the same unique slot, and the
    // database's integrity answer is the operation's failure.
    name: "nested create membership collides with the earlier cross-scope to-one upsert on the unique partner slot",
    seed: seedCrossScopeMembershipBase,
    act: (client) => runCrossScopeMembershipMutation(client, "create", 1),
    expectReject: true,
    expectedError: "Unique constraint violation",
    expected: CROSS_SCOPE_MEMBERSHIP_BASE,
  },
  {
    name: "nested create membership allows a disjoint cross-scope to-one upsert",
    seed: seedCrossScopeMembershipBase,
    act: (client) => runCrossScopeMembershipMutation(client, "create", 4),
    expected: CROSS_SCOPE_MEMBERSHIP_DISJOINT,
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier
    // 'connectOrCreate' membership write"); now the earlier cross-scope upsert
    // creates node 3 in node 1's unique partner slot, the connectOrCreate finds
    // node 2 and rebinds it onto that same slot, and the unique constraint is
    // the operation's failure.
    name: "connectOrCreate membership collides with the earlier cross-scope to-one upsert on the unique partner slot",
    seed: seedCrossScopeMembershipWithTarget,
    act: (client) =>
      runCrossScopeMembershipMutation(client, "connectOrCreate", 1),
    expectReject: true,
    expectedError: "Unique constraint violation",
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'connect'
    // membership write"); now the earlier cross-scope upsert creates node 3 in
    // node 1's unique partner slot and the connect rebinds node 2 onto the same
    // slot, so the unique constraint is the operation's failure.
    name: "found connect membership collides with the earlier cross-scope to-one upsert on the unique partner slot",
    seed: seedCrossScopeMembershipWithTarget,
    act: (client) => runCrossScopeMembershipMutation(client, "connect", 1),
    expectReject: true,
    expectedError: "Unique constraint violation",
    expected: CROSS_SCOPE_MEMBERSHIP_WITH_TARGET,
  },
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // membership write"); now the inverse slot is observed after node 1's own
    // write of its partner FK — the self-held key that carries the membership —
    // which empties the slot, so the upsert takes its create branch and node 3
    // lands where the move vacated.
    name: "self to-one inverse upsert creates into the slot the current-row FK membership move vacated",
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
          label: "two",
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // membership write"); now the inverse membership is observed after node 1's
    // own write of its parent FK, where node 1 is no longer its own child, so
    // the relation body's own correlated refusal answers on both routes and
    // nothing commits.
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
    expectedError:
      "Cannot update relation 'children': target record was not found for this parent.",
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // membership write"); now the inverse observation is taken after the
    // child's own write, where node 1's partner slot is vacated, so the upsert
    // takes its create branch and node 3 fills the slot the rebind left.
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
    expected: {
      containers: [{ id: 10 }],
      nodes: [
        {
          id: 1,
          label: "one",
          containerId: 10,
          parentId: null,
          partnerId: 2,
        },
        {
          id: 2,
          label: "two",
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
  {
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // membership write"); now the parent-held `container` choice names the
    // container node 1 references AFTER its own write, and its subtree reads
    // the membership that same write moves, so the whole choice runs behind the
    // UPDATE: the descent finds node 1 in container 20 and renames it.
    name: "same-node non-self FK rebind descends into the final target's inverse membership",
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
    expected: {
      containers: [{ id: 10 }, { id: 20 }],
      nodes: [
        {
          id: 1,
          label: "after",
          containerId: 20,
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
    // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
    // membership write"); now both members execute in relation declaration
    // order. `container` is declared before `children`, so the inverse read
    // observes node 1 still in container 10 and the rebind follows it.
    name: "non-self nested FK rebind follows the inverse read of the same holder",
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
    expected: {
      containers: [{ id: 10 }, { id: 20 }],
      nodes: [
        {
          id: 1,
          label: "after",
          containerId: 20,
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
      // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'connect'
      // membership write"); now the root's `friends` lookup is an ordered
      // observation of the junction behind the link the earlier `children`
      // subtree made on it (`children` is declared before `friends`), so it
      // finds node 2 a member and the update renames it.
      name: "nested physical membership carries into a later same-edge root update",
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
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 1 },
          { id: 2, label: "after", parentId: null },
        ],
        friends: [{ sourceId: 1, targetId: 2 }],
        allies: [],
      },
    },
    {
      // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'connect'
      // membership write"); now the root's `friends` upsert observes the
      // junction behind the earlier `children` subtree's link on it, finds node
      // 2 inside the membership, and takes its found branch.
      name: "nested physical membership carries into a later same-edge root upsert",
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
      expected: {
        nodes: [
          { id: 1, label: "one", parentId: 1 },
          { id: 2, label: "after", parentId: null },
        ],
        friends: [{ sourceId: 1, targetId: 2 }],
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
      // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
      // membership write"); `children` is declared before `friends`, so the
      // inverse read observes node 1 still under parent 10 and the friend
      // update rebinds it afterwards.
      name: "nested scalar FK rebind follows the inverse read of the same holder",
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
      expected: {
        nodes: [
          { id: 1, label: "after", parentId: 2 },
          { id: 2, label: "two", parentId: null },
          { id: 10, label: "root", parentId: null },
        ],
        friends: [{ sourceId: 10, targetId: 1 }],
        allies: [],
      },
    },
    {
      // N1 (D-51): pinned DESIGN §6.2's veto ("depends on an earlier 'update'
      // membership write"); `children` is declared before `friends`, so the
      // upsert observes node 1 still under parent 10 and takes its found
      // branch, and the friend update rebinds the parent afterwards.
      name: "nested scalar FK rebind follows the inverse upsert of the same holder",
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
      expected: {
        nodes: [
          { id: 1, label: "after", parentId: 2 },
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

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

registerGroup(
  "nested-write conformance: update membership root (tx vs batch)",
  {
    schema: membershipDependencySchema,
    dump: dumpMembershipDependency,
    scenarios: membershipDependencyScenarios,
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
