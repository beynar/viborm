import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import type { StatementStep } from "../../src/query-engine-v2/OperationFragment";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { batchIsAtomicUnit } from "../fixtures/atomic-unit-batch";
import {
  depthSeamSchema,
  makeSeamClient,
  makeSeamEngine,
  makeSeamRunner,
  runDepthSeamBehavior,
  seedProjects,
} from "./depth-seam-behavior";

/**
 * N4 — the depth seams, on the always-available substrate pair.
 *
 * The shared suite (`depth-seam-behavior.ts`, run here and by every driver leg)
 * carries the assertions. This file only supplies the two PGlite substrates, so the
 * whole N4 surface is exercised on `pnpm test` without a container: a real
 * transaction, and a driver forced to lower the same plan into a single atomic batch.
 */
class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

/**
 * N4-U1's PROVENANCE instrument, one level below the one N1 built.
 *
 * The shared suite's decoys catch "take the first row" and any scan-shaped resolution,
 * but they cannot catch a RE-READ: every decoy differs from its target in the very
 * column the `where` names (`code: 'P-DECOY'` vs `'P-TARGET'`), so re-resolving that
 * same selector a second time lands on the same row and every assertion still passes.
 * The claim N4-U1 actually makes is narrower than "the right row" — it is that the
 * deeper foreign key comes from THE ROW THIS PART'S PROBE LOCKED (`forUpdate` in
 * transaction mode), never from consulting the `where` again. Only corrupting what that
 * probe RETURNED can tell the two apart, which is the harness
 * `located-parent-ref.test.ts` built for the same claim at the root; this is that
 * harness aimed at the depth probe.
 */
class CorruptDepthLocatePGliteDriver extends PGliteDriver {
  private readonly table: string;
  private readonly column: string;
  private readonly mode: "wrong" | "drop";
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: {
      table: string;
      column: string;
      mode: "wrong" | "drop";
      wrongValue?: unknown;
    }
  ) {
    super(options);
    this.table = config.table;
    this.column = config.column;
    this.mode = config.mode;
    this.wrongValue = config.wrongValue;
  }

  private corrupt<T>(sql: string, result: QueryResult<T>): QueryResult<T> {
    const isLocate =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes(this.table) &&
      result.rows.length > 0;
    if (!isLocate) return result;
    // One shot: the FIRST read of the target's table is this part's probe. A later read
    // of the same table (the batch substrate's presence guard) sees the truth, so the
    // corruption is a property of the located VALUE and not of the whole connection.
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        if (this.mode === "drop") delete next[this.column];
        else next[this.column] = this.wrongValue;
        return next as T;
      }),
    };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.execute<T>(client, sql, params, context)
    );
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.executeRaw<T>(client, sql, params, context)
    );
  }
}

/** The same corruption on the substrate that lowers the plan into one atomic batch. */
class CorruptDepthLocateBatchDriver extends CorruptDepthLocatePGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

/**
 * The SPLIT-WITNESS instrument (W4's window, aimed one level down).
 *
 * A concurrent, already-committed writer moves the NON-PK unique the payload names from
 * the row the planning probe located to a DIFFERENT row — in the gap between planning
 * and the atomic unit, which is the window only the batch substrate has (in transaction
 * mode the probe holds that row `FOR UPDATE`, so the mover cannot commit ahead of us;
 * that is why this instrument is batch-only, and why the shape's transaction leg is the
 * ordinary one the behavior suite already runs on both substrates).
 *
 * Once N4-U1 let ANY unique name a nested target, "the selector's row" and "the row the
 * probe located" stopped being the same literal. A seam that still addresses the
 * selector writes the REPLACEMENT — and, because these arms also assign the parent
 * foreign key, reparents it out of whatever parent owned it — while the arm's
 * grandchildren follow the located key. One nested write, two rows. The three seams must
 * all refuse instead, each in its own family's wording.
 */
class MoveUniqueBeforeBatchDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private fired = false;
  private readonly mutations: readonly string[];

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    mutations: readonly string[]
  ) {
    super(options);
    this.mutations = mutations;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    // Fire before the operation's compiled ATOMIC UNIT, not the first batch of
    // any kind: planning reads ride a batch too once grouped by level (PLAN
    // Phase 6.1), and the move has to land AFTER the seam located its target.
    if (!this.fired && batchIsAtomicUnit(queries)) {
      this.fired = true;
      for (const statement of this.mutations) {
        await this.executeRaw(client, statement, []);
      }
    }
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

/** Free `P-TARGET` from project 20 (the located row) and hand it to project 10 — a
 *  project of a DIFFERENT workspace, so a seam that writes the selector's row both
 *  edits a row it never located and steals it from another parent. */
const MOVE_PROJECT_CODE = [
  `UPDATE "n4_seam_projects" SET "code" = 'P-MOVED' WHERE "id" = 20`,
  `UPDATE "n4_seam_projects" SET "code" = 'P-TARGET' WHERE "id" = 10`,
];

/** The junction analogue: the album's own membership holds BOTH photos, so the
 *  replacement row is a legitimate member and only the captured primary key can tell
 *  the two apart. */
const MOVE_PHOTO_SLUG = [
  `UPDATE "n4_seam_photos" SET "slug" = 'moved' WHERE "id" = 20`,
  `UPDATE "n4_seam_photos" SET "slug" = 'target' WHERE "id" = 10`,
];

type CorruptConfig = ConstructorParameters<
  typeof CorruptDepthLocatePGliteDriver
>[1];

function corruptDriver(
  substrate: "transaction" | "atomic batch",
  db: PGlite,
  config: CorruptConfig
): CorruptDepthLocatePGliteDriver {
  return substrate === "transaction"
    ? new CorruptDepthLocatePGliteDriver({ client: db }, config)
    : new CorruptDepthLocateBatchDriver({ client: db }, config);
}

/** The executor's typed refusal when a declared `firstRowField` output is absent. */
const UNRESOLVED_LOCATED_PK = /did not produce row field 'id'/;
/** V1's verbatim not-found abort, spelled in full: a bare `/Cannot update/` also matches
 *  the occupied-slot rejection, and this arm must name the failure it means. */
const TARGET_NOT_FOUND =
  /Cannot update relation 'projects': target record was not found for this parent\./;
/** The junction family's spelling of the same abort. */
const PHOTO_TARGET_NOT_FOUND =
  /Cannot update relation 'photos': target record was not found for this parent\./;
/** The adopt family's found-premise abort (`existsGuard`). */
const UPSERT_PREMISE_CHANGED =
  /Nested upsert premise changed for relation 'projects'\./;

/** The N4-U1 payload the whole instrument turns on: a nested target named by a
 *  NON-primary-key unique, carrying a deeper create whose foreign key can only be the
 *  target's primary key. */
const nonPkLocatedDeepCreate = {
  where: { id: 2 },
  data: {
    projects: {
      update: {
        where: { code: "P-TARGET" },
        data: { title: "moved", tasks: { create: { id: 100, label: "deep" } } },
      },
    },
  },
};

describe("N4 — depth-seam boundaries (PGlite)", () => {
  runDepthSeamBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver(),
  });
  runDepthSeamBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver(),
  });
});

