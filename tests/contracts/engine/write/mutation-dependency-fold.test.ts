import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError } from "@errors";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { sql } from "@sql";
import { postgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { compileMutationDependencyFold } from "@src/query-engine/operations/mutation-projection-fold";
import {
  ref,
  type WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { expectIndivisibleGeneratedOutputRefusal } from "@tests/contracts/engine/write/generated-identity-batch-refusal";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE M (plan §4.5 / §6 M2–M4) — **the PostgreSQL write-dependency fold, and
 * the measurements that decide whether it stays.**
 *
 * A create tree used to send one statement per record because a child INSERT
 * needing the parent's DATABASE-generated key had no way to spell that value
 * inside one command. It has one: PostgreSQL lets a later `WITH` arm read an
 * earlier arm's `RETURNING` relation. `compileMutationDependencyFold` replaces
 * each `OperationValueReference` riding in an arm's `Sql.values` with
 * `(SELECT <column> FROM <producing arm>)`, and Phase 8.2's tree fold — whose
 * every OTHER conjunct these trees already passed — merges them.
 *
 * MEASURED on PGlite (PostgreSQL 16), transaction mode:
 *
 * | payload                                              | before | after |
 * |------------------------------------------------------|-------:|------:|
 * | generated parent + one application-keyed child        |      3 |     1 |
 * | generated parent + two application-keyed children     |      4 |     1 |
 * | generated parent + a `createMany` of children         |      3 |     1 |
 *
 * MySQL and SQLite keep every one of those numbers: `supportsCteWithMutations`
 * is false on both, and the lowerer's first line reads it.
 * `parity-m-create-dag.test.ts` pins their bytes.
 *
 * WHAT THE FOLD DOES NOT REACH, measured rather than assumed. The tree fold's
 * ordering conjunct counts DATABASE-ASSIGNED arms and admits at most one
 * (`foldArmsAreOrderInsensitive`), because PostgreSQL does not specify the order
 * it runs unread data-modifying arms in. A chain of two generated identities —
 * §6 M1's grandchild bullet — therefore still declines, and `parity-m` shape B
 * pins it at four statements. Widening that rule to exempt arms joined by a
 * data-dependency edge is a real semantic extension to a rule argued from
 * "nothing the emitter can spell pins that", and §4.5 asks for the EXISTING rule
 * to pass, so this package does not touch it.
 *
 * THE DECLINES BELOW ARE THE POINT. Before this package, every one of these
 * payloads declined for the same uninteresting reason — it carried a reference.
 * Each one still declines, and now the reason is the one being injected.
 */

const depSchema = (() => {
  const hub = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      spans: s.toMany(() => span),
      tags: s.toMany(() => tag),
      cells: s.toMany(() => cell),
    })
    .map("pm_hubs");
  const span = s
    .model({
      id: s.string().id(),
      body: s.string(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("pm_spans");
  const tag = s
    .model({
      id: s.string().id(),
      hubs: s.toMany(() => hub),
    })
    .map("pm_tags");
  /** A SECOND database-assigned key, for the ordering conjunct's own decline. */
  const cell = s
    .model({
      id: s.int().id().increment(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("pm_cells");
  /**
   * The `producer > 0` chain: an APPLICATION-KEYED root (so the ordering
   * conjunct still sees exactly one database-assigned arm), a `pallet` whose
   * generated key is the produced value, and a `label` that spends it. The
   * producing arm is therefore a SIBLING, not the root — the branch of
   * `armColumnSql` that addresses an arm by its RETURNING FIELD alias.
   *
   * BOTH primary keys are MAPPED to a different column name, which is what makes
   * this fixture discriminate: the wrong convention resolves through the ROOT
   * model and emits `SELECT "crate_pk"` against the pallet's arm.
   */
  const crate = s
    .model({
      id: s.string().id().map("crate_pk"),
      name: s.string(),
      pallets: s.toMany(() => pallet),
    })
    .map("pm_crates");
  const pallet = s
    .model({
      id: s.int().id().increment().map("pallet_pk"),
      crateId: s.string().nullable(),
      crate: s
        .toOne(() => crate)
        .fields("crateId")
        .references("id"),
      labels: s.toMany(() => label),
    })
    .map("pm_pallets");
  const label = s
    .model({
      id: s.string().id(),
      palletId: s.int().nullable(),
      pallet: s
        .toOne(() => pallet)
        .fields("palletId")
        .references("id"),
    })
    .map("pm_labels");
  /**
   * PLAN 10.1 — a model-level `.omit()` over the PRODUCED key.
   *
   * `returningEveryColumn` builds the root arm's `RETURNING` from
   * `getScalarFieldNames` — every scalar, un-omit-filtered — where both
   * public-shape owners filter through `getDefaultScalarFieldNames`. Until this
   * fixture the asymmetry was asserted by its own docblock and nothing else,
   * because no fold test carried an `.omit()` at all: on a model without one the
   * two lists are equal and the difference is unobservable.
   *
   * `vault.id` makes them differ AND makes the difference fatal: it is the
   * DATABASE-GENERATED key the `slot` arm spends, and a key `.omit()` hides from
   * every result — so the outer projection cannot name it, while the sibling
   * arm must read it out of the CTE by column name.
   */
  const vault = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      slots: s.toMany(() => slot),
    })
    .map("pm_vaults")
    .omit({ id: true });
  const slot = s
    .model({
      id: s.string().id(),
      vaultId: s.int().nullable(),
      vault: s
        .toOne(() => vault)
        .fields("vaultId")
        .references("id"),
    })
    .map("pm_slots");
  const node = s
    .model({
      id: s.string().id(),
      label: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("pm_nodes");
  const raceEntry = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      status: s.string(),
    })
    .map("pm_race_entries");
  return {
    hub,
    span,
    tag,
    cell,
    crate,
    pallet,
    label,
    vault,
    slot,
    node,
    raceEntry,
  };
})();

hydrateSchemaNames(depSchema);

const sqliteScalarSchema = {
  entry: s
    .model({
      id: s.int().id().increment(),
      label: s.string().unique(),
    })
    .map("pm_sqlite_entries"),
};
hydrateSchemaNames(sqliteScalarSchema);

/** Records every statement, hooking the PROTECTED seam a transaction-bound
 *  driver delegates back to (delete-fold.test.ts owns the explanation). */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  batchCalls = 0;
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(statement);
    return super.execute<T>(client, statement, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(statement);
    return super.executeRaw<T>(client, statement, params, context);
  }
}

/** The same database on the substrate that CANNOT fold — the equivalence oracle
 *  for every answer below, and the leg that proves the portable series is still
 *  compiled and still correct. */
class BatchOnlyRecordingDriver extends RecordingPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
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

class BeforeAtomicBatchDriver extends BatchOnlyRecordingDriver {
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(database: PGlite, beforeBatch: () => Promise<void>) {
    super({ client: database });
    // Keep this witness on the probe-first RETURNING arm. The targeted
    // `ON CONFLICT` fold has no planning window and owns a different race contract.
    this.adapter.capabilities.supportsTargetedUpsert = false;
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
    return super.executeBatch<T>(client, queries);
  }
}

class BatchOnlyReturningSQLiteDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCalls = 0;

  constructor() {
    super({ dataDir: ":memory:" });
  }

  protected override executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
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

const getFamily = usePGliteSchemaFamily(depSchema);

function drain(driver: RecordingPGliteDriver): string[] {
  return driver.statements.splice(0, driver.statements.length);
}

const foldedInOneStatement = (statements: string[]) =>
  statements.length === 1 && statements[0]?.startsWith("WITH ") === true;

function boot(batch = false) {
  const family = getFamily();
  const driver = batch
    ? new BatchOnlyRecordingDriver({ client: family.database })
    : new RecordingPGliteDriver({ client: family.database });
  return { driver, client: createClient({ schema: depSchema, driver }) };
}

// ---------------------------------------------------------------------------
// M4 — the measurement
// ---------------------------------------------------------------------------

describe("M4 — PostgreSQL statement count, and the answer it must not change", () => {
  test("a generated parent identity spent by one child is ONE statement", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: { name: "H1", spans: { create: { id: "s1", body: "b1" } } },
      select: { id: true, name: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement: three statements became one (parity-m shape A pins the
    // three on every dialect that keeps them).
    expect(statements).toHaveLength(1);
    expect(foldedInOneStatement(statements)).toBe(true);
    expect(created).toEqual({ id: created.id, name: "H1" });
    // …and the child took the key the same command generated.
    expect(await client.span.findMany({ where: { id: "s1" } })).toEqual([
      { id: "s1", body: "b1", hubId: created.id },
    ]);
  });

  test("the batch substrate keeps the exact one-statement fold", async () => {
    const { driver, client } = boot(true);

    driver.recording = true;
    const created = await client.hub.create({
      data: { name: "H2", spans: { create: { id: "s2", body: "b2" } } },
      select: { id: true, name: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(foldedInOneStatement(statements)).toBe(true);
    expect(created).toEqual({ id: created.id, name: "H2" });
    expect(await client.span.findMany({ where: { id: "s2" } })).toEqual([
      { id: "s2", body: "b2", hubId: created.id },
    ]);
  });

  test("an indivisible array keeps a folded create tree and its sibling in one batch", async () => {
    const { driver, client } = boot(true);

    const [created, sibling] = await client.$transaction([
      client.hub.create({
        data: {
          name: "H-array",
          spans: { create: { id: "s-array", body: "array child" } },
        },
        select: { id: true, name: true },
      }),
      client.tag.create({ data: { id: "tag-array" } }),
    ]);

    expect(driver.batchCalls).toBe(1);
    expect(created).toMatchObject({ name: "H-array" });
    expect(sibling).toEqual({ id: "tag-array" });
    expect(await client.span.findMany({ where: { id: "s-array" } })).toEqual([
      {
        id: "s-array",
        body: "array child",
        hubId: created.id,
      },
    ]);
  });

  test("a failing array sibling rolls back the folded create tree", async () => {
    const { client } = boot(true);
    await client.tag.create({ data: { id: "occupied-array-tag" } });

    await expect(
      client.$transaction([
        client.hub.create({
          data: {
            name: "must roll back",
            spans: { create: { id: "rolled-back-span", body: "child" } },
          },
          select: { id: true },
        }),
        client.tag.create({ data: { id: "occupied-array-tag" } }),
      ])
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    expect(await client.hub.count()).toBe(0);
    expect(await client.span.count()).toBe(0);
    expect(await client.tag.findMany()).toEqual([{ id: "occupied-array-tag" }]);
  });

  test("an indivisible array refuses a generated dependency that relation projection prevents folding", async () => {
    const { client } = boot(true);

    await expectIndivisibleGeneratedOutputRefusal(
      client.$transaction([
        client.hub.create({
          data: {
            name: "unfoldable array",
            spans: { create: { id: "unfoldable-span", body: "child" } },
          },
          include: { spans: true },
        }),
        client.tag.create({ data: { id: "must-not-run" } }),
      ]),
      "hub.create.id"
    );
    expect(await client.hub.count()).toBe(0);
    expect(await client.span.count()).toBe(0);
    expect(await client.tag.count()).toBe(0);
  });

  test("TWO children spending one produced identity are ONE statement, both linked", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H3",
        spans: {
          create: [
            { id: "s3a", body: "b3a" },
            { id: "s3b", body: "b3b" },
          ],
        },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Four statements before. The producing arm runs ONCE however many arms
    // read it, which is what makes both children carry the same key.
    expect(statements).toHaveLength(1);
    expect(
      await client.span.findMany({
        where: { hubId: created.id },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "s3a", body: "b3a", hubId: created.id },
      { id: "s3b", body: "b3b", hubId: created.id },
    ]);
    expect(await client.hub.findMany({ where: { name: "H3" } })).toHaveLength(
      1
    );
  });

  test("a createMany of children spending the produced identity is ONE statement", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H4",
        spans: {
          createMany: {
            data: [
              { id: "s4a", body: "b4a" },
              { id: "s4b", body: "b4b" },
            ],
          },
        },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(foldedInOneStatement(statements)).toBe(true);
    expect(
      await client.span.findMany({
        where: { hubId: created.id },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "s4a", body: "b4a", hubId: created.id },
      { id: "s4b", body: "b4b", hubId: created.id },
    ]);
  });

  test("the folded and portable paths raise the SAME error for a duplicate row", async () => {
    // §4.5's "no row can be written twice" in the only shape a create tree can
    // build one: two arms inserting the same primary key. PostgreSQL raises the
    // unique violation inside the one command exactly as the series raises it
    // across three, and neither leaves a row behind.
    const folded = boot();
    await expect(
      folded.client.hub.create({
        data: {
          name: "H5",
          spans: {
            create: [
              { id: "dup", body: "x" },
              { id: "dup", body: "y" },
            ],
          },
        },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await folded.client.hub.findMany({ where: { name: "H5" } })).toEqual(
      []
    );

    const portable = boot(true);
    await expect(
      portable.client.hub.create({
        data: {
          name: "H5b",
          spans: {
            create: [
              { id: "dup", body: "x" },
              { id: "dup", body: "y" },
            ],
          },
        },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(
      await portable.client.hub.findMany({ where: { name: "H5b" } })
    ).toEqual([]);
    expect(
      await portable.client.span.findMany({ where: { id: "dup" } })
    ).toEqual([]);
  });

  /**
   * THE `producer > 0` BRANCH, which every measurement above misses: each of them
   * puts the generated key on the ROOT, so each reads `__viborm_mutation` and
   * exercises only `armColumnSql`'s column-name convention. Here the producing
   * arm is a SIBLING, addressed by its RETURNING FIELD alias.
   *
   * FALSIFIED against `armColumnSql` (original restored from a scratchpad copy):
   * collapsing the two conventions onto `getColumnName(scope.model, …)` — the
   * ROOT model's mapping — turned this test alone red with PostgreSQL's
   * `column "crate_pk" does not exist`. With UNMAPPED keys the same mutation
   * passes, which is why both primary keys in this fixture are mapped.
   */
  test("a SIBLING arm's generated identity is spent by a THIRD arm", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.crate.create({
      data: {
        id: "cr1",
        name: "C",
        pallets: { create: { labels: { create: { id: "lb1" } } } },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Four statements before: root INSERT, pallet INSERT, label INSERT, terminal.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      '"__viborm_write_0" AS (INSERT INTO "public"."pm_pallets" ("crateId") VALUES (CAST($3 AS TEXT)) RETURNING "pallet_pk" AS "id")'
    );
    // The FIELD alias, not the column, and not the root's mapping either.
    expect(statements[0]).toContain('(SELECT "id" FROM "__viborm_write_0")');
    expect(created).toEqual({ id: "cr1" });

    // PLAN 10.1 — the OTHER end of the same convention, byte-exact on the root
    // arm's `RETURNING` itself. Every root-arm `RETURNING` pin in the estate
    // (`fresh-produced-field`, `parity-f`, `parity-h`) uses UNMAPPED keys, and
    // the reader-side pin in M2 below reads `"box_pk"` out of a list no test
    // asserts — so a `returningEveryColumn` rebuilt as `buildSelect`'s aliased
    // projection would leave both green and only fail against a live database.
    // Here the mapped column and the field alias sit in ONE statement, one on
    // each side: the CTE carries `"crate_pk"`, the outer projection renames it.
    expect(statements[0]).toContain('RETURNING "crate_pk", "name")');
    expect(statements[0]).not.toContain('RETURNING "crate_pk" AS "id"');
    expect(statements[0]).toContain(
      'SELECT "t0"."crate_pk" AS "id" FROM "__viborm_mutation" AS "t0"'
    );

    const [pallet] = await client.pallet.findMany({});
    expect(await client.label.findMany({})).toEqual([
      { id: "lb1", palletId: pallet?.id },
    ]);
  });

  /**
   * PLAN 10.1 — the CTE's `RETURNING` is NOT the `.omit()`-filtered set, and the
   * claim is falsified here rather than asserted in prose.
   *
   * `mutation-projection-fold.ts` says so in its docblock ("Not the
   * `.omit()`-filtered set either: the CTE is plumbing") and nothing measured it:
   * `grep '\.omit('` over the fold suites returned nothing before this test. The
   * shape that tells the two apart is a `.omit()`ed field the COMPILER demands —
   * `vault.id` is the generated key the child arm spends, and `armColumnSql`
   * reads it off `__viborm_mutation` by COLUMN name. Filter the list by
   * `getDefaultScalarFieldNames` and the arm emits `RETURNING "name"` alone,
   * against a sibling that still reads `"id"`: PostgreSQL answers
   * `column "id" does not exist` and this test alone turns red.
   *
   * The same statement carries both readings, which is what makes it a pin on
   * the DIFFERENCE rather than on either list: the CTE keeps the omitted column
   * and the outer `SELECT` drops it.
   */
  test("an `.omit()`ed produced key still rides the CTE to the arm that spends it", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.vault.create({
      data: { name: "V1", slots: { create: { id: "sl1" } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(foldedInOneStatement(statements)).toBe(true);
    // The un-filtered storage footprint: `id` is in the CTE though no result
    // may name it…
    expect(statements[0]).toContain('RETURNING "id", "name")');
    // …because the sibling arm addresses it there, by column name.
    expect(statements[0]).toContain('(SELECT "id" FROM "__viborm_mutation")');
    // …and the OUTER projection is the omit-filtered one, on the same statement.
    expect(statements[0]).toContain(
      'SELECT "t0"."name" AS "name" FROM "__viborm_mutation" AS "t0"'
    );
    expect(created).toEqual({ name: "V1" });

    // The child took the key this one command generated. `where` still
    // addresses the omitted column, so the link is checkable without the
    // projection that hides it.
    const [slot] = await client.slot.findMany({});
    expect(slot?.id).toBe("sl1");
    expect(
      await client.vault.findMany({ where: { id: slot?.vaultId ?? -1 } })
    ).toEqual([{ name: "V1" }]);
  });

  /**
   * PACKAGE J's relation-bearing root `createMany`, whose members are each a full
   * `CreateOperation` and therefore each reach the tree fold. Recorded because it
   * is a J statement count that M moves and no J pin covers: ~3N statements
   * become N. §6 M4's "do not fold createMany trees with multiple
   * database-assigned roots" is respected — each command still holds exactly one
   * generated root, and the members stay separate commands.
   */
  test("each relation-bearing createMany MEMBER folds to its own command", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const result = await client.hub.createMany({
      data: [
        { name: "cm-a", spans: { create: { id: "cm-x", body: "bx" } } },
        { name: "cm-b", spans: { create: { id: "cm-y", body: "by" } } },
      ],
    });
    const statements = drain(driver);
    driver.recording = false;

    // Six statements before (three per member), two after — one per member.
    expect(result).toEqual({ count: 2 });
    expect(statements).toHaveLength(2);
    expect(statements.every((text) => text.startsWith("WITH "))).toBe(true);

    const hubs = await client.hub.findMany({
      where: { name: { in: ["cm-a", "cm-b"] } },
      orderBy: { name: "asc" },
    });
    expect(
      await client.span.findMany({
        where: { id: { in: ["cm-x", "cm-y"] } },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "cm-x", body: "bx", hubId: hubs[0]?.id },
      { id: "cm-y", body: "by", hubId: hubs[1]?.id },
    ]);
  });
});

// ---------------------------------------------------------------------------
// M4 — the injections. Each payload carries a lowerable reference, so the fold
// would fire; each declines for the one thing being injected.
// ---------------------------------------------------------------------------

describe("M4 — injecting one reason at a time makes the fold decline", () => {
  test("A BRANCH: a connectOrCreate probes, so planning is not empty", async () => {
    const { driver, client } = boot();
    await client.span.create({ data: { id: "pre", body: "seed" } });

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H6",
        spans: {
          create: { id: "s6", body: "b6" },
          connectOrCreate: {
            where: { id: "pre" },
            create: { id: "pre", body: "other" },
          },
        },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((text) => text.startsWith("WITH "))).toBe(false);
    // The branch was taken client-side: the seeded row was ADOPTED, not remade.
    expect(
      await client.span.findMany({
        where: { hubId: created.id },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "pre", body: "seed", hubId: created.id },
      { id: "s6", body: "b6", hubId: created.id },
    ]);
  });

  test("A SKIP: a duplicate-absorbing arm shares its table with another arm", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H7",
        spans: {
          create: { id: "s7", body: "b7" },
          createMany: {
            data: [{ id: "s7", body: "clash" }],
            skipDuplicates: true,
          },
        },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // A skip cannot see a tuple ANOTHER arm of the same command inserted, so
    // folding would turn this skip into a unique violation. It declines, and
    // `skipDuplicates` keeps its promise.
    expect(statements.some((text) => text.startsWith("WITH "))).toBe(false);
    expect(
      await client.span.findMany({ where: { hubId: created.id } })
    ).toEqual([{ id: "s7", body: "b7", hubId: created.id }]);

    // NON-VACUITY: the same shape without the skip folds. `skipDuplicates` is
    // what declined, not the createMany and not the reference inside it.
    driver.recording = true;
    await client.hub.create({
      data: {
        name: "H7b",
        spans: {
          create: { id: "s7b", body: "b7b" },
          createMany: { data: [{ id: "s7c", body: "b7c" }] },
        },
      },
      select: { id: true },
    });
    const control = drain(driver);
    driver.recording = false;
    expect(foldedInOneStatement(control)).toBe(true);
  });

  test("AN ARM THE TREE CANNOT CLASSIFY: a junction insert", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H8",
        spans: { create: { id: "s8", body: "b8" } },
        tags: { create: { id: "t8" } },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // The ordering conjunct is total over arms the record tree produced; a
    // junction row is not one of them, and an unclassified arm fails closed.
    expect(statements.some((text) => text.startsWith("WITH "))).toBe(false);
    expect(
      await client.hub.findUnique({
        where: { id: created.id },
        include: { tags: true },
      })
    ).toEqual({ id: created.id, name: "H8", tags: [{ id: "t8" }] });
  });

  test("A PROJECTION THAT WOULD SEE THE SHARED-SNAPSHOT TRAP: include", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: { name: "H9", spans: { create: { id: "s9", body: "b9" } } },
      include: { spans: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // A folded `include` would read the sibling arm's table through the
    // PRE-statement snapshot and answer with no spans at all.
    expect(statements.some((text) => text.startsWith("WITH "))).toBe(false);
    expect(created).toEqual({
      id: created.id,
      name: "H9",
      spans: [{ id: "s9", body: "b9", hubId: created.id }],
    });
  });

  test("a relation projection over untouched tables stays in the tree fold", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H9-safe",
        spans: { create: { id: "s9-safe", body: "b9-safe" } },
      },
      include: { tags: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(foldedInOneStatement(statements)).toBe(true);
    expect(created).toEqual({
      id: created.id,
      name: "H9-safe",
      tags: [],
    });
    expect(await client.span.findMany({ where: { id: "s9-safe" } })).toEqual([
      { id: "s9-safe", body: "b9-safe", hubId: created.id },
    ]);
  });

  test("AN ENCLOSING OWNER: an unpinned upsert create arm uses the tree fold", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.upsert({
      where: { id: 9000 },
      create: { name: "H11", spans: { create: { id: "s11", body: "b11" } } },
      update: { name: "H11u" },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // The create arm does not reproduce `where.id`, so exact race provenance
    // withholds a pin. The fresh compiler now knows that fact before it chooses
    // the fold; no post-compilation owner rewrites its root statement.
    expect(statements.some((text) => text.startsWith("WITH "))).toBe(true);
    expect(await client.span.findMany({ where: { id: "s11" } })).toEqual([
      { id: "s11", body: "b11", hubId: created.id },
    ]);
  });

  test("an indivisible array keeps an upsert create DAG and its sibling atomic", async () => {
    const { driver, client } = boot(true);

    driver.recording = true;
    const [created, sibling] = await client.$transaction([
      client.hub.upsert({
        where: { id: 9001 },
        create: {
          name: "H-array-upsert",
          spans: { create: { id: "s-array-upsert", body: "upsert child" } },
        },
        update: { name: "must-not-run" },
        select: { id: true, name: true },
      }),
      client.tag.create({ data: { id: "tag-array-upsert" } }),
    ]);
    const statements = drain(driver);
    driver.recording = false;

    expect(driver.batchCalls).toBe(1);
    expect(statements.some((text) => text.startsWith("WITH "))).toBe(true);
    expect(created).toMatchObject({ name: "H-array-upsert" });
    expect(sibling).toEqual({ id: "tag-array-upsert" });
    expect(
      await client.span.findMany({ where: { id: "s-array-upsert" } })
    ).toEqual([
      {
        id: "s-array-upsert",
        body: "upsert child",
        hubId: created.id,
      },
    ]);
  });

  test("SQLite batch folds a scalar upsert output without mutation CTE support", async () => {
    const driver = new BatchOnlyReturningSQLiteDriver();
    const client = createClient({ schema: sqliteScalarSchema, driver });
    try {
      await push(client, { force: true });
      expect(driver.adapter.capabilities.supportsReturning).toBe(true);
      expect(driver.adapter.capabilities.supportsCteWithMutations).toBe(false);
      driver.batchCalls = 0;

      const [created, sibling] = await client.$transaction([
        client.entry.upsert({
          where: { id: 42 },
          create: { label: "generated" },
          update: { label: "must not run" },
        }),
        client.entry.create({ data: { label: "sibling" } }),
      ]);

      expect(driver.batchCalls).toBe(1);
      expect(created).toEqual({ id: 1, label: "generated" });
      expect(sibling).toEqual({ id: 2, label: "sibling" });
      expect(await client.entry.findMany({ orderBy: { id: "asc" } })).toEqual([
        { id: 1, label: "generated" },
        { id: 2, label: "sibling" },
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("an empty relation arm keeps a scalar-fold create race retryable", async () => {
    const family = getFamily();
    const driver = new BeforeAtomicBatchDriver(family.database, async () => {
      await family.client.node.create({
        data: { id: "empty-arm-race", label: "competitor" },
      });
    });
    const client = createClient({ schema: depSchema, driver });

    const adopted = await client.node.upsert({
      where: { id: "empty-arm-race" },
      create: {
        id: "empty-arm-race",
        label: "caller",
        children: { createMany: { data: [] } },
      },
      update: { label: "adopted" },
    });

    expect(adopted).toMatchObject({ id: "empty-arm-race", label: "adopted" });
    expect(driver.batchCalls).toBe(2);
    await expect(
      family.client.node.findMany({ where: { id: "empty-arm-race" } })
    ).resolves.toEqual([
      {
        id: "empty-arm-race",
        label: "adopted",
        parentId: null,
      },
    ]);
  });

  test("an indivisible array surfaces a lost create race without retrying the array", async () => {
    const family = getFamily();
    const driver = new BeforeAtomicBatchDriver(family.database, async () => {
      await family.client.node.create({
        data: { id: "array-race", label: "competitor" },
      });
    });
    const client = createClient({ schema: depSchema, driver });

    await expect(
      client.$transaction([
        client.node.upsert({
          where: { id: "array-race" },
          create: {
            id: "array-race",
            label: "caller",
            children: { createMany: { data: [] } },
          },
          update: { label: "must not run" },
        }),
        client.tag.create({ data: { id: "array-race-sibling" } }),
      ])
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    await expect(
      family.client.node.findMany({ where: { id: "array-race" } })
    ).resolves.toEqual([
      { id: "array-race", label: "competitor", parentId: null },
    ]);
    expect(
      await family.client.tag.count({
        where: { id: "array-race-sibling" },
      })
    ).toBe(0);
  });

  test("a pinned upsert does not fold a same-table descendant into its race unit", async () => {
    const { driver, client } = boot();
    await client.node.create({
      data: { id: "occupied-child", label: "incumbent" },
    });

    driver.recording = true;
    await expect(
      client.node.upsert({
        where: { id: "new-root" },
        create: {
          id: "new-root",
          label: "root",
          children: {
            create: { id: "occupied-child", label: "must fail" },
          },
        },
        update: { label: "must not run" },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((text) => text.startsWith("WITH "))).toBe(false);
    expect(await client.node.findMany({ orderBy: { id: "asc" } })).toEqual([
      {
        id: "occupied-child",
        label: "incumbent",
        parentId: null,
      },
    ]);
  });

  test("A SECOND DATABASE-ASSIGNED ARM: the ordering conjunct still owns it", async () => {
    const { driver, client } = boot();

    driver.recording = true;
    const created = await client.hub.create({
      data: {
        name: "H10",
        spans: { create: { id: "s10", body: "b10" } },
        cells: { create: {} },
      },
      select: { id: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // PostgreSQL does not specify the order it runs unread data-modifying arms
    // in, so two arms calling `nextval` are two arms whose values the planner
    // gets to choose between. The reference in the `span` arm is spellable and
    // the fold still declines: this conjunct is not about references.
    expect(statements.some((text) => text.startsWith("WITH "))).toBe(false);
    expect(statements.length).toBeGreaterThan(1);
    expect(
      await client.cell.findMany({ where: { hubId: created.id } })
    ).toEqual([{ id: 1, hubId: created.id }]);
  });
});

// ---------------------------------------------------------------------------
// M2 — the lowerer's own refusals, one line apart
// ---------------------------------------------------------------------------

describe("M2 — compileMutationDependencyFold spells what it can and refuses the rest", () => {
  /** A root whose generated key's COLUMN name differs from its FIELD name — the
   *  one shape that tells the two `RETURNING` naming conventions apart. */
  const namedSchema = (() => {
    const box = s
      .model({
        id: s.int().id().increment().map("box_pk"),
        label: s.string(),
      })
      .map("pm_boxes");
    const lid = s
      .model({ id: s.string().id().map("lid_pk"), boxId: s.int().nullable() })
      .map("pm_lids");
    return { box, lid };
  })();
  prepareSchema(namedSchema);

  const boxScope = (adapter: typeof postgresAdapter) =>
    scopeFor(adapter, namedSchema.box as Model<any>);

  const rootArm = (): WriteStep => ({
    id: "box.create",
    kind: "write",
    statement: sql`INSERT INTO "pm_boxes" ("label") VALUES (${"L"})`,
    outputs: { id: { kind: "firstRowField", field: "id" } },
  });

  const childArm = (
    step = "box.create",
    output = "id",
    id = "lid.create"
  ): WriteStep => ({
    id,
    kind: "write",
    statement: sql`INSERT INTO "pm_lids" ("boxId") VALUES (${ref(step, output)})`,
    outputs: { id: { kind: "firstRowField", field: "id" } },
  });

  const rendered = (statement: { toStatement: (p: "$n") => string }) =>
    statement.toStatement("$n");

  test("the ROOT arm is addressed by its COLUMN name, a sibling by its FIELD name", () => {
    const grandchild: WriteStep = {
      id: "tab.create",
      kind: "write",
      statement: sql`INSERT INTO "pm_tabs" ("lidId") VALUES (${ref("lid.create", "id")})`,
      outputs: {},
    };
    const arms = compileMutationDependencyFold(boxScope(postgresAdapter), [
      rootArm(),
      childArm(),
      grandchild,
    ]);
    expect(arms).toBeDefined();
    expect(rendered(arms![0]!)).toBe(
      'INSERT INTO "pm_lids" ("boxId") VALUES ((SELECT "box_pk" FROM "__viborm_mutation"))'
    );
    // The sibling keeps the `"<column>" AS "<field>"` RETURNING its own builder
    // emitted, so its CTE column is the FIELD name — `id`, not `lid_pk`.
    expect(rendered(arms![1]!)).toBe(
      'INSERT INTO "pm_tabs" ("lidId") VALUES ((SELECT "id" FROM "__viborm_write_0"))'
    );
  });

  test("an arm with no reference comes back as the SAME Sql, not a rebuilt one", () => {
    const plain: WriteStep = {
      id: "lid.create",
      kind: "write",
      statement: sql`INSERT INTO "pm_lids" ("boxId") VALUES (${7})`,
      outputs: {},
    };
    const arms = compileMutationDependencyFold(boxScope(postgresAdapter), [
      rootArm(),
      plain,
    ]);
    expect(arms?.[0]).toBe(plain.statement);
  });

  // NO "a dialect without mutation CTEs refuses" TEST HERE, deliberately. The
  // lowerer does not re-ask that question: `buildTreeFold` must already have
  // established `supportsCteWithMutations` to build the enclosing `WITH` at all,
  // so a second check inside the lowerer would be a second owner of one
  // invariant with no production coverage of its own to name. The dialects that
  // must NOT fold are pinned where the decision is made — `parity-m-create-dag`
  // holds SQLite3's and MySQL2's portable series byte-for-byte.

  test("a FORWARD reference refuses: PostgreSQL has no such relation yet", () => {
    // The child is declared FIRST, so its producer is a later arm.
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        childArm(),
        rootArm(),
      ])
    ).toBeUndefined();
  });

  test("a SELF reference refuses on the same rule", () => {
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        rootArm(),
        childArm("lid.create", "id"),
      ])
    ).toBeUndefined();
  });

  test("a producer outside the fold refuses", () => {
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        rootArm(),
        childArm("somewhere.else"),
      ])
    ).toBeUndefined();
  });

  test("an output the producer does not declare refuses", () => {
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        rootArm(),
        childArm("box.create", "tag"),
      ])
    ).toBeUndefined();
  });

  test("an insertId output refuses: a driver channel has no column", () => {
    const insertIdRoot: WriteStep = {
      ...rootArm(),
      outputs: { id: { kind: "insertId" } },
    };
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        insertIdRoot,
        childArm(),
      ])
    ).toBeUndefined();
  });

  test("an OPTIONAL firstRowField refuses: its emptiness picks a branch", () => {
    const optionalRoot: WriteStep = {
      ...rootArm(),
      outputs: { id: { kind: "firstRowField", field: "id", optional: true } },
    };
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        optionalRoot,
        childArm(),
      ])
    ).toBeUndefined();
  });

  test("a MULTI-ROW producer cannot arise: it would have to publish a column", () => {
    // The `createMany` group statements are the only multi-row writes a create
    // tree contains, and they declare `outputs: {}` — so a reference to one
    // refuses by the rule above rather than needing a rule of its own.
    const group: WriteStep = {
      id: "lid.createMany",
      kind: "write",
      statement: sql`INSERT INTO "pm_lids" ("boxId") VALUES (${1}), (${2})`,
      outputs: {},
    };
    expect(
      compileMutationDependencyFold(boxScope(postgresAdapter), [
        rootArm(),
        group,
        childArm("lid.createMany", "id", "tab.create"),
      ])
    ).toBeUndefined();
  });
});
