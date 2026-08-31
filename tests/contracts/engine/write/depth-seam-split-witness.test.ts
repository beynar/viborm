import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  depthSeamSchema,
  makeSeamClient,
  makeSeamRunner,
  seedProjects,
} from "@tests/contracts/engine/write/depth-seam-behavior";
import {
  nonPkLocatedDeepCreate,
  TARGET_NOT_FOUND,
} from "@tests/contracts/engine/write/depth-seam-fixtures";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

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

/** The junction family's spelling of the not-found abort. */
const PHOTO_TARGET_NOT_FOUND =
  /Cannot update relation 'photos': target record was not found for this parent\./;
/** The adopt family's found-premise abort (`existsGuard`). */
const UPSERT_PREMISE_CHANGED =
  /Nested upsert premise changed for relation 'projects'\./;

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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
      const db = openBorrowedPGlite();
      const stateClient = makeSeamClient(new PGliteDriver({ client: db }));
      try {
        await syncLiveSchema(stateClient);
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
