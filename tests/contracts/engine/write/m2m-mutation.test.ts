import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { manyToManySchema } from "@tests/fixtures/many-to-many-schema";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

interface Scenario {
  name: string;
  seed?: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
  /** "direct": Observed hands the whole tree back to Direct (routing boundary). */
  route?: "direct";
}

function makeClient(db: PGlite, namespace?: string) {
  return createClient({
    schema: manyToManySchema,
    driver: new PGliteDriver({ client: db, namespace }),
  });
}

function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const stable =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stable === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stable, message: error.message };
}

async function dump(client: ReturnType<typeof makeClient>) {
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

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof manyToManySchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database, family.namespace);
  await scenario.seed?.(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let operations: { boundary: "direct" | "production" }[] = [];
  try {
    if (kind === "direct") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({
              client: family.database,
              namespace: family.namespace,
            })
          : new BatchOnlyPGliteDriver({
              client: family.database,
              namespace: family.namespace,
            });
      const observed = observeClientOperations({
        schema: manyToManySchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToObserved =
    operations.length > 0 &&
    operations.every((r) => r.boundary === "production");
  const state = await dump(client);
  return { result, error, state, routedToObserved };
}

const seed = async (client: ReturnType<typeof makeClient>) => {
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

const scenarios: Scenario[] = [
  {
    name: "connect inserts junction rows and is idempotent",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
    },
  },
  {
    name: "connect of a missing target rejects, membership unchanged",
    expectReject: true,
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "missing" } } },
      }),
  },
  {
    name: "set replaces the association set",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { set: [{ id: "t2" }, { id: "t3" }] } },
      });
    },
  },
  {
    name: "set to empty clears the association",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { set: [] } },
      });
    },
  },
  {
    name: "disconnect removes the association and keeps the row",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { disconnect: { id: "t1" } } },
      });
    },
  },
  {
    name: "multi-item disconnect removes each listed association only",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { disconnect: [{ id: "t1" }, { id: "t2" }] } },
      });
    },
  },
  {
    name: "boolean disconnect is rejected, membership unchanged",
    expectReject: true,
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { disconnect: true } },
      });
    },
  },
  {
    name: "delete removes the child row and all its associations",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p2" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { delete: { id: "t1" } } },
      });
    },
  },
  {
    name: "delete of an unconnected record rejects, state unchanged",
    expectReject: true,
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: { tags: { delete: { id: "t1" } } },
      }),
  },
  {
    name: "deleteMany deletes only connected rows matching the filter",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { deleteMany: { name: { in: ["tag-1", "tag-3"] } } } },
      });
    },
  },
  {
    name: "deleteMany empty filter removes all connected rows",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { deleteMany: {} } },
      });
    },
  },
  {
    name: "mixed connect and disconnect under one relation compose",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      // One payload, two kinds, disjoint targets: connect t3, disconnect t1.
      await c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: { connect: { id: "t3" }, disconnect: { id: "t1" } },
        },
      });
    },
  },
  {
    name: "standalone deleteMany with no matching member is a no-op",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: { tags: { deleteMany: { name: "tag-1" } } },
      }),
  },
  {
    name: "nested update modifies only a connected record",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            update: { where: { id: "t1" }, data: { name: "tag-1-renamed" } },
          },
        },
      });
    },
  },
  {
    name: "nested update of an unconnected record rejects, state unchanged",
    expectReject: true,
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: { update: { where: { id: "t2" }, data: { name: "nope" } } },
        },
      });
    },
  },
  {
    name: "updateMany updates every connected matching record",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post!.update!({
        where: { id: "p2" },
        data: { tags: { connect: { id: "t3" } } },
      });
      // Correlated: only p1's connected tags get the new featuredPostId, not t3.
      await c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: { updateMany: { where: {}, data: { featuredPostId: "p2" } } },
        },
      });
    },
  },
  {
    // RETARGETED by N6-U3 (own-write linearization, ATOM §4.1), from a rejection to an
    // accept-and-execute assertion on the SAME payload — the oracle half of the
    // conformance scenario of the same shape. `connect` reads nothing, so it is a
    // stage-3 pure adder ordered after the junction's `deleteMany`; the removal's
    // filter is resolved against committed membership, where t2 is not yet a member.
    // Both substrates must still agree, which is what this oracle is for.
    name: "connect lands after a deleteMany that cannot see it",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: { connect: { id: "t2" }, deleteMany: { name: "tag-2" } },
        },
      });
    },
  },
  // --- P4.5: the M2M adopt family through the junction, now on Observed. Each is the
  // create-arm-through-junction shape P3 observed to Direct, absorbed as one
  // RelationJunctionPart: INSERT child (Direct's junction leaves) + INSERT join row.
  {
    name: "nested create inserts the child and the join row",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: { tags: { create: { id: "t10", name: "tag-10" } } },
      }),
  },
  {
    name: "nested create of multiple children (mapped junction columns)",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            create: [
              { id: "t11", name: "tag-11" },
              { id: "t12", name: "tag-12" },
            ],
          },
        },
      }),
  },
  {
    name: "nested create on an implicit junction (categories)",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: { categories: { create: { id: "c1", name: "cat-1" } } },
      }),
  },
  {
    name: "nested connectOrCreate connects an existing target",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t1" },
              create: { id: "t1", name: "never" },
            },
          },
        },
      }),
  },
  {
    name: "nested connectOrCreate creates a missing target",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t20" },
              create: { id: "t20", name: "tag-20" },
            },
          },
        },
      }),
  },
  {
    name: "connectOrCreate dedupes duplicate targets (compile-time merge)",
    seed,
    act: (c) =>
      c.post!.update!({
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
  },
  {
    name: "nested upsert updates a connected (member) record",
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
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
  },
  {
    name: "nested upsert creates a missing target (absent branch)",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t30" },
              create: { id: "t30", name: "tag-30" },
              update: { name: "nope" },
            },
          },
        },
      }),
  },
  {
    name: "nested upsert of a globally-existing non-member rejects (V7001)",
    expectReject: true,
    seed,
    act: async (c) => {
      await c.post!.update!({
        where: { id: "p2" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "never" },
              update: { name: "nope" },
            },
          },
        },
      });
    },
  },
  {
    name: "mixed connect and create under one M2M relation compose",
    seed,
    act: (c) =>
      c.post!.update!({
        where: { id: "p1" },
        data: {
          tags: {
            connect: { id: "t2" },
            create: { id: "t40", name: "tag-40" },
          },
        },
      }),
  },
];

