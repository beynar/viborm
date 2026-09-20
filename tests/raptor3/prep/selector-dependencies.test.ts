import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class DependencySQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  resetStatements(): void {
    this.statements.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

function dependencySchema() {
  const envelope = s
    .model({
      id: s.string().id(),
      hubs: s.toMany(() => hub),
    })
    .map("g3p05_dependency_envelopes");
  const hub = s
    .model({
      id: s.string().id(),
      label: s.string(),
      envelopeId: s.string(),
      envelope: s
        .toOne(() => envelope)
        .fields("envelopeId")
        .references("id"),
      markers: s.toMany(() => marker).through("g3p05_dependency_hub_markers"),
      accounts: s
        .toMany(() => account)
        .through("g3p05_dependency_hub_accounts"),
    })
    .map("g3p05_dependency_hubs");
  const marker = s
    .model({
      tenant: s.string(),
      code: s.string(),
      flag: s.string(),
      hubs: s.toMany(() => hub),
      accounts: s
        .toMany(() => account)
        .through("g3p05_dependency_account_markers"),
    })
    .id(["tenant", "code"])
    .map("g3p05_dependency_markers");
  const account = s
    .model({
      id: s.string().id(),
      label: s.string(),
      hubs: s.toMany(() => hub),
      markers: s.toMany(() => marker),
    })
    .map("g3p05_dependency_accounts");
  return { envelope, hub, marker, account };
}

async function createDependencyWorld() {
  const schema = dependencySchema();
  const database = new Database(":memory:");
  const driver = new DependencySQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  await client.envelope.create({ data: { id: "e1" } });
  await client.hub.create({
    data: { id: "h1", label: "hub", envelopeId: "e1" },
  });
  for (const code of ["m1", "m2"]) {
    await client.marker.create({
      data: { tenant: "t1", code, flag: "old" },
    });
  }
  await client.account.create({ data: { id: "a1", label: "before" } });
  await client.account.create({ data: { id: "a2", label: "decoy" } });
  const markerWhere = (code: string) => ({
    tenant_code: { tenant: "t1", code },
  });
  const markerIdentity = (code: string) => ({ tenant: "t1", code });
  await client.hub.update({
    where: { id: "h1" },
    data: {
      markers: { connect: [markerWhere("m1"), markerWhere("m2")] },
      accounts: { connect: [{ id: "a1" }, { id: "a2" }] },
    },
  });
  await client.account.update({
    where: { id: "a1" },
    data: {
      markers: { connect: [markerWhere("m1"), markerWhere("m2")] },
    },
  });
  driver.resetStatements();
  return {
    candidate: createCommandEngine({ schema, driver }),
    client,
    database,
    driver,
    markerIdentity,
    markerWhere,
  };
}

type DependencyWorld = Awaited<ReturnType<typeof createDependencyWorld>>;

async function closeWorld(world: DependencyWorld): Promise<void> {
  await world.client.$disconnect();
  world.database.close();
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (failure) {
    return failure;
  }
  throw new Error("Expected the candidate operation to fail");
}

/** The operation's own mutations, apart from the reads that surround them. */
const MUTATION = /^(?:INSERT|UPDATE|DELETE)\b/;
/**
 * The nested `accounts.update` lookup: the only statement that resolves an
 * account through the parent hub's membership, and the read whose answer the
 * marker write of the same operation changes.
 */
const HUB_SCOPED_ACCOUNT_LOOKUP =
  /^SELECT .*FROM "g3p05_dependency_accounts".*"g3p05_dependency_hub_accounts"/;

/**
 * N1 (D-51, `AGENTS.md` "A dependent read is an ordered observation"): a lookup
 * whose answer an earlier write of the same operation can change is taken at
 * its consumer's execution point, AFTER that write. The dependency pass still
 * computes the overlap this file constructs; it spends the fact on placement,
 * not on the retired sentences "Nested operation '…' on relation '…' depends on
 * an earlier '…' target / membership write in the same nested write. Split
 * these operations into separate queries."
 *
 * So the proof that a read was judged DEPENDENT (not disjoint) is its position:
 * the operation's one mutation runs first, and the one hub-scoped account
 * lookup is taken once, behind it — never a capture ahead of it, which is where
 * a read proven disjoint stays.
 */
function assertObservedAfterTheWrite(world: DependencyWorld): void {
  const statements = world.driver.statements;
  const log = statements.join("\n");
  const count = (pattern: RegExp) =>
    statements.filter((statement) => pattern.test(statement)).length;
  const write = statements.findIndex((statement) => MUTATION.test(statement));
  const observation = statements.findIndex((statement) =>
    HUB_SCOPED_ACCOUNT_LOOKUP.test(statement)
  );
  assert(write >= 0 && observation > write, log);
  assert.deepEqual(
    [count(MUTATION), count(HUB_SCOPED_ACCOUNT_LOOKUP)],
    [1, 1],
    log
  );
}

/**
 * N1 rule 3: a required target absent at its observation is the correlated
 * refusal the relation body already registers, and NOTHING of the operation
 * commits — the live route rolls the transaction back, which
 * {@link assertInitialState} reads back row by row.
 */
function assertAbsentTargetRefusal(failure: unknown): void {
  assert(failure instanceof NestedWriteError);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED);
  assert.equal(
    failure.message,
    "Cannot update relation 'accounts': target record was not found for this parent."
  );
  assert.equal(failure.meta.relation, "accounts");
}

