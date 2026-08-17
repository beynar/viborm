import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

// A concurrent writer fires once, just before the atomic batch commits.
class BeforeBatchDriver extends BatchOnlyPGliteDriver {
  private hook: (() => Promise<void>) | undefined;
  constructor(
    hook: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.hook = hook;
  }
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.hook;
    // Fire before the operation's compiled ATOMIC UNIT, not the first batch of
    // any kind: planning reads ride a batch too once grouped by level (PLAN
    // Phase 6.1).
    if (hook && batchIsAtomicUnit(queries)) {
      this.hook = undefined;
      await hook();
    }
    return super.executeBatch<T>(client, queries);
  }
}

const NOT_FOUND_FOR_PARENT = /target record was not found for this parent/;

type Schema = Record<string, ReturnType<typeof s.model>>;

function makeClient(schema: Schema, db: PGlite) {
  return createClient({
    schema: schema as never,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeClient>;

async function runObserved(
  schema: Schema,
  substrate: "tx" | "batch",
  seed: (c: AnyClient) => Promise<void>,
  op: (c: Record<string, any>) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<{ state: unknown; engines: Set<"direct" | "production"> }> {
  const db = new PGlite();
  const base = makeClient(schema, db);
  await push(base as never, { force: true });
  await seed(base);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const observed = observeClientOperations({
    schema: schema as never,
    driver,
  });
  await op(observed.client);
  const state = await snap(base);
  await base.$disconnect();
  return {
    state,
    engines: new Set(observed.operations.map((r) => r.boundary)),
  };
}

// ---------------------------------------------------------------------------
// A four-model chain org → team → member → badge. The `badge` PK is
// DATABASE-GENERATED (the insertId / RETURNING leg). The located target three located
// updates deep (member) carries `badge: { create }` — a parent-held to-one whose id
// must fold into the located member's OWN update SET (child-SET folding at depth).
// ---------------------------------------------------------------------------
const chainSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("x1c_org");
  const team = s
    .model({
      id: s.string().id(),
      name: s.string(),
      orgId: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .optional(),
      members: s.oneToMany(() => member),
    })
    .map("x1c_team");
  const badge = s
    .model({
      id: s.int().id().increment(),
      code: s.string(),
      members: s.oneToMany(() => member),
    })
    .map("x1c_badge");
  const member = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teamId: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("teamId")
        .references("id")
        .optional(),
      badgeId: s.int().nullable(),
      badge: s
        .manyToOne(() => badge)
        .fields("badgeId")
        .references("id")
        .optional(),
    })
    .map("x1c_member");
  return { org, team, badge, member };
})();

