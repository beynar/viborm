import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
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
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

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
 * probe RETURNED can tell the two apart, which is the harness the
 * `located-parent-ref` family built for the same claim at the root; this is that
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

type CorruptConfig = ConstructorParameters<
  typeof CorruptDepthLocatePGliteDriver
>[1];

function corruptDriver(
  substrate: "transaction" | "atomic batch",
  db: PGlite,
  namespace: string,
  config: CorruptConfig
): CorruptDepthLocatePGliteDriver {
  return substrate === "transaction"
    ? new CorruptDepthLocatePGliteDriver({ client: db, namespace }, config)
    : new CorruptDepthLocateBatchDriver({ client: db, namespace }, config);
}

/**
 * The suite's private schema on the worker-shared PGlite. Every driver built
 * over `family.database` must carry `family.namespace`, or it addresses an empty
 * `public`.
 */
const getFamily = usePGliteSchemaFamily(depthSeamSchema);

/** The executor's typed refusal when a declared `firstRowField` output is absent. */
const UNRESOLVED_LOCATED_PK = /did not produce row field 'id'/;

describe("N4-U1 located-target provenance (staleness injection at depth)", () => {
  const setupDb = async () => {
    const { database: db, namespace } = getFamily();
    const stateClient = makeSeamClient(
      new PGliteDriver({ client: db, namespace })
    );
    await seedProjects(stateClient);
    return { db, namespace, stateClient };
  };

  test(
    "the deeper foreign key follows the PROBE's returned key, not the where",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, namespace, stateClient } = await setupDb();
      // The probe hands back the DECOY's primary key — a value that EXISTS, so no
      // constraint can catch it, and one the `where` never mentions. If the grandchild
      // still landed on 20 the value would be re-derived from the selector rather than
      // consumed from the row the probe locked, and the wrong-row doctrine would be
      // unenforced at depth exactly as it was in the upsert create-arm bug W4 fixed.
      const update = makeSeamRunner(
        corruptDriver("transaction", db, namespace, {
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
    }
  );

  test(
    "N6-U1: a FILTERED locate's deeper key still comes from the located row",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, namespace, stateClient } = await setupDb();
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
        corruptDriver("transaction", db, namespace, {
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
    }
  );

  test(
    "an UPSERT's update arm and its grandchildren spend ONE located identity",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, namespace, stateClient } = await setupDb();
      // The same instrument on the seam whose write did not address its own probe's row.
      // Its grandchildren take `plannedParentId(probe, id)` and its update used to take
      // the `where`, so a probe returning the DECOY's key split the payload in half with
      // no concurrency at all: the title on the row the selector names, the task on the
      // row the probe returned. Both must follow the probe — the row this part acted on.
      const update = makeSeamRunner(
        corruptDriver("transaction", db, namespace, {
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
    }
  );

  test(
    "the atomic batch re-checks the located key against the selector and aborts",
    {
      timeout: 30_000,
    },
    async () => {
      const { db, namespace, stateClient } = await setupDb();
      // Same corruption, other substrate. The batch's split-witness presence guard
      // re-asserts `selector AND fk = parent AND pk = <located>` on one row, so a
      // located key that does not belong to the named target can never reach a write:
      // the guard finds nothing and the batch rolls back. Stronger than the transaction
      // leg, and for that reason blind to provenance — which is why the claim above is
      // measured on the substrate that lets the value through.
      const update = makeSeamRunner(
        corruptDriver("atomic batch", db, namespace, {
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
    }
  );

  for (const substrate of ["transaction", "atomic batch"] as const) {
    test(
      `a probe row without the located key fails closed at planning (${substrate})`,
      {
        timeout: 30_000,
      },
      async () => {
        const { db, namespace, stateClient } = await setupDb();
        // The deeper edges Ref a DECLARED `firstRowField` output of the probe, not a raw
        // row read — which is what makes an absent value a typed planning failure before
        // any write instead of an `undefined` reaching the INSERT as a NULL foreign key.
        const update = makeSeamRunner(
          corruptDriver(substrate, db, namespace, {
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
      }
    );
  }
});