/**
 * The two placement cells below run the operation for the PLACEMENT of its
 * reads, not for its answer: the answer — the correlated refusal of a target
 * absent at the observation — is the subject of the cells above, and repeating
 * it would say nothing about a key nested under OR / NOT.
 */
async function runForPlacement(run: () => Promise<unknown>): Promise<void> {
  await run().catch(() => undefined);
}

async function assertInitialState(world: DependencyWorld): Promise<void> {
  assert.deepEqual(
    await world.client.marker.findMany({
      orderBy: { code: "asc" },
      select: { tenant: true, code: true, flag: true },
    }),
    [
      { tenant: "t1", code: "m1", flag: "old" },
      { tenant: "t1", code: "m2", flag: "old" },
    ]
  );
  assert.deepEqual(
    await world.client.account.findMany({
      orderBy: { id: "asc" },
      select: { id: true, label: true },
    }),
    [
      { id: "a1", label: "before" },
      { id: "a2", label: "decoy" },
    ]
  );
  assert.deepEqual(
    await world.client.account.findUnique({
      where: { id: "a1" },
      select: {
        markers: {
          orderBy: { code: "asc" },
          select: { code: true },
        },
      },
    }),
    { markers: [{ code: "m1" }, { code: "m2" }] }
  );
}

function relatedRowMutation(world: DependencyWorld) {
  return {
    markers: {
      update: {
        where: world.markerWhere("m1"),
        data: { flag: "new" },
      },
    },
    accounts: {
      update: {
        where: {
          id: "a1",
          markers: {
            some: { ...world.markerIdentity("m1"), flag: "old" },
          },
        },
        data: { label: "must-not-land" },
      },
    },
  };
}

