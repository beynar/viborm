import { createClient } from "@client/client";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import {
  constructRoutedOperation,
  executeRoutedOperation,
} from "@src/query-engine/write-engine/routing";
import { operationFragmentSchema } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import {
  type OperationRecord,
  observeClientOperations,
} from "@tests/contracts/engine/write/operation-observer";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// Two parent-held to-one relations on one record, BOTH referencing `account` — the
// sibling-coupling witness. Under an UPDATE root the coverage ledger does NOT apply
// (§7.0.3): a sibling connect observing a sibling create is a rejected own-write.
const crossSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.toMany(() => record).name("primary"),
      secondaryRecords: s.toMany(() => record).name("secondary"),
    })
    .map("t2_cross_accounts");
  const record = s
    .model({
      id: s.int().id(),
      note: s.string().nullable(),
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
    .map("t2_cross_records");
  return { account, record };
})();

const opf = operationFragmentSchema;
const nb = nestedWriteBehaviorSchema;

interface ErrorShape {
  name: string;
  message: string;
}
function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  return { name: error.name, message: error.message };
}

type AnyClient = any;
type ArmKind = "direct" | "observed-tx" | "observed-batch";

interface Scenario {
  name: string;
  schema: Record<string, Model<any>>;
  seed: (client: AnyClient) => Promise<unknown>;
  act: (client: AnyClient) => Promise<unknown>;
  dump: (client: AnyClient) => Promise<unknown>;
}

