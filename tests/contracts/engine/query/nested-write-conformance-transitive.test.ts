// Nested-write conformance: transitive target-dependency slice.
//
// Every group here follows a target-row write as it propagates beyond the
// relation that made it: across sibling relation fields
// (`crossRelationTargetSchema`), down a nested chain and through upsert
// alternatives (`transitiveTargetDependencySchema`), through a nested
// createMany (`transitiveCreateManySchema`), and into a later predicate
// (`transitivePredicateDependencySchema`). Split out of the original
// single-file oracle so one process boots fewer PGlite databases; the shared
// two-substrate harness lives in `nested-write-conformance-fixtures`.

import { s } from "@schema";
import {
  type PersistedState,
  registerGroup,
  type Scenario,
  type SchemaClient,
} from "@tests/contracts/engine/query/nested-write-conformance-fixtures";

const crossRelationTargetSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.toMany(() => record).name("primary"),
      secondaryRecords: s.toMany(() => record).name("secondary"),
    })
    .map("conformance_cross_target_accounts");

  const record = s
    .model({
      id: s.int().id(),
      primaryId: s.int().nullable(),
      secondaryId: s.int().nullable(),
      primary: s
        .toOne(() => account)
        .fields("primaryId")
        .references("id")
        .name("primary"),
      secondary: s
        .toOne(() => account)
        .fields("secondaryId")
        .references("id")
        .name("secondary"),
    })
    .map("conformance_cross_target_records");

  return { account, record };
})();

const transitiveTargetDependencySchema = (() => {
  const workspace = s
    .model({
      id: s.int().id(),
      projects: s.toMany(() => project).name("workspaceProjects"),
      tags: s.toMany(() => tag).name("workspaceTags"),
    })
    .map("conformance_transitive_workspaces");

  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.toMany(() => workspace).name("workspaceProjects"),
      tags: s.toMany(() => tag).name("projectTags"),
      components: s.toMany(() => component).name("projectComponents"),
    })
    .map("conformance_transitive_projects");

  const tag = s
    .model({
      id: s.int().id(),
      workspaces: s.toMany(() => workspace).name("workspaceTags"),
      projects: s.toMany(() => project).name("projectTags"),
      components: s.toMany(() => component).name("componentTags"),
    })
    .map("conformance_transitive_tags");

  const component = s
    .model({
      id: s.int().id(),
      projects: s.toMany(() => project).name("projectComponents"),
      tags: s.toMany(() => tag).name("componentTags"),
    })
    .map("conformance_transitive_components");

  return { workspace, project, tag, component };
})();

const transitiveCreateManySchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      cohorts: s.toMany(() => cohort),
      selectedItems: s.toMany(() => item).name("selectedItems"),
    })
    .map("conformance_transitive_create_many_owners");

  const item = s
    .model({
      id: s.int().id(),
      groupId: s.int().nullable(),
      creator: s
        .toOne(() => cohort)
        .fields("groupId")
        .references("id")
        .name("createdItems"),
      selectedBy: s.toMany(() => owner).name("selectedItems"),
    })
    .map("conformance_transitive_create_many_items");

  const cohort = s
    .model({
      id: s.int().id(),
      ownerId: s.int().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      createdItems: s.toMany(() => item).name("createdItems"),
    })
    .map("conformance_transitive_create_many_groups");

  return { owner, cohort, item };
})();

const transitivePredicateDependencySchema = (() => {
  const workspace = s
    .model({
      id: s.int().id(),
      projects: s.toMany(() => project).name("predicateProjects"),
      tags: s.toMany(() => tag).name("predicateWorkspaceTags"),
    })
    .map("conformance_transitive_predicate_workspaces");

  const project = s
    .model({
      id: s.int().id(),
      workspaces: s.toMany(() => workspace).name("predicateProjects"),
      tags: s.toMany(() => tag).name("predicateProjectTags"),
    })
    .map("conformance_transitive_predicate_projects");

  const tag = s
    .model({
      id: s.int().id(),
      label: s.string(),
      workspaces: s.toMany(() => workspace).name("predicateWorkspaceTags"),
      projects: s.toMany(() => project).name("predicateProjectTags"),
    })
    .map("conformance_transitive_predicate_tags");

  return { workspace, project, tag };
})();

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
            // @ts-expect-error - to-one payloads accept one active operation
            connect: { id: 2 },
          },
        },
      }),
    expectReject: true,
    expectedError: "Unsupported to-one operation combination",
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

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

registerGroup(
  "nested-write conformance: cross-relation targets (tx vs batch)",
  {
    schema: crossRelationTargetSchema,
    dump: dumpCrossRelationTarget,
    scenarios: crossRelationTargetScenarios,
  }
);

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