describe("X1c — parent-held to-one under a located update target at level 3 (generated PK)", () => {
  // Two disjoint chains (o1/t1/m1 touched, o2/t2/m2 disjoint) plus a sibling member m1s
  // under t1 that must stay untouched (the wrong-row witness).
  const seed = async (c: AnyClient) => {
    const client = c as any;
    const chain = async (o: string, t: string, m: string) => {
      await client.org.create({ data: { id: o, name: o } });
      await client.team.create({ data: { id: t, name: t, orgId: o } });
      await client.member.create({ data: { id: m, name: m, teamId: t } });
    };
    await chain("o1", "t1", "m1");
    await chain("o2", "t2", "m2");
    await client.member.create({
      data: { id: "m1s", name: "m1s", teamId: "t1" },
    });
    await client.badge.create({ data: { code: "SEED" } }); // id 1 (disjoint witness)
  };

  // The located member m1 (three located updates deep) folds a fresh badge (generated
  // id 2) into its OWN update SET; m1's name is rewritten in that same SET.
  const op = async (c: Record<string, any>, badgeId?: number) => {
    await c.org.update({
      where: { id: "o1" },
      data: {
        teams: {
          update: {
            where: { id: "t1" },
            data: {
              members: {
                update: {
                  where: { id: "m1" },
                  data: {
                    name: "m1b",
                    badge: {
                      create:
                        badgeId === undefined
                          ? { code: "B" }
                          : { id: badgeId, code: "B" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  };

  const snap = async (c: AnyClient) => {
    const members = await (c as any).member.findMany({
      orderBy: { id: "asc" },
    });
    const badges = await (c as any).badge.findMany({ orderBy: { id: "asc" } });
    return {
      members: members.map((m: any) => [m.id, m.name, m.badgeId]),
      badges: badges.map((b: any) => [b.id, b.code]),
    };
  };

  // m1 gets name "m1b" and badgeId 2 (the fresh badge). Everything else untouched.
  const expected = {
    members: [
      ["m1", "m1b", 2],
      ["m1s", "m1s", null],
      ["m2", "m2", null],
    ],
    badges: [
      [1, "SEED"],
      [2, "B"],
    ],
  };

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: the generated badge id folds into the level-3 member SET, native Observed`, async () => {
      const { state, engines } = await runObserved(
        chainSchema,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }

  // WRONG-ROW / cross-parent falsification: the deepest located update names m1s (a
  // SIBLING of m1 under t1) as if it were a member of t2 — it is not, so the correlated
  // locate finds no row and the whole tree rejects with Direct's verbatim not-found; no
  // partial write, no badge created.
  test("cross-parent selector at depth rejects with the located-target not-found", async () => {
    const db = new PGlite();
    const base = makeClient(chainSchema, db);
    await push(base as never, { force: true });
    await seed(base);
    const observed = observeClientOperations({
      schema: chainSchema as never,
      driver: new PGliteDriver({ client: db }),
    });
    // m1s is a member of t1, not t2 — so `o2.teams.update(t2).members.update(m1s)` is
    // cross-parent (t2 has no member m1s).
    await expect(
      (observed.client as any).org.update({
        where: { id: "o2" },
        data: {
          teams: {
            update: {
              where: { id: "t2" },
              data: {
                members: {
                  update: {
                    where: { id: "m1s" },
                    data: { name: "HACK", badge: { create: { code: "X" } } },
                  },
                },
              },
            },
          },
        },
      })
    ).rejects.toThrow(NOT_FOUND_FOR_PARENT);
    // Nothing changed: m1s keeps its name/FK, no badge beyond the seed.
    const m1s = await (base as any).member.findUnique({ where: { id: "m1s" } });
    expect([m1s.name, m1s.badgeId]).toEqual(["m1s", null]);
    expect(await (base as any).badge.findMany()).toHaveLength(1);
    await base.$disconnect();
  });

  // STALENESS pin: a concurrent writer deletes the located target (m1) between the
  // unlocked planning locate and the atomic batch. The nested target's split-witness
  // presence guard fails the batch closed — never a silent no-op, never a dangling
  // badge whose member vanished.
  test("batch: a concurrent delete of the located target fails the batch closed", async () => {
    const db = new PGlite();
    const base = makeClient(chainSchema, db);
    await push(base as never, { force: true });
    await seed(base);
    const driver = new BeforeBatchDriver(
      async () => {
        await (base as any).member.deleteMany({ where: { id: "m1" } });
      },
      { client: db }
    );
    const observed = observeClientOperations({
      schema: chainSchema as never,
      driver,
    });
    await expect(op(observed.client, -1)).rejects.toThrow();
    // m1 is gone (the concurrent writer removed it); crucially, no orphan badge got
    // written under it — the guard aborted the whole atomic unit.
    expect(
      await (base as any).member.findMany({ where: { id: "m1" } })
    ).toHaveLength(0);
    expect(await (base as any).badge.findMany()).toHaveLength(1);
    await base.$disconnect();
  }, 45_000);
});

// ---------------------------------------------------------------------------
// D4 at depth — a located UPDATE target whose CHILD-HELD edge references a NON-PK
// unique of the target (an `update` edge, not a create): the located row's non-PK
// referenced column is threaded from the delegated locate read (`locateFields`), the
// update-root's own D4 mechanism, now byte-identical one level deeper.
// ---------------------------------------------------------------------------
const d4Tree = (() => {
  const company = s
    .model({ id: s.int().id(), name: s.string(), orgs: s.oneToMany(() => org) })
    .map("x1c_d4_company");
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      code: s.string().unique(),
      companyId: s.int().nullable(),
      company: s
        .manyToOne(() => company)
        .fields("companyId")
        .references("id")
        .optional(),
      members: s.oneToMany(() => member),
    })
    .map("x1c_d4_org");
  const member = s
    .model({
      id: s.string().id(),
      label: s.string(),
      orgCode: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgCode")
        .references("code")
        .optional(),
    })
    .map("x1c_d4_member");
  return { company, org, member };
})();

describe("X1c — D4 at depth: a located target's non-PK-referenced child UPDATE edge", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.company.create({ data: { id: 1, name: "co" } });
    await client.org.create({
      data: { id: "o1", name: "o1", code: "OLD", companyId: 1 },
    });
    await client.org.create({
      data: { id: "o2", name: "o2", code: "OTHER", companyId: 1 },
    });
    // Members referencing org.code (a non-PK unique).
    await client.member.create({
      data: { id: "m1", label: "m1", orgCode: "OLD" },
    });
    await client.member.create({
      data: { id: "mx", label: "mx", orgCode: "OTHER" },
    });
  };

  // The located org o1 UPDATEs one of its members (correlated by member.orgCode =
  // org.code, a NON-PK reference threaded from the located row); mx (under o2) untouched.
  const op = async (c: Record<string, any>) => {
    await c.company.update({
      where: { id: 1 },
      data: {
        orgs: {
          update: {
            where: { id: "o1" },
            data: {
              name: "o1b",
              members: {
                update: { where: { id: "m1" }, data: { label: "m1b" } },
              },
            },
          },
        },
      },
    });
  };

  const snap = async (c: AnyClient) => {
    const orgs = await (c as any).org.findMany({ orderBy: { id: "asc" } });
    const members = await (c as any).member.findMany({
      orderBy: { id: "asc" },
    });
    return {
      orgs: orgs.map((o: any) => [o.id, o.name, o.code]),
      members: members.map((m: any) => [m.id, m.label, m.orgCode]),
    };
  };

  const expected = {
    orgs: [
      ["o1", "o1b", "OLD"],
      ["o2", "o2", "OTHER"],
    ],
    members: [
      ["m1", "m1b", "OLD"],
      ["mx", "mx", "OTHER"],
    ],
  };

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: the non-PK referenced member update correlates through the located row`, async () => {
      const { state, engines } = await runObserved(
        d4Tree,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// The combined ≥6-level tree: located child-held UPDATE targets (L1/L2) feeding a
// FRESH create subtree (L3-L6) with a generated-PK parent-held to-one at the bottom
// — X1b fresh-depth and mixed located/fresh nesting through one architecture at
// arbitrary depth. NOTE: the located targets here carry only scalar+child-held
// updates, so this tree does NOT exercise the X1c located-target *fold* delegation
// (targetNeedsFullUpdate); that mechanism is witnessed — and falsification-proven
// load-bearing — by the dedicated level-3 parent-held and D4 describes above.
// (When this test was written, a parent-held fold on a located target in THIS
// 8-model graph tripped the forward-declaration `push()` 42P01 documented in the
// file header — a MIGRATION DDL-ordering bug, since fixed in `src/migrations/`,
// not a query-boundary / terminal-read bug. This combined tree is left as-is,
// exercising the scalar+child-held located path rather than the fold.)
// Distinct models per level (no self-ref):
//
//   L0  org u0                    (root update)
//   L1  → teams.update t1         (LOCATED, child-held)
//   L2    → members.update m1     (LOCATED, child-held)
//   L3      → tasks.create k3     (FRESH create subtree — X1b)
//   L4        → notes.create k4   (FRESH)
//   L5          → tags.create k5  (FRESH)
//   L6            → badge.create  (parent-held to-one, generated PK — X1c fresh
//                                  projection folded into the tag's own INSERT)
// ---------------------------------------------------------------------------
const deepSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("x1c_dp_org");
  const team = s
    .model({
      id: s.string().id(),
      name: s.string(),
      orgId: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .optional(),
      members: s.oneToMany(() => member),
    })
    .map("x1c_dp_team");
  const member = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teamId: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("teamId")
        .references("id")
        .optional(),
      tasks: s.oneToMany(() => task),
    })
    .map("x1c_dp_member");
  const task = s
    .model({
      id: s.string().id(),
      name: s.string(),
      memberId: s.string().nullable(),
      member: s
        .manyToOne(() => member)
        .fields("memberId")
        .references("id")
        .optional(),
      notes: s.oneToMany(() => note),
    })
    .map("x1c_dp_task");
  const note = s
    .model({
      id: s.string().id(),
      name: s.string(),
      taskId: s.string().nullable(),
      task: s
        .manyToOne(() => task)
        .fields("taskId")
        .references("id")
        .optional(),
      tags: s.oneToMany(() => tag),
    })
    .map("x1c_dp_note");
  const badge = s
    .model({
      id: s.int().id().increment(),
      code: s.string(),
      tags: s.oneToMany(() => tag),
    })
    .map("x1c_dp_badge");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string(),
      noteId: s.string().nullable(),
      note: s
        .manyToOne(() => note)
        .fields("noteId")
        .references("id")
        .optional(),
      badgeId: s.int().nullable(),
      badge: s
        .manyToOne(() => badge)
        .fields("badgeId")
        .references("id")
        .optional(),
    })
    .map("x1c_dp_tag");
  return { org, team, member, task, note, badge, tag };
})();

describe("X1c — combined ≥6-level tree (fresh + located targets mixed)", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.org.create({ data: { id: "u0", name: "u0" } });
    await client.team.create({ data: { id: "t1", name: "t1", orgId: "u0" } });
    await client.member.create({
      data: { id: "m1", name: "m1", teamId: "t1" },
    });
    // A disjoint located chain that must stay untouched.
    await client.org.create({ data: { id: "z0", name: "z0" } });
    await client.team.create({ data: { id: "zt", name: "zt", orgId: "z0" } });
  };

  const op = async (c: Record<string, any>) => {
    await c.org.update({
      where: { id: "u0" },
      data: {
        teams: {
          update: {
            where: { id: "t1" }, // L1 located
            data: {
              name: "t1b",
              members: {
                update: {
                  where: { id: "m1" }, // L2 located
                  data: {
                    name: "m1b",
                    tasks: {
                      create: {
                        id: "k3", // L3 fresh
                        name: "k3",
                        notes: {
                          create: {
                            id: "k4", // L4 fresh
                            name: "k4",
                            tags: {
                              create: {
                                id: "k5", // L5 fresh
                                name: "k5",
                                // L6 parent-held to-one (generated PK) folded into k5.
                                badge: { create: { code: "DEEP" } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  };

  const snap = async (c: AnyClient) => {
    const teams = await (c as any).team.findMany({ orderBy: { id: "asc" } });
    const members = await (c as any).member.findMany({
      orderBy: { id: "asc" },
    });
    const tasks = await (c as any).task.findMany({ orderBy: { id: "asc" } });
    const notes = await (c as any).note.findMany({ orderBy: { id: "asc" } });
    const tags = await (c as any).tag.findMany({ orderBy: { id: "asc" } });
    const badges = await (c as any).badge.findMany({ orderBy: { id: "asc" } });
    return {
      teams: teams.map((t: any) => [t.id, t.name]),
      members: members.map((m: any) => [m.id, m.name]),
      tasks: tasks.map((k: any) => [k.id, k.memberId]),
      notes: notes.map((n: any) => [n.id, n.taskId]),
      tags: tags.map((g: any) => [g.id, g.noteId, g.badgeId]),
      badges: badges.map((b: any) => [b.id, b.code]),
    };
  };

  // t1/m1 renamed; k3 under m1, k4 under k3, k5 under k4 with badgeId 1; z-chain untouched.
  const expected = {
    teams: [
      ["t1", "t1b"],
      ["zt", "zt"],
    ],
    members: [["m1", "m1b"]],
    tasks: [["k3", "m1"]],
    notes: [["k4", "k3"]],
    tags: [["k5", "k4", 1]],
    badges: [[1, "DEEP"]],
  };

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: six levels, fresh + located mixed, one boundary`, async () => {
      const { state, engines } = await runObserved(
        deepSchema,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});