describe("write boundary many-to-many dual-run oracle (Direct vs Observed)", () => {
  const getFamily = usePGliteSchemaFamily(manyToManySchema);
  for (const scenario of scenarios) {
    // retry absorbs transient PGlite WASM crashes under full-suite parallel
    // load only — a real dual-run divergence is deterministic by construction
    // (reset state, deterministic ids) and fails every retry.
    test(scenario.name, { timeout: 30_000, retry: 2 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      if (scenario.route === "direct") {
        expect(tx.routedToObserved).toBe(false);
        expect(batch.routedToObserved).toBe(false);
      } else {
        expect(tx.routedToObserved).toBe(true);
        expect(batch.routedToObserved).toBe(true);
      }

      expect(tx.error).toEqual(direct.error);
      expect(batch.error).toEqual(direct.error);
      expect(Boolean(direct.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(direct.result);
        expect(batch.result).toEqual(direct.result);
      }

      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
    });
  }
});

// ---------------------------------------------------------------------------
// Self-referential M2M direction. `user.follows` carries the whole junction
// configuration — source `followerId`, target `followedId` — so its table is
// `user_user(followerId, followedId)` and source/target orientation is
// the whole correctness question: a connect must write (follower=parent,
// followed=target), not the reverse. `user.followedBy` declares nothing and
// reads the mirrored view. The dual-run oracle proves the observable
// follows/followedBy membership; the raw junction-row inspection proves the
// underlying column orientation Observed's reuse of Direct's junction sides
// produces (since Phase 3, the bound junction membership).
// ---------------------------------------------------------------------------

const selfRefSeed = async (client: ReturnType<typeof makeClient>) => {
  await client.user.create({ data: { id: "u1", name: "Alice" } });
  await client.user.create({ data: { id: "u2", name: "Bob" } });
  await client.user.create({ data: { id: "u3", name: "Cara" } });
};

async function selfRefDump(client: ReturnType<typeof makeClient>) {
  const users = (await client.user.findMany({
    orderBy: { id: "asc" },
    include: {
      follows: { orderBy: { id: "asc" } },
      followedBy: { orderBy: { id: "asc" } },
    },
  })) as {
    id: string;
    follows?: { id: string }[];
    followedBy?: { id: string }[];
  }[];
  const follows: unknown[] = [];
  const followedBy: unknown[] = [];
  for (const user of users) {
    const f = (user.follows ?? []).map((u) => u.id).sort();
    const fb = (user.followedBy ?? []).map((u) => u.id).sort();
    if (f.length > 0) follows.push({ userId: user.id, followsIds: f });
    if (fb.length > 0) followedBy.push({ userId: user.id, followedByIds: fb });
  }
  return { follows, followedBy };
}

async function runSelfRefArm(
  kind: ArmKind,
  act: (client: Record<string, RoutedModel>) => Promise<unknown>
) {
  const db = openBorrowedPGlite();
  const client = makeClient(db);
  await syncLiveSchema(client);
  await selfRefSeed(client);
  let operations: { boundary: "direct" | "production" }[] = [];
  if (kind === "direct") {
    await act(client as unknown as Record<string, RoutedModel>);
  } else {
    const driver =
      kind === "observed-tx"
        ? new PGliteDriver({ client: db })
        : new BatchOnlyPGliteDriver({ client: db });
    const observed = observeClientOperations({
      schema: manyToManySchema,
      driver,
    });
    operations = observed.operations;
    await act(observed.client);
  }
  const state = await selfRefDump(client);
  const junction = (
    await db.query(
      'SELECT "followerId", "followedId" FROM "user_user" ORDER BY "followerId", "followedId"'
    )
  ).rows;
  const routedToObserved =
    operations.length > 0 &&
    operations.every((r) => r.boundary === "production");
  await client.$disconnect();
  await closeTestPGlite(db);
  return { state, junction, routedToObserved };
}

describe("write boundary self-referential M2M direction", () => {
  const act = async (c: Record<string, RoutedModel>) => {
    await c.user!.update!({
      where: { id: "u1" },
      data: { follows: { connect: [{ id: "u2" }, { id: "u3" }] } },
    });
    await c.user!.update!({
      where: { id: "u1" },
      data: { follows: { disconnect: { id: "u2" } } },
    });
  };

  test(
    "connect then disconnect keeps A/B orientation",
    { timeout: 30_000 },
    async () => {
      const direct = await runSelfRefArm("direct", act);
      const tx = await runSelfRefArm("observed-tx", act);
      const batch = await runSelfRefArm("observed-batch", act);

      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      // Observable membership parity.
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);

      // Raw junction orientation: u1 follows u3 => (followerId=u1, followedId=u3),
      // never the reverse. Byte-identical across Direct and both Observed substrates.
      expect(tx.junction).toEqual([{ followerId: "u1", followedId: "u3" }]);
      expect(direct.junction).toEqual(tx.junction);
      expect(batch.junction).toEqual(tx.junction);
    }
  );
});