describe("G3P-05 cross-table selector dependencies", () => {
  it("executes a root related-row write that changes a later relation predicate, then refuses the absent target", async () => {
    const world = await createDependencyWorld();
    try {
      // N1 (D-51): pinned DESIGN §6.2's veto — a NestedWriteError raised
      // before any statement ran; now the marker update executes and the
      // account lookup, taken after it, no longer finds its target.
      const failure = await captureFailure(() =>
        world.candidate.execute("hub", "update", {
          where: { id: "h1" },
          data: relatedRowMutation(world),
        })
      );

      assertAbsentTargetRefusal(failure);
      assertObservedAfterTheWrite(world);
      await assertInitialState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("executes the same related-row dependency inside a selected nested record, then refuses the absent target", async () => {
    const world = await createDependencyWorld();
    try {
      // N1 (D-51): pinned the same veto one record deeper; now the nested
      // hub's marker update executes and the account lookup observes it.
      const failure = await captureFailure(() =>
        world.candidate.execute("envelope", "update", {
          where: { id: "e1" },
          data: {
            hubs: {
              update: {
                where: { id: "h1" },
                data: relatedRowMutation(world),
              },
            },
          },
        })
      );

      assertAbsentTargetRefusal(failure);
      assertObservedAfterTheWrite(world);
      await assertInitialState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("executes a membership write that changes a later predicate on the same edge, then refuses the absent target", async () => {
    const world = await createDependencyWorld();
    try {
      // N1 (D-51): pinned the veto a membership write raised; now the
      // disconnect executes and the account lookup, taken after it, reads the
      // membership the removal left.
      const failure = await captureFailure(() =>
        world.candidate.execute("hub", "update", {
          where: { id: "h1" },
          data: {
            markers: {
              update: {
                where: world.markerWhere("m1"),
                data: { accounts: { disconnect: { id: "a1" } } },
              },
            },
            accounts: {
              update: {
                where: {
                  id: "a1",
                  markers: { some: world.markerIdentity("m1") },
                },
                data: { label: "must-not-land" },
              },
            },
          },
        })
      );

      assertAbsentTargetRefusal(failure);
      assertObservedAfterTheWrite(world);
      await assertInitialState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("executes a selected updateMany write that changes a later relation predicate, then refuses the absent target", async () => {
    const world = await createDependencyWorld();
    try {
      // N1 (D-51): pinned the veto over a selected bulk write; now the
      // updateMany executes and the account lookup observes its rows.
      const failure = await captureFailure(() =>
        world.candidate.execute("hub", "update", {
          where: { id: "h1" },
          data: {
            markers: {
              updateMany: {
                where: world.markerIdentity("m1"),
                data: { flag: "new" },
              },
            },
            accounts: {
              update: {
                where: {
                  id: "a1",
                  markers: {
                    some: { ...world.markerIdentity("m1"), flag: "old" },
                  },
                },
                data: { label: "must-not-land" },
              },
            },
          },
          select: { id: true },
        })
      );

      assertAbsentTargetRefusal(failure);
      assertObservedAfterTheWrite(world);
      await assertInitialState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("executes the same selected updateMany dependency inside a nested record, then refuses the absent target", async () => {
    const world = await createDependencyWorld();
    try {
      // N1 (D-51): pinned the same bulk veto one record deeper; now the
      // nested updateMany executes and the account lookup observes it.
      const failure = await captureFailure(() =>
        world.candidate.execute("envelope", "update", {
          where: { id: "e1" },
          data: {
            hubs: {
              update: {
                where: { id: "h1" },
                data: {
                  markers: {
                    updateMany: {
                      where: world.markerIdentity("m1"),
                      data: { flag: "new" },
                    },
                  },
                  accounts: {
                    update: {
                      where: {
                        id: "a1",
                        markers: {
                          some: {
                            ...world.markerIdentity("m1"),
                            flag: "old",
                          },
                        },
                      },
                      data: { label: "must-not-land" },
                    },
                  },
                },
              },
            },
          },
          select: { id: true },
        })
      );

      assertAbsentTargetRefusal(failure);
      assertObservedAfterTheWrite(world);
      await assertInitialState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("executes a selected deleteMany whose removal changes later target existence, then refuses the absent target", async () => {
    const world = await createDependencyWorld();
    try {
      // N1 (D-51): pinned the veto over a removal a later read would miss;
      // now the deleteMany executes and the account lookup, taken after it,
      // finds no marker to satisfy the predicate.
      const failure = await captureFailure(() =>
        world.candidate.execute("hub", "update", {
          where: { id: "h1" },
          data: {
            markers: { deleteMany: world.markerIdentity("m1") },
            accounts: {
              update: {
                where: {
                  id: "a1",
                  markers: { some: world.markerIdentity("m1") },
                },
                data: { label: "must-not-land" },
              },
            },
          },
          select: { id: true },
        })
      );

      assertAbsentTargetRefusal(failure);
      assertObservedAfterTheWrite(world);
      await assertInitialState(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("accepts a selected updateMany proven disjoint by another complete compound key", async () => {
    const world = await createDependencyWorld();
    try {
      assert.deepEqual(
        await world.candidate.execute("hub", "update", {
          where: { id: "h1" },
          data: {
            markers: {
              updateMany: {
                where: world.markerIdentity("m1"),
                data: { flag: "new" },
              },
            },
            accounts: {
              update: {
                where: {
                  id: "a1",
                  markers: {
                    some: { ...world.markerIdentity("m2"), flag: "old" },
                  },
                },
                data: { label: "updated" },
              },
            },
          },
          select: { id: true },
        }),
        { id: "h1" }
      );
      assert.deepEqual(
        await world.client.marker.findMany({
          orderBy: { code: "asc" },
          select: { code: true, flag: true },
        }),
        [
          { code: "m1", flag: "new" },
          { code: "m2", flag: "old" },
        ]
      );
      assert.deepEqual(
        await world.client.account.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true },
        }),
        [
          { id: "a1", label: "updated" },
          { id: "a2", label: "decoy" },
        ]
      );
    } finally {
      await closeWorld(world);
    }
  });

  it("accepts a relation predicate proven disjoint by the complete compound target key", async () => {
    const world = await createDependencyWorld();
    try {
      await world.candidate.execute("hub", "update", {
        where: { id: "h1" },
        data: {
          markers: {
            update: {
              where: world.markerWhere("m1"),
              data: { flag: "new" },
            },
          },
          accounts: {
            update: {
              where: {
                id: "a1",
                markers: {
                  some: { ...world.markerIdentity("m2"), flag: "old" },
                },
              },
              data: { label: "updated" },
            },
          },
        },
      });

      assert.deepEqual(
        await world.client.marker.findMany({
          orderBy: { code: "asc" },
          select: { code: true, flag: true },
        }),
        [
          { code: "m1", flag: "new" },
          { code: "m2", flag: "old" },
        ]
      );
      assert.deepEqual(
        await world.client.account.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true },
        }),
        [
          { id: "a1", label: "updated" },
          { id: "a2", label: "decoy" },
        ]
      );
    } finally {
      await closeWorld(world);
    }
  });

  it("does not confuse equal slot names on different membership edges", async () => {
    const world = await createDependencyWorld();
    try {
      await world.candidate.execute("hub", "update", {
        where: { id: "h1" },
        data: {
          markers: { disconnect: world.markerWhere("m1") },
          accounts: {
            update: {
              where: {
                id: "a1",
                markers: { some: world.markerIdentity("m1") },
              },
              data: { label: "updated" },
            },
          },
        },
      });

      assert.deepEqual(
        await world.client.hub.findUnique({
          where: { id: "h1" },
          select: {
            markers: {
              orderBy: { code: "asc" },
              select: { code: true },
            },
          },
        }),
        { markers: [{ code: "m2" }] }
      );
      assert.deepEqual(
        await world.client.account.findUnique({
          where: { id: "a1" },
          select: {
            label: true,
            markers: {
              orderBy: { code: "asc" },
              select: { code: true },
            },
          },
        }),
        { label: "updated", markers: [{ code: "m1" }, { code: "m2" }] }
      );
    } finally {
      await closeWorld(world);
    }
  });

  for (const [name, markerPredicate] of [
    [
      "OR",
      {
        OR: [{ tenant: "t1", code: "m2" }, { flag: "old" }],
      },
    ],
    [
      "NOT",
      {
        NOT: { tenant: "t1", code: "m2" },
        flag: "old",
      },
    ],
  ] as const) {
    it(`does not treat a key nested under ${name} as proof of disjointness`, async () => {
      const world = await createDependencyWorld();
      try {
        await world.client.account.update({
          where: { id: "a1" },
          data: { markers: { disconnect: world.markerWhere("m2") } },
        });
        world.driver.resetStatements();
        // N1 (D-51): pinned DESIGN §6.2's veto — a NestedWriteError raised
        // before any statement ran — as the proof that a key under OR / NOT
        // proves nothing. The veto is gone and the same fact is now the
        // read's PLACEMENT: the account lookup is an ordered observation,
        // taken after the marker update. Read as disjoint it would run ahead
        // of that update instead, match the flag it has not yet changed, and
        // land "must-not-land".
        await runForPlacement(() =>
          world.candidate.execute("hub", "update", {
            where: { id: "h1" },
            data: {
              markers: {
                update: {
                  where: world.markerWhere("m1"),
                  data: { flag: "new" },
                },
              },
              accounts: {
                update: {
                  where: {
                    id: "a1",
                    markers: { some: markerPredicate },
                  },
                  data: { label: "must-not-land" },
                },
              },
            },
          })
        );

        assertObservedAfterTheWrite(world);
        assert.deepEqual(
          await world.client.marker.findMany({
            orderBy: { code: "asc" },
            select: { code: true, flag: true },
          }),
          [
            { code: "m1", flag: "old" },
            { code: "m2", flag: "old" },
          ]
        );
        assert.deepEqual(
          await world.client.account.findUnique({
            where: { id: "a1" },
            select: {
              label: true,
              markers: { select: { code: true } },
            },
          }),
          { label: "before", markers: [{ code: "m1" }] }
        );
      } finally {
        await closeWorld(world);
      }
    });
  }
});
