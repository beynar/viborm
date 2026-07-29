import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import {
  depthSeamSchema,
  makeSeamClient,
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
