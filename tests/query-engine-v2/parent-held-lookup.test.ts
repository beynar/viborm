import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { batchIsAtomicUnit } from "../fixtures/atomic-unit-batch";
import {
  makeLookupClient,
  runBeforeRootSubtreeBehavior,
  runNonPkReferenceBehavior,
  runParentHeldLookupBehavior,
  runUpsertArmRelationBehavior,
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

runBeforeRootSubtreeBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

runBeforeRootSubtreeBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

runUpsertArmRelationBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

runUpsertArmRelationBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

runNonPkReferenceBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

runNonPkReferenceBehavior({
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

// ---------------------------------------------------------------------------
// The REVERSED produced identity (E1 U3, watch item a). The enclosing UPDATE's
// SET reads the key of the row the SUBTREE made, so the identity flows backward
// here: `Ref(subtree-root INSERT, id)`. Only corrupting what that INSERT reported
// can tell "the key its own INSERT produced" from any re-derivation.
// ---------------------------------------------------------------------------

/** One-shot: rewrites the key the FIRST returning INSERT into `table` reported. */
class CorruptSubtreeInsertDriver extends PGliteDriver {
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
    const isProducingInsert =
      this.armed &&
      statement.startsWith("INSERT INTO") &&
      statement.includes(this.config.table) &&
      statement.includes("RETURNING") &&
      result.rows.length > 0;
    if (!isProducingInsert) return result;
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

describe("E1 U3 — the subtree root's produced identity", () => {
  test(
    "the enclosing UPDATE's SET follows the key the SUBTREE's INSERT returned",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeLookupClient(new PGliteDriver({ client: db }));
      await push(stateClient, { force: true });
      await seedLookupBed(stateClient);
      const decoy = await stateClient.magazine.findFirst({
        orderBy: { id: "asc" },
      });

      const client = makeLookupClient(
        new CorruptSubtreeInsertDriver(
          { client: db },
          { table: "e1_magazines", column: "id", wrongValue: decoy?.id }
        )
      );
      // THE CLAIM. The issue's foreign key follows the CORRUPTED returned key —
      // the decoy magazine — because that is what the subtree's own INSERT
      // reported having produced. An implementation that re-read the fresh
      // magazine by its title, or spent the driver's last-insert id independently,
      // would bind the real fresh row and this assertion would fail. Both values
      // are live magazines, so no constraint can stand in for the assertion.
      await client.issue.update({
        where: { id: 1 },
        data: { magazine: { create: { title: "fresh-magazine" } } },
      });
      const magazines = await stateClient.magazine.findMany({
        orderBy: { id: "asc" },
      });
      expect(magazines.map((row) => row.title)).toEqual([
        "decoy-magazine",
        "fresh-magazine",
      ]);
      await expect(
        stateClient.issue.findUnique({ where: { id: 1 } })
      ).resolves.toEqual({ id: 1, name: "issue-1", magazineId: decoy?.id });
      expect(decoy?.id).not.toBe(magazines[1]?.id);
      await stateClient.$disconnect();
    }
  );
});

// ---------------------------------------------------------------------------
// E1 U4 — the TWO-PROBE staleness injection. The relation-carrying upsert arm is
// read TWICE at planning: once by the arm's own probe (which picks found vs
// create) and once by the delegated sub-op's correlated locate (which captures
// the row the arm writes). This pins what happens when the row they both saw is
// gone before the atomic batch runs.
// ---------------------------------------------------------------------------

describe("E1 U4 — the delegated upsert arm's staleness window", () => {
  test(
    "a target that vanishes before the batch aborts with the upsert family's wording",
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
            // Both reads saw author 1. Release the foreign key and delete it, so the
            // premise the arm chose its branch on is false by the time the batch runs.
            await injector.book.update({
              where: { id: 1 },
              data: { author: { disconnect: true } },
            });
            await injector.author.delete({ where: { id: 1 } });
          },
          { client: db }
        )
      );

      // MEASURED OUTCOME (i): a typed abort carrying the UPSERT family's premise
      // wording, from the delegated sub-op's own batch presence guard — not a
      // not-found on a nested update, and not a write landing on some other row.
      // Nothing is written: the atomic unit rolls back whole.
      await expect(
        client.book.update({
          where: { id: 1 },
          data: {
            author: {
              upsert: {
                update: {
                  name: "renamed",
                  awards: { create: { id: 5, title: "medal" } },
                },
                create: { id: 9, email: "fresh@x", name: "never" },
              },
            },
          },
        })
      ).rejects.toThrow("Nested upsert premise changed for relation 'author'.");
      await expect(stateClient.award.findMany({})).resolves.toEqual([]);
      await expect(
        stateClient.author.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([{ id: 2, email: "target@x", name: "target" }]);
      await stateClient.$disconnect();
    }
  );
});

// ---------------------------------------------------------------------------
// E1 U6 — the captured-PK provenance on a NON-primary-key edge. The correlation
// reads one column and the write addresses another, so the two can disagree, and
// only corrupting the probe's returned row can say which one the write follows.
// ---------------------------------------------------------------------------

describe("E1 U6 — the non-PK edge's captured identity", () => {
  test(
    "the arm's UPDATE addresses the primary key the PROBE returned",
    { timeout: 30_000 },
    async () => {
      const db = new PGlite();
      const stateClient = makeLookupClient(new PGliteDriver({ client: db }));
      await push(stateClient, { force: true });
      await seedLookupBed(stateClient);
      await stateClient.holder.update({
        where: { id: 1 },
        data: { badge: { connect: { code: "GOLD" } } },
      });

      // Badge 1 is a live row the corrupted key can legally name, so a wrong
      // provenance is a silent WRONG ROW and not a constraint error. The probe is
      // the FIRST read of `e1_badges` this operation makes.
      const client = makeLookupClient(
        new CorruptConnectProbeDriver(
          { client: db },
          { table: "e1_badges", column: "id", wrongValue: 1 }
        )
      );
      await client.holder.update({
        where: { id: 1 },
        data: { badge: { update: { tier: "platinum" } } },
      });
      // THE CLAIM. The write follows the CORRUPTED captured key — badge 1 — because
      // that is the row the probe reported acting on. An implementation that
      // re-derived the target from the correlation column (`code = 'GOLD'`) would
      // update badge 2 instead, and nothing else in the estate separates the two.
      await expect(
        stateClient.badge.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([
        { id: 1, slug: "codeless", code: null, tier: "platinum" },
        { id: 2, slug: "gold-slug", code: "GOLD", tier: "gold" },
      ]);
      await stateClient.$disconnect();
    }
  );
});
