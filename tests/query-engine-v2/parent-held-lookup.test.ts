import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { batchIsAtomicUnit } from "../fixtures/atomic-unit-batch";
import {
  makeLookupClient,
  runParentHeldLookupBehavior,
  seedLookupBed,
} from "./parent-held-lookup-behavior";

/** The atomic-batch substrate: one transaction, every statement pre-materialized. */
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

runParentHeldLookupBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

runParentHeldLookupBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// The PROVENANCE of the folded value. The behavior suite's decoys catch a fold
// that took the wrong row; they cannot say WHICH read the written value came
// from, and for the lookup fold that is the whole claim.
// ---------------------------------------------------------------------------

/**
 * Rewrites what the arm's existence PROBE reported, pointing its referenced column
 * at the decoy. Nothing else on the connection is touched.
 *
 * The claim this instrument tests is the one the create root already makes
 * (`CreateOperation.toOneFkAssign`): the probe answers EXISTENCE, and the value
 * written into the foreign key is read by the lookup subquery inside the UPDATE
 * itself. So a corrupted probe row must NOT move the write — the fold has no
 * second, re-derived provenance to be pulled away by. An implementation that
 * spent the probe's value instead (the other defensible design) would bind the
 * decoy here, and that is exactly the fork this pin forbids.
 */
class CorruptConnectProbeDriver extends PGliteDriver {
  private armed = true;
  private readonly config: {
    table: string;
    column: string;
    wrongValue: unknown;
  };

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: { table: string; column: string; wrongValue: unknown }
  ) {
    super(options);
    this.config = config;
  }

  private corrupt<T>(
    statement: string,
    result: QueryResult<T>
  ): QueryResult<T> {
    const isProbe =
      this.armed &&
      statement.startsWith("SELECT") &&
      statement.includes(this.config.table) &&
      result.rows.length > 0;
    if (!isProbe) return result;
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...(row as Record<string, unknown>),
        [this.config.column]: this.config.wrongValue,
      })) as T[],
    };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      statement,
      await super.execute<T>(client, statement, params, context)
    );
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      statement,
      await super.executeRaw<T>(client, statement, params, context)
    );
  }
}

describe("E1 U1 — the lookup fold's provenance", () => {
  test(
    "the written key comes from the LOOKUP, not from the probe row",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeLookupClient(new PGliteDriver({ client: db }));
      await push(stateClient, { force: true });
      await seedLookupBed(stateClient);

      // Author 1 is a real, live row, so a wrong provenance is a silent WRONG ROW
      // rather than a foreign-key error: both values are insertable.
      const client = makeLookupClient(
        new CorruptConnectProbeDriver(
          { client: db },
          { table: "e1_authors", column: "id", wrongValue: 1 }
        )
      );
      await expect(
        client.book.update({
          where: { id: 2 },
          data: { author: { connect: { email: "target@x" } } },
        })
      ).resolves.toEqual({ id: 2, title: "book-2", authorId: 2 });
      await expect(
        stateClient.book.findUnique({ where: { id: 2 } })
      ).resolves.toEqual({ id: 2, title: "book-2", authorId: 2 });
      // Only the state client disposes: both clients drive the SAME PGlite
      // instance, and closing it twice is the disconnect error, not a finding.
      await stateClient.$disconnect();
    }
  );

  test(
    "a probe row whose referenced column reads NULL still stops the write",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeLookupClient(new PGliteDriver({ client: db }));
      await push(stateClient, { force: true });
      await seedLookupBed(stateClient);

      // The other half of the same seam: the NULL verdict is taken from the probe
      // row, so corrupting THAT column to null must refuse — the guard and the
      // fold read different things on purpose, and this names which is which.
      const client = makeLookupClient(
        new CorruptConnectProbeDriver(
          { client: db },
          { table: "e1_authors", column: "id", wrongValue: null }
        )
      );
      await expect(
        client.book.update({
          where: { id: 2 },
          data: { author: { connect: { email: "target@x" } } },
        })
      ).rejects.toThrow(
        "Cannot connect relation 'author': the located target's referenced field 'id' is null."
      );
      await expect(
        stateClient.book.findUnique({ where: { id: 2 } })
      ).resolves.toEqual({ id: 2, title: "book-2", authorId: null });
      // Only the state client disposes: both clients drive the SAME PGlite
      // instance, and closing it twice is the disconnect error, not a finding.
      await stateClient.$disconnect();
    }
  );
});

// ---------------------------------------------------------------------------
// The intra-batch VANISH window (E1 U1 carve-out c). The lookup subquery runs
// inside the UPDATE, so it re-reads the target at write time. This measures what
// happens when the target disappears between the planning probe and the batch:
// the arm's own presence guard is what stands there, and this pins its
// attribution rather than assuming it.
// ---------------------------------------------------------------------------

/** Runs `beforeBatch` between planning and the atomic WRITE batch. */
class BeforeBatchLookupDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(
    beforeBatch: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
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

describe("E1 U1 — the guard→UPDATE vanish window", () => {
  test(
    "a target deleted between planning and the batch aborts typed, writing nothing",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeLookupClient(new PGliteDriver({ client: db }));
      await push(stateClient, { force: true });
      await seedLookupBed(stateClient);

      const injector = makeLookupClient(new PGliteDriver({ client: db }));
      const client = makeLookupClient(
        new BeforeBatchLookupDriver(
          async () => {
            // The row the probe found, gone before the UPDATE runs. Without the
            // arm's presence guard the lookup subquery would return no row and the
            // SET would silently write NULL — the very outcome carve-out (a)
            // refuses when the value is NULL for a different reason.
            await injector.book.update({
              where: { id: 1 },
              data: { author: { disconnect: true } },
            });
            await injector.author.delete({ where: { email: "target@x" } });
          },
          { client: db }
        )
      );

      // MEASURED ATTRIBUTION: the connect arm's own presence guard fails first,
      // so this is a NestedWriteError naming the relation — not a foreign-key
      // violation from the driver and not a silent NULL. Nothing is written.
      await expect(
        client.book.update({
          where: { id: 2 },
          data: { author: { connect: { email: "target@x" } } },
        })
      ).rejects.toThrow(NestedWriteError);
      await expect(
        stateClient.book.findUnique({ where: { id: 2 } })
      ).resolves.toEqual({ id: 2, title: "book-2", authorId: null });
      await stateClient.$disconnect();
    }
  );
});