describe("N4-U1 located-target provenance (staleness injection at depth)", () => {
  const setupDb = async () => {
    const db = new PGlite();
    const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
    await push(stateClient, { force: true });
    await seedProjects(stateClient);
    return { db, stateClient };
  };

  test(
    "the deeper foreign key follows the PROBE's returned key, not the where",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, stateClient } = await setupDb();
      // The probe hands back the DECOY's primary key — a value that EXISTS, so no
      // constraint can catch it, and one the `where` never mentions. If the grandchild
      // still landed on 20 the value would be re-derived from the selector rather than
      // consumed from the row the probe locked, and the wrong-row doctrine would be
      // unenforced at depth exactly as it was in the upsert create-arm bug W4 fixed.
      const update = makeSeamRunner(
        corruptDriver("transaction", db, {
          table: "n4_seam_projects",
          column: "id",
          mode: "wrong",
          wrongValue: 10,
        })
      );
      await update(
        "workspace",
        depthSeamSchema.workspace,
        nonPkLocatedDeepCreate
      );
      await expect(
        stateClient.task.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([{ id: 100, label: "deep", projectId: 10 }]);
      // ONE identity, not two: the self-UPDATE addresses the same corrupted key the
      // grandchild spent, so the row the `where` names is untouched.
      await expect(
        stateClient.project.findUnique({ where: { id: 10 } })
      ).resolves.toMatchObject({ title: "moved" });
      await expect(
        stateClient.project.findUnique({ where: { id: 20 } })
      ).resolves.toMatchObject({ title: "same" });
      await stateClient.$disconnect();
    }
  );

  test(
    "N6-U1: a FILTERED locate's deeper key still comes from the located row",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, stateClient } = await setupDb();
      // The N1/N4-U1 provenance instrument aimed at an EXTENDED nested selector.
      //
      // The state assertions in the behavior suite cannot separate the two
      // provenances here: the filter half is ANDed into the locate, so a branch that
      // names the located row's own value agrees with the located row by
      // construction, and one that names another row's makes the locate find NOTHING.
      // Only corrupting what the probe RETURNED can tell "the value came from the row
      // this step acted on" from "the value was re-derived by re-reading the selector".
      //
      // So: the selector carries a real filter, the probe hands back the DECOY's key
      // (a value that EXISTS — no constraint can catch it), and the grandchild must
      // follow the corrupted key. If it landed on 20 the engine would be consulting
      // the `where` a second time, which is the wrong-row doctrine's exact prohibition
      // and the bug class W4 fixed at the root.
      const update = makeSeamRunner(
        corruptDriver("transaction", db, {
          table: "n4_seam_projects",
          column: "id",
          mode: "wrong",
          wrongValue: 10,
        })
      );
      await update("workspace", depthSeamSchema.workspace, {
        where: { id: 2 },
        data: {
          projects: {
            update: {
              where: { code: "P-TARGET", title: "same" },
              data: {
                title: "moved",
                tasks: { create: { id: 130, label: "filtered-deep" } },
              },
            },
          },
        },
      });
      await expect(
        stateClient.task.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([{ id: 130, label: "filtered-deep", projectId: 10 }]);
      // ONE identity, not two: the self-UPDATE spent the same corrupted key.
      await expect(
        stateClient.project.findUnique({ where: { id: 10 } })
      ).resolves.toMatchObject({ title: "moved" });
      await expect(
        stateClient.project.findUnique({ where: { id: 20 } })
      ).resolves.toMatchObject({ title: "same" });
      await stateClient.$disconnect();
    }
  );

  test(
    "an UPSERT's update arm and its grandchildren spend ONE located identity",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, stateClient } = await setupDb();
      // The same instrument on the seam whose write did not address its own probe's row.
      // Its grandchildren take `plannedParentId(probe, id)` and its update used to take
      // the `where`, so a probe returning the DECOY's key split the payload in half with
      // no concurrency at all: the title on the row the selector names, the task on the
      // row the probe returned. Both must follow the probe — the row this part acted on.
      const update = makeSeamRunner(
        corruptDriver("transaction", db, {
          table: "n4_seam_projects",
          column: "id",
          mode: "wrong",
          wrongValue: 10,
        })
      );
      await update("workspace", depthSeamSchema.workspace, {
        where: { id: 2 },
        data: {
          projects: {
            upsert: {
              where: { code: "P-TARGET" },
              update: {
                title: "moved",
                tasks: { create: { id: 100, label: "deep" } },
              },
              create: { id: 999, code: "P-TARGET", title: "unused" },
            },
          },
        },
      });
      await expect(
        stateClient.task.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([{ id: 100, label: "deep", projectId: 10 }]);
      await expect(
        stateClient.project.findUnique({ where: { id: 10 } })
      ).resolves.toMatchObject({ title: "moved" });
      await expect(
        stateClient.project.findUnique({ where: { id: 20 } })
      ).resolves.toMatchObject({ title: "same" });
      await stateClient.$disconnect();
    }
  );

  test(
    "the atomic batch re-checks the located key against the selector and aborts",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, stateClient } = await setupDb();
      // Same corruption, other substrate. The batch's split-witness presence guard
      // re-asserts `selector AND fk = parent AND pk = <located>` on one row, so a
      // located key that does not belong to the named target can never reach a write:
      // the guard finds nothing and the batch rolls back. Stronger than the transaction
      // leg, and for that reason blind to provenance — which is why the claim above is
      // measured on the substrate that lets the value through.
      const update = makeSeamRunner(
        corruptDriver("atomic batch", db, {
          table: "n4_seam_projects",
          column: "id",
          mode: "wrong",
          wrongValue: 10,
        })
      );
      await expect(
        update("workspace", depthSeamSchema.workspace, nonPkLocatedDeepCreate)
      ).rejects.toThrow(TARGET_NOT_FOUND);
      await expect(stateClient.task.findMany({})).resolves.toEqual([]);
      await expect(
        stateClient.project.findUnique({ where: { id: 20 } })
      ).resolves.toMatchObject({ title: "same" });
      await stateClient.$disconnect();
    }
  );

  for (const substrate of ["transaction", "atomic batch"] as const) {
    test(
      `a probe row without the located key fails closed at planning (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const { db, stateClient } = await setupDb();
        // The deeper edges Ref a DECLARED `firstRowField` output of the probe, not a raw
        // row read — which is what makes an absent value a typed planning failure before
        // any write instead of an `undefined` reaching the INSERT as a NULL foreign key.
        const update = makeSeamRunner(
          corruptDriver(substrate, db, {
            table: "n4_seam_projects",
            column: "id",
            mode: "drop",
          })
        );
        await expect(
          update("workspace", depthSeamSchema.workspace, nonPkLocatedDeepCreate)
        ).rejects.toThrow(UNRESOLVED_LOCATED_PK);
        await expect(stateClient.task.findMany({})).resolves.toEqual([]);
        await expect(
          stateClient.project.findUnique({ where: { id: 20 } })
        ).resolves.toMatchObject({ title: "same" });
        await stateClient.$disconnect();
      }
    );
  }
});

describe("N4-U1 split-witness: the unique moves between planning and the batch", () => {
  /** The state every arm must observe afterwards: the concurrent writer's move stands,
   *  and this operation wrote NOTHING — no scalar edit, no reparent, no grandchild. */
  const untouchedProjects = [
    { id: 10, code: "P-TARGET", title: "same", workspaceId: 1 },
    { id: 20, code: "P-MOVED", title: "same", workspaceId: 2 },
  ];

  test(
    "a nested update by a non-PK unique refuses (RelationWritePart)",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await seedProjects(stateClient);
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, MOVE_PROJECT_CODE)
        );
        await expect(
          update("workspace", depthSeamSchema.workspace, nonPkLocatedDeepCreate)
        ).rejects.toThrow(TARGET_NOT_FOUND);
        await expect(
          stateClient.project.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual(untouchedProjects);
        await expect(stateClient.task.findMany({})).resolves.toEqual([]);
      } finally {
        await stateClient.$disconnect();
      }
    }
  );

  test(
    "a to-many upsert by a non-PK unique refuses (RelationUpsertPart)",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await seedProjects(stateClient);
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, MOVE_PROJECT_CODE)
        );
        // The seam whose write did NOT address the row its own probe located. Its update
        // arm wrote `WHERE code = 'P-TARGET'` while its grandchildren took the probe's
        // captured key, so this exact payload used to land the title on project 10 (never
        // located, and reparented from workspace 1 into 2) and the task on project 20.
        await expect(
          update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET" },
                  update: {
                    title: "moved",
                    tasks: { create: { id: 100, label: "deep" } },
                  },
                  create: { id: 999, code: "P-TARGET", title: "unused" },
                },
              },
            },
          })
        ).rejects.toThrow(UPSERT_PREMISE_CHANGED);
        await expect(
          stateClient.project.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual(untouchedProjects);
        await expect(stateClient.task.findMany({})).resolves.toEqual([]);
      } finally {
        await stateClient.$disconnect();
      }
    }
  );

  test(
    "the SCALAR-ONLY spelling of that upsert refuses too",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await seedProjects(stateClient);
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, MOVE_PROJECT_CODE)
        );
        // No grandchildren, so nothing SPLITS — but the arm still wrote the selector's
        // row, which is the wrong row and another parent's. The located identity is what
        // the write addresses now, so the same pin catches both spellings.
        await expect(
          update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET" },
                  update: { title: "moved" },
                  create: { id: 999, code: "P-TARGET", title: "unused" },
                },
              },
            },
          })
        ).rejects.toThrow(UPSERT_PREMISE_CHANGED);
        await expect(
          stateClient.project.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual(untouchedProjects);
      } finally {
        await stateClient.$disconnect();
      }
    }
  );

  test(
    "a to-many upsert whose unique moves WITHIN the same parent refuses",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await seedProjects(stateClient);
        await stateClient.project.create({
          data: { id: 30, code: "P-SIBLING", title: "same", workspaceId: 2 },
        });
        // The conjunct nothing else can see. The replacement is a SIBLING under the very
        // same parent, so `fk = <parent>` is still satisfied and the write addresses the
        // located row either way — what stopped being true is only that the located row
        // is the one the selector NAMES, which is the premise the found/create decision
        // was made on. `RelationWritePart`'s guard has always pinned it; this seam owes
        // the same answer to the same payload.
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, [
            `UPDATE "n4_seam_projects" SET "code" = 'P-MOVED' WHERE "id" = 20`,
            `UPDATE "n4_seam_projects" SET "code" = 'P-TARGET' WHERE "id" = 30`,
          ])
        );
        await expect(
          update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET" },
                  update: { title: "moved" },
                  create: { id: 999, code: "P-TARGET", title: "unused" },
                },
              },
            },
          })
        ).rejects.toThrow(UPSERT_PREMISE_CHANGED);
        await expect(
          stateClient.project.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 10, code: "P-DECOY", title: "same", workspaceId: 1 },
          { id: 20, code: "P-MOVED", title: "same", workspaceId: 2 },
          { id: 30, code: "P-TARGET", title: "same", workspaceId: 2 },
        ]);
      } finally {
        await stateClient.$disconnect();
      }
    }
  );

  test(
    "a to-many upsert whose located row is concurrently REPARENTED refuses",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await seedProjects(stateClient);
        // The other half of what the arm's decision read. The unique does not move here —
        // the located row is handed to ANOTHER parent — so the captured-key pin alone is
        // satisfied and only `fk = <parent>` can see it. Left unpinned, this arm's own FK
        // assignment silently steals the row back into a parent it no longer belongs to,
        // on the strength of a correlation that stopped being true.
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, [
            `UPDATE "n4_seam_projects" SET "workspaceId" = 1 WHERE "id" = 20`,
          ])
        );
        await expect(
          update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET" },
                  update: { title: "moved" },
                  create: { id: 999, code: "P-TARGET", title: "unused" },
                },
              },
            },
          })
        ).rejects.toThrow(UPSERT_PREMISE_CHANGED);
        await expect(
          stateClient.project.findUnique({ where: { id: 20 } })
        ).resolves.toEqual({
          id: 20,
          code: "P-TARGET",
          title: "same",
          workspaceId: 1,
        });
      } finally {
        await stateClient.$disconnect();
      }
    }
  );

  test(
    "N6-U1: a to-many upsert whose FILTERED column moves before the batch refuses",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await seedProjects(stateClient);
        // The half of the found premise only this instrument can see.
        //
        // `RelationWritePart` cannot split: its probe and its batch guard are the SAME
        // statement (`correlatedProbeStatement`), so a filter given to one is given to
        // both by construction. `RelationUpsertPart` CAN: its probe compiles the whole
        // selector through `buildFindUnique`, while `foundGuardStatement` assembles the
        // conjuncts itself — so the filter half can be dropped there ALONE, and the
        // guard then re-asserts a strictly weaker premise than the one the probe made.
        //
        // Nothing already in the estate can tell: the behaviour arms all decide the
        // found/create question BEFORE the batch, and both spellings of the guard agree
        // on quiescent state. Only a concurrent writer touching the FILTERED column —
        // not the unique, which every other arm here moves — separates them. `title` is
        // exactly that column: after the move, `code = 'P-TARGET'` still names project
        // 20 and it is still workspace 2's, so the captured-PK and FK conjuncts both
        // hold, and only `title = 'same'` is false.
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, [
            `UPDATE "n4_seam_projects" SET "title" = 'changed' WHERE "id" = 20`,
          ])
        );
        await expect(
          update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET", title: "same" },
                  update: { title: "moved" },
                  create: { id: 999, code: "P-FRESH", title: "unused" },
                },
              },
            },
          })
        ).rejects.toThrow(UPSERT_PREMISE_CHANGED);
        // The concurrent writer's edit stands and this operation wrote nothing — not the
        // adopt arm's title, and not the create arm either.
        await expect(
          stateClient.project.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 10, code: "P-DECOY", title: "same", workspaceId: 1 },
          { id: 20, code: "P-TARGET", title: "changed", workspaceId: 2 },
        ]);
      } finally {
        await stateClient.$disconnect();
      }
    }
  );

  test(
    "an m2m update by a non-PK unique refuses (RelationJunctionPart)",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await push(stateClient, { force: true });
        await stateClient.photo.create({
          data: { id: 10, slug: "decoy", caption: "c" },
        });
        await stateClient.photo.create({
          data: { id: 20, slug: "target", caption: "c" },
        });
        await stateClient.album.create({
          data: {
            id: 1,
            title: "a",
            photos: { connect: [{ id: 20 }, { id: 10 }] },
          },
        });
        const update = makeSeamRunner(
          new MoveUniqueBeforeBatchDriver({ client: db }, MOVE_PHOTO_SLUG)
        );
        await expect(
          update("album", depthSeamSchema.album, {
            where: { id: 1 },
            data: {
              photos: {
                update: {
                  where: { slug: "target" },
                  data: {
                    caption: "moved",
                    marks: { create: { id: 200, text: "deep" } },
                  },
                },
              },
            },
          })
        ).rejects.toThrow(PHOTO_TARGET_NOT_FOUND);
        await expect(
          stateClient.photo.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 10, slug: "target", caption: "c" },
          { id: 20, slug: "moved", caption: "c" },
        ]);
        await expect(stateClient.mark.findMany({})).resolves.toEqual([]);
      } finally {
        await stateClient.$disconnect();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// N6-U1 STRUCTURAL: the nested create-arm `racePin`, and its deliberate absence.
//
// The behavior suite proves the create arm RUNS when the filter excludes the
// located row. This proves that arm is not RETRYABLE, which no state assertion
// can see — a withheld pin and an attached one persist identical rows.
//
// A `racePin` claims "the probe proved unique key K was free, so a violation on K
// is someone else taking it between our read and our write — re-plan and adopt".
// A FILTERED probe proves something strictly weaker: no row matches `K AND
// filters`. A row on K may exist and be EXCLUDED by the filter, and then the
// INSERT's violation is a genuine conflict that re-planning reproduces forever —
// one pointless retry, and a real conflict mis-reported as a race. This is the
// root's rule (`UpsertOperation.createArmRacePin`, pinned in
// `extended-where-unique.test.ts`) reaching depth, and it lives inside
// `childRacePin` so that no call site can forget it.
//
// The PLAIN-selector test is the falsification: without it these assertions would
// pass just as well against an implementation that never pins a nested arm at all.
// ---------------------------------------------------------------------------

/** The write steps of a nested upsert whose child probe found NOTHING — the arm
 *  under test. The root locate still yields its row (the tree must compile); only
 *  the CHILD probe's emptiness selects the create arm. */
function nestedUpsertCreateArmWrites(
  where: Record<string, unknown>
): StatementStep[] {
  const engine = makeSeamEngine(new PGliteDriver());
  const operation = new UpdateOperation(engine, depthSeamSchema.workspace, {
    where: { id: 2 },
    data: {
      projects: {
        upsert: {
          where,
          create: { id: 30, code: "P-FRESH", title: "fresh" },
          update: { title: "updated" },
        },
      },
    },
  });
  const planning = operation.planning();
  const known: Record<string, unknown> = {};
  for (const step of planning.steps) known[`${step.id}.rows`] = [];
  const [rootLocate] = planning.steps;
  if (rootLocate) known[`${rootLocate.id}.rows`] = [{ id: 2 }];
  return operation
    .compile(known)
    .steps.filter((step): step is StatementStep => step.kind === "write");
}

/** The same arm at the JUNCTION position. `RelationJunctionPart`'s upsert create arm
 *  is a second call site of `childInsert`, and it is the one no test stood in front of:
 *  the `connectOrCreate` witness in `m2m-mutation.test.ts` pins the ADOPT slot's insert,
 *  and the pair below pins a to-many Part — neither compiles this slot. The membership
 *  and global probes are both driven empty here, which is the create arm. */
function junctionUpsertCreateArmWrites(
  where: Record<string, unknown>
): StatementStep[] {
  const engine = makeSeamEngine(new PGliteDriver());
  const operation = new UpdateOperation(engine, depthSeamSchema.album, {
    where: { id: 1 },
    data: {
      photos: {
        upsert: {
          where,
          create: { id: 30, slug: "fresh", caption: "f" },
          update: { caption: "updated" },
        },
      },
    },
  });
  const planning = operation.planning();
  const known: Record<string, unknown> = {};
  for (const step of planning.steps) known[`${step.id}.rows`] = [];
  const [rootLocate] = planning.steps;
  if (rootLocate) known[`${rootLocate.id}.rows`] = [{ id: 1 }];
  return operation
    .compile(known)
    .steps.filter((step): step is StatementStep => step.kind === "write");
}

describe("N6-U1 nested create-arm racePin", () => {
  test("a PLAIN nested selector pins the create arm as raceable", () => {
    const pinned = nestedUpsertCreateArmWrites({ code: "P-TARGET" }).filter(
      (step) => step.racePin
    );
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.racePin?.fields).toEqual(["code"]);
  });

  test("an EXTENDED nested selector withholds the create-arm racePin", () => {
    const writes = nestedUpsertCreateArmWrites({
      code: "P-TARGET",
      title: "not-the-title",
    });
    expect(writes.every((step) => step.racePin === undefined)).toBe(true);
  });

  test("the withheld pin is about the FILTER, not the discriminator's shape", () => {
    // Same discriminator, the filter smuggled through a boolean combinator.
    const writes = nestedUpsertCreateArmWrites({
      code: "P-TARGET",
      AND: [{ title: "not-the-title" }],
    });
    expect(writes.every((step) => step.racePin === undefined)).toBe(true);
  });

  test("the JUNCTION upsert's create arm obeys the same rule at its own site", () => {
    // The behavior file proves this arm RUNS on an excluding filter; this proves the
    // insert it emits carries the pin under a plain selector and none under an
    // extended one. Both halves at once, because at this site they are one fact: the
    // slot hands its selector to `childInsert`, and `childRacePin` decides. Only the
    // junction row follows the child INSERT, and it pins nothing.
    const plain = junctionUpsertCreateArmWrites({ slug: "target" }).filter(
      (step) => step.racePin
    );
    expect(plain).toHaveLength(1);
    expect(plain[0]?.racePin?.fields).toEqual(["slug"]);
    const extended = junctionUpsertCreateArmWrites({
      slug: "target",
      caption: "not-the-caption",
    });
    expect(extended.every((step) => step.racePin === undefined)).toBe(true);
  });
});