// ---------------------------------------------------------------------------
// Pin Rule structural witness for the P4.5 create-through-junction arms
// (review residue): the connectOrCreate missing arm must carry the child
// racePin (its unique-constraint violation is the raceable signal) and NO
// guard; the found arm pins existence raceable:false. This is the assertion
// whose absence let a dropped racePin pass the whole suite.
// ---------------------------------------------------------------------------

describe("M2M connectOrCreate Pin Rule structure", () => {
  const makeOperation = () => {
    const db = openBorrowedPGlite();
    const driver = new BatchOnlyPGliteDriver({ client: db });
    // Hydrates the shared schema fixture's name registry (createClient does it
    // as a side effect; no I/O happens — the operation is never executed).
    createClient({ schema: manyToManySchema, driver });
    const schemas = createSchemaRegistry(manyToManySchema);
    const boundary = new QueryEngine(
      driver,
      createModelRegistry(manyToManySchema, schemas)
    );
    return {
      db,
      operation: new UpdateOperation(boundary, manyToManySchema.post, {
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t9" },
              create: { id: "t9", name: "tag-9" },
            },
          },
        },
      }),
    };
  };

  const knownFor = (
    operation: ReturnType<typeof makeOperation>["operation"],
    probeRows: Record<string, unknown>[]
  ) => {
    const known: Record<string, unknown> = {};
    for (const step of operation.planning().steps) {
      known[`${step.id}.rows`] = step.id.includes("tag")
        ? probeRows
        : [{ id: "p1" }];
    }
    return known;
  };

  test("missing arm: child INSERT carries the racePin, no tag-arm guard", async () => {
    const { db, operation } = makeOperation();
    expect(operation.mode).toBe("batch");
    const fragment = operation.compile(knownFor(operation, []));
    // The root-presence guard is the update's own; the connectOrCreate missing
    // arm must contribute NONE (Pin Rule: constraint, not notExists).
    expect(
      fragment.steps.some((s) => s.kind === "guard" && s.id.includes("tag"))
    ).toBe(false);
    const pinned = fragment.steps.filter(
      (s) => s.kind === "write" && s.racePin !== undefined
    );
    expect(pinned).toHaveLength(1);
    const child = pinned[0];
    expect(child?.kind === "write" && child.racePin?.fields).toEqual(["id"]);
    expect(child?.kind === "write" && child.expects).toBeUndefined();
    await closeTestPGlite(db);
  });

  test("found arm: one exists guard raceable:false, no racePin anywhere", async () => {
    const { db, operation } = makeOperation();
    const fragment = operation.compile(knownFor(operation, [{ id: "t9" }]));
    const guards = fragment.steps.filter(
      (s) => s.kind === "guard" && s.id.includes("tag")
    );
    expect(guards).toHaveLength(1);
    const guard = guards[0];
    expect(guard?.kind === "guard" && guard.premise.kind).toBe("exists");
    expect(guard?.kind === "guard" && guard.failure.raceable).toBe(false);
    expect(
      fragment.steps.some((s) => s.kind === "write" && s.racePin !== undefined)
    ).toBe(false);
    await closeTestPGlite(db);
  });
});