async function runArm(
  family: { readonly database: PGlite; readonly reset: () => Promise<void> },
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const db = family.database;
  const base = createClient({
    schema: scenario.schema,
    driver: new PGliteDriver({ client: db }),
  });
  await scenario.seed(base);

  let result: unknown;
  let error: ErrorShape | undefined;
  let operations: OperationRecord[] = [];
  try {
    if (kind === "direct") {
      const direct = createClient({
        schema: scenario.schema,
        driver: new PGliteDriver({ client: db }),
      });
      result = await scenario.act(direct);
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const observed = observeClientOperations({
        schema: scenario.schema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const state = await scenario.dump(base);
  const routedToObserved =
    kind === "direct" || operations.every((r) => r.boundary === "production");
  return {
    result,
    error,
    state,
    routedToObserved,
    observed: operations.length > 0,
  };
}

const scenarios: Scenario[] = [
  // -- Parent-held (FK-holder-side) direction, opf: post holds userId -> user ----
  {
    name: "parent-held to-one create under update (generated target id)",
    schema: opf,
    seed: (c) => c.post.create({ data: { id: 6, title: "t", slug: "s6" } }),
    act: (c) =>
      c.post.update({
        where: { id: 6 },
        data: { author: { create: { name: "x" } } },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    // GATED RESIDUAL ENTRY 1 (FOUND arm): parent-held connectOrCreate under update.
    name: "parent-held connectOrCreate under update FOUND (adopts existing)",
    schema: opf,
    seed: async (c) => {
      await c.user.create({ data: { name: "owner" } }); // id=1
      await c.post.create({ data: { id: 6, title: "t", slug: "s6" } });
    },
    act: (c) =>
      c.post.update({
        where: { id: 6 },
        data: {
          author: {
            connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
          },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    // GATED RESIDUAL ENTRY 1 (MISSING arm): parent-held connectOrCreate under update.
    name: "parent-held connectOrCreate under update MISSING (creates target)",
    schema: opf,
    seed: (c) => c.post.create({ data: { id: 6, title: "t", slug: "s6" } }),
    act: (c) =>
      c.post.update({
        where: { id: 6 },
        data: {
          author: {
            connectOrCreate: { where: { id: 50 }, create: { name: "fresh" } },
          },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "parent-held to-one connect under update (regression witness)",
    schema: opf,
    seed: async (c) => {
      await c.user.create({ data: { name: "owner" } }); // id=1
      await c.post.create({ data: { id: 6, title: "t", slug: "s6" } });
    },
    act: (c) =>
      c.post.update({
        where: { id: 6 },
        data: { author: { connect: { id: 1 } } },
        select: { id: true, userId: true },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "scalar SET + parent-held create under update (disjoint sibling)",
    schema: opf,
    seed: (c) => c.post.create({ data: { id: 6, title: "t", slug: "s6" } }),
    act: (c) =>
      c.post.update({
        where: { id: 6 },
        data: { title: "renamed", author: { create: { name: "y" } } },
        select: { id: true, title: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  // -- Parent-held create/connectOrCreate with a PROVIDED string PK, nb.profile ---
  {
    name: "parent-held create under update (provided string PK), profile.update",
    schema: nb,
    seed: (c) =>
      c.profile.create({ data: { id: "pr1", bio: "b", userId: null } }),
    act: (c) =>
      c.profile.update({
        where: { id: "pr1" },
        data: { user: { create: { id: "u2", name: "alice" } } },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.profile.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  // -- Inverse-side (child-held) direction, nb: user referenced by profile.userId --
  {
    // GATED RESIDUAL ENTRY 2: inverse-side to-one update (child holds FK).
    name: "inverse-side to-one update (child holds FK)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { profile: { update: { bio: "new" } } },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "scalar SET + inverse-side update (disjoint sibling)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { name: "renamed", profile: { update: { bio: "new" } } },
        select: { id: true, name: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.profile.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "inverse-side to-one connect under update (adopt orphan profile)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({
        data: { id: "orphan", bio: "b", userId: null },
      });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { profile: { connect: { id: "orphan" } } },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "inverse-side to-one connectOrCreate under update FOUND (adopt)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({ data: { id: "pr1", bio: "b", userId: null } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            connectOrCreate: {
              where: { id: "pr1" },
              create: { id: "pr1", bio: "created" },
            },
          },
        },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "inverse-side to-one connectOrCreate under update MISSING (create)",
    schema: nb,
    seed: (c) => c.user.create({ data: { id: "u1", name: "a" } }),
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            connectOrCreate: {
              where: { id: "prX" },
              create: { id: "prX", bio: "created" },
            },
          },
        },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "inverse-side to-one disconnect: true under update",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({ data: { id: "pr1", bio: "b", userId: "u1" } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { profile: { disconnect: true } },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    // The correlation witness (T2 theater finding): a SECOND parent's profile
    // must survive u1's disconnect. An unconditional null-out (dropping the
    // WHERE fk = parent correlation) nulls pr2.userId too — this scenario is
    // the only thing in the estate that catches it.
    name: "inverse-side disconnect: true nulls ONLY the target parent's child",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.user.create({ data: { id: "u2", name: "b" } });
      await c.profile.create({ data: { id: "pr1", bio: "b1", userId: "u1" } });
      await c.profile.create({ data: { id: "pr2", bio: "b2", userId: "u2" } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { profile: { disconnect: true } },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "inverse-side to-one delete: true under update",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({ data: { id: "pr1", bio: "b", userId: "u1" } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { profile: { delete: true } },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "inverse-side update REJECT parity: no correlated child for this parent",
    schema: nb,
    seed: (c) => c.user.create({ data: { id: "u1", name: "a" } }),
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: { profile: { update: { bio: "new" } } },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  // -- Inverse-side (child-held) to-one UPSERT, family F ---------------------------
  {
    // ABSORBED (T3-r2) family F, ABSENT arm: no profile correlated to u1 → INSERT
    // it with fk = u1. No unique `where`; the FK correlation is the locator.
    name: "inverse-side to-one upsert under update ABSENT (creates child, fk=parent)",
    schema: nb,
    seed: (c) => c.user.create({ data: { id: "u1", name: "a" } }),
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr1", bio: "created" },
              update: { bio: "unused" },
            },
          },
        },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    // ABSORBED (T3-r2) family F, FOUND arm: u1 already has a correlated profile →
    // UPDATE it (the create arm is ignored, exactly as Direct's found decision).
    name: "inverse-side to-one upsert under update FOUND (updates correlated child)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr-unused", bio: "nope" },
              update: { bio: "updated" },
            },
          },
        },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    // The correlation witness (T2 theater lesson) for family F's create arm: a
    // SECOND parent's connected profile must survive u1's absent-arm upsert. An
    // uncorrelated insert would be fine here, but a found-arm mis-correlation (or a
    // create arm that reparented pr2) would surface as a cross-parent leak.
    name: "inverse-side upsert ABSENT arm touches ONLY this parent (witness)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.user.create({ data: { id: "u2", name: "b" } });
      await c.profile.create({
        data: { id: "pr2", bio: "witness", userId: "u2" },
      });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr1", bio: "created" },
              update: { bio: "unused" },
            },
          },
        },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  {
    // Family F FOUND arm with a witness: u1's found-arm update must not touch u2's
    // correlated profile (the WHERE fk = parent ∧ pk = capturedPk correlation).
    name: "inverse-side upsert FOUND arm updates ONLY this parent (witness)",
    schema: nb,
    seed: async (c) => {
      await c.user.create({ data: { id: "u1", name: "a" } });
      await c.user.create({ data: { id: "u2", name: "b" } });
      await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
      await c.profile.create({
        data: { id: "pr2", bio: "witness", userId: "u2" },
      });
    },
    act: (c) =>
      c.user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr-unused", bio: "nope" },
              update: { bio: "updated" },
            },
          },
        },
        select: { id: true },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
  // -- Sibling coupling under update (the ledger does NOT generalize, §7.0.3) ------
  {
    name: "REJECT parity: sibling create-then-connect under update (own-write)",
    schema: crossSchema,
    seed: (c) => c.record.create({ data: { id: 1, note: "seed" } }),
    act: (c) =>
      c.record.update({
        where: { id: 1 },
        data: {
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 2 } },
        },
      }),
    dump: (c) =>
      Promise.all([
        c.record.findMany({ orderBy: { id: "asc" } }),
        c.account.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "ACCEPT parity: sibling create + disjoint connect under update",
    schema: crossSchema,
    seed: async (c) => {
      await c.account.create({ data: { id: 1, label: "existing" } });
      await c.record.create({ data: { id: 1, note: "seed" } });
    },
    act: (c) =>
      c.record.update({
        where: { id: 1 },
        data: {
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 1 } },
        },
      }),
    dump: (c) =>
      Promise.all([
        c.record.findMany({ orderBy: { id: "asc" } }),
        c.account.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
];

describe("write boundary to-one update family oracle (Direct vs Observed tx vs Observed batch)", () => {
  const getOperationFragmentFamily = usePGliteSchemaFamily(opf);
  const getNestedWriteFamily = usePGliteSchemaFamily(nb);
  const getCrossFamily = usePGliteSchemaFamily(crossSchema);
  const familyFor = (schema: Scenario["schema"]) => {
    if (schema === opf) return getOperationFragmentFamily();
    if (schema === nb) return getNestedWriteFamily();
    return getCrossFamily();
  };
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 45_000 }, async () => {
      const family = familyFor(scenario.schema);
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      // Observed actually owned the whole tree (no silent Direct fallback).
      expect(tx.observed).toBe(true);
      expect(batch.observed).toBe(true);
      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      // Byte-identical error class + message, result, and persisted state.
      expect(tx.error).toEqual(direct.error);
      if (!direct.error) {
        expect(tx.result).toEqual(direct.result);
      }
      expect(tx.state).toEqual(direct.state);
      expect(batch.error).toEqual(direct.error);
      if (!direct.error) expect(batch.result).toEqual(direct.result);
      expect(batch.state).toEqual(direct.state);
    });
  }
});

// A batch-only driver that runs a mutation on the same DB just before the atomic
// batch commits — the staleness / concurrent-writer injection (the before-batch
// hook technique).
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
    // Fire once (the retry runs clean), before the operation's compiled ATOMIC
    // UNIT — planning reads ride a batch too once grouped by level (PLAN
    // Phase 6.1).
    if (hook && batchIsAtomicUnit(queries)) {
      this.hook = undefined;
      await hook();
    }
    return super.executeBatch<T>(client, queries);
  }
}

// ---------------------------------------------------------------------------
// Falsifications for the T2 pins. Each new guard/racePin trips
// typed under a staleness injection, and is falsified once.
// ---------------------------------------------------------------------------
describe("write boundary to-one update family: T2 pin falsifications", () => {
  test("parent-held connectOrCreate FOUND-arm presence guard: target deleted before batch fails closed", async () => {
    const db = new PGlite();
    const base = createClient({
      schema: opf,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).user.create({ data: { name: "owner" } }); // id=1
    await (base as any).post.create({
      data: { id: 6, title: "t", slug: "s6" },
    });

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer removes the found target after Observed planned.
        await (base as any).user.deleteMany({ where: { id: 1 } });
      },
      { client: db }
    );
    const observed = observeClientOperations({
      schema: opf,
      driver,
    });

    // The found arm folds userId=1 into the root UPDATE; if the user vanishes
    // before commit the GUARD must fail the batch with Direct's typed replacement
    // message. Asserting the exact message isolates the guard from the DB FK
    // backstop (which would reject with a different error) — disabling the
    // guard now fails THIS assertion, not just the write.
    await expect(
      (observed.client as any).post.update({
        where: { id: 6 },
        data: {
          author: {
            connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
          },
        },
      })
    ).rejects.toThrow(
      "Record was replaced by another transaction during nested connectOrCreate"
    );
    const posts = await (base as any).post.findMany({ where: { id: 6 } });
    expect(posts[0].userId).toBeNull(); // the FK never landed
    await (base as any).$disconnect();
  }, 45_000);

  test("parent-held connectOrCreate MISSING-arm racePin: a concurrent create converges by retry-and-adopt", async () => {
    // A provided-PK target (nb.user.id is a string PK) so a concurrent create can
    // collide on the SAME key. The missing-arm INSERT's unique violation is the
    // raceable signal; the observed retry re-plans, finds the row, and adopts it.
    const db = new PGlite();
    const base = createClient({
      schema: nb,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).profile.create({
      data: { id: "pr1", bio: "b", userId: null },
    });

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer creates the very target the missing arm was about to.
        await (base as any).user.create({ data: { id: "u1", name: "winner" } });
      },
      { client: db }
    );
    const schemas = createSchemaRegistry(nb);
    const boundary = new QueryEngine(
      driver as AnyDriver,
      createModelRegistry(nb, schemas)
    );
    const executor = new OperationExecutor(boundary);

    const op = constructRoutedOperation(boundary, nb.profile, "update", {
      where: { id: "pr1" },
      data: {
        user: {
          connectOrCreate: {
            where: { id: "u1" },
            create: { id: "u1", name: "loser" },
          },
        },
      },
      select: { id: true, userId: true },
    });
    const context = createOperationExecutionContext(
      "profile",
      "update",
      boundary.instrumentation
    );
    const result = await executeRoutedOperation<any>(executor, op!, context);

    // Converged: the profile links to the concurrently-created user, not a second one.
    expect(result).toEqual({ id: "pr1", userId: "u1" });
    const users = await (base as any).user.findMany();
    expect(users).toEqual([{ id: "u1", name: "winner" }]); // no duplicate insert
    await (base as any).$disconnect();
  }, 45_000);

  test("inverse-side update split-witness guard: correlated child reparented before batch fails closed", async () => {
    // The correlated update captures profile pr1 (userId u1) at planning. A
    // concurrent reparent moves pr1 off u1 before the batch; the split-witness
    // guard (fk = parent ∧ pk = capturedPk) then fails closed — Observed never updates a
    // profile that no longer belongs to this parent.
    const db = new PGlite();
    const base = createClient({
      schema: nb,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).user.create({ data: { id: "u1", name: "a" } });
    await (base as any).user.create({ data: { id: "u2", name: "b" } });
    await (base as any).profile.create({
      data: { id: "pr1", bio: "old", userId: "u1" },
    });

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer reparents pr1 away from u1.
        await (base as any).profile.update({
          where: { id: "pr1" },
          data: { userId: "u2" },
        });
      },
      { client: db }
    );
    const observed = observeClientOperations({
      schema: nb,
      driver,
    });

    await expect(
      (observed.client as any).user.update({
        where: { id: "u1" },
        data: { profile: { update: { bio: "new" } } },
      })
    ).rejects.toThrow();
    const profile = await (base as any).profile.findMany({
      where: { id: "pr1" },
    });
    expect(profile[0].bio).toBe("old"); // the update never landed
    await (base as any).$disconnect();
  }, 45_000);

  test("family F FOUND-arm guard: correlated child reparented before batch fails closed", async () => {
    // The upsert probe found pr1 (userId u1) at planning → the FOUND (update) arm.
    // A concurrent reparent moves pr1 off u1 before the batch; the found-arm
    // presence guard (fk = parent ∧ pk = capturedPk) then fails closed with the
    // upsert-premise wording — Observed never updates a child that left this parent, and
    // never silently falls through to the create arm.
    const db = new PGlite();
    const base = createClient({
      schema: nb,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).user.create({ data: { id: "u1", name: "a" } });
    await (base as any).user.create({ data: { id: "u2", name: "b" } });
    await (base as any).profile.create({
      data: { id: "pr1", bio: "old", userId: "u1" },
    });

    const driver = new BeforeBatchDriver(
      async () => {
        await (base as any).profile.update({
          where: { id: "pr1" },
          data: { userId: "u2" },
        });
      },
      { client: db }
    );
    const observed = observeClientOperations({
      schema: nb,
      driver,
    });

    await expect(
      (observed.client as any).user.update({
        where: { id: "u1" },
        data: {
          profile: {
            upsert: {
              create: { id: "prX", bio: "created" },
              update: { bio: "updated" },
            },
          },
        },
      })
    ).rejects.toThrow("Nested upsert premise changed for relation 'profile'");
    const profiles = await (base as any).profile.findMany({
      orderBy: { id: "asc" },
    });
    // The update never landed and no create-arm child was inserted.
    expect(profiles).toEqual([{ id: "pr1", bio: "old", userId: "u2" }]);
    await (base as any).$disconnect();
  }, 45_000);
});
