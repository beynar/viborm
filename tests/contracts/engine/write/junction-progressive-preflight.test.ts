import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import type { CommittedBatchNotification } from "@src/drivers/types";
import { CreateManyRecordSeries } from "@src/query-engine/write-engine/CreateManyRecordSeries";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { junctionSkipAdoptSchema } from "@tests/contracts/engine/write/junction-skip-adoption-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

hydrateSchemaNames(junctionSkipAdoptSchema);

/** The ONE sentence both root-conflict readers construct (`strandedRootConflictPrefix`). */
const STRANDED_PREFIX_REFUSAL =
  /skipping root '.+' would leave prior effect 'holder\.create' committed/;

/** Count submitted work on both weak and acknowledged batch substrates. */
class CountingBatchOnlyPGlite extends BatchOnlyPGliteDriver {
  statements = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.statements += queries.length;
    return await super.executeBatch<T>(client, queries);
  }
}

/** The exact capability D1 declares: batch-only, plus ordered committed segments. */
class CountingProgressivePGlite extends CountingBatchOnlyPGlite {
  override readonly supportsOrderedCommittedSegments = true;
  afterCommittedBatch: (() => Promise<void>) | undefined;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries);
    await committed?.();
    const hook = this.afterCommittedBatch;
    if (hook) {
      this.afterCommittedBatch = undefined;
      await hook();
    }
    return results;
  }
}

class ProgressiveSQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await this.transaction(client, async (transaction) => {
      const batchResults: QueryResult<T>[] = [];
      for (const query of queries) {
        const statement = transaction.prepare<unknown[], T>(query.sql);
        const params = query.params ?? [];
        if (statement.reader) {
          statement.safeIntegers(true);
          const rows = statement.all(...params);
          batchResults.push({ rows, rowCount: rows.length });
        } else {
          const result = statement.run(...params);
          batchResults.push({
            rows: [],
            rowCount: result.changes,
            insertId: result.lastInsertRowid,
          });
        }
      }
      return batchResults;
    });
    await committed?.();
    return results;
  }
}

const rootFirstSuppression = () => ({
  where: { id: "v1" },
  data: {
    gems: {
      createMany: {
        data: [
          {
            tag: "taken",
            text: "OVERWRITTEN",
            facets: { create: [{ slug: "ghost" }] },
          },
          {
            tag: "kept",
            text: "fresh",
            facets: { create: [{ slug: "real" }] },
          },
        ],
        skipDuplicates: true,
      },
    },
  },
});

describe("root-first junction suppression on batch-only substrates", () => {
  const construct = (
    driver: CountingBatchOnlyPGlite,
    args: ReturnType<typeof rootFirstSuppression>
  ) => {
    const schemas = createSchemaRegistry(junctionSkipAdoptSchema);
    const engine = new QueryEngine(
      driver,
      createModelRegistry(junctionSkipAdoptSchema, schemas)
    );
    return () =>
      new UpdateOperation(engine, junctionSkipAdoptSchema.vault, args);
  };

  const substrates: readonly [
    string,
    (database: PGlite) => CountingBatchOnlyPGlite,
  ][] = [
    [
      "a capability-false batch driver",
      (database) => new CountingBatchOnlyPGlite({ client: database }),
    ],
    [
      "an ordered committed-segment driver",
      (database) => new CountingProgressivePGlite({ client: database }),
    ],
  ];

  for (const [substrate, createDriver] of substrates) {
    test(`${substrate} suppresses only the duplicate root and lands its sibling`, async () => {
      const database = new PGlite();
      const state = createClient({
        schema: junctionSkipAdoptSchema,
        driver: new PGliteDriver({ client: database }),
      });
      await syncLiveSchema(state);
      await state.gem.create({ data: { tag: "taken", text: "ORIGINAL" } });
      await state.vault.create({ data: { id: "v1" } });

      const driver = createDriver(database);
      const client = createClient({ schema: junctionSkipAdoptSchema, driver });
      expect(construct(driver, rootFirstSuppression())).not.toThrow();
      await client.vault.update(rootFirstSuppression());

      expect(driver.statements).toBeGreaterThan(0);
      await expect(
        state.gem.findMany({
          orderBy: { tag: "asc" },
          select: { tag: true, text: true },
        })
      ).resolves.toEqual([
        { tag: "kept", text: "fresh" },
        { tag: "taken", text: "ORIGINAL" },
      ]);
      await expect(
        state.facet.findMany({
          orderBy: { slug: "asc" },
          select: { slug: true },
        })
      ).resolves.toEqual([{ slug: "real" }]);
      const linked = await state.gem.findMany({
        where: { vaults: { some: { id: "v1" } } },
        select: { tag: true },
      });
      expect(linked.map((row) => row.tag)).toEqual(["kept"]);
      await state.$disconnect();
    }, 60_000);
  }
});

const progressiveSkipSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      marker: s.string(),
      buckets: s.toMany(() => bucket),
    })
    .map("f2_owners");
  const bucket = s
    .model({
      id: s.string().id(),
      label: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      gems: s.toMany(() => gem).through("f2_bucket_gem"),
      boards: s.toMany(() => board).through("f2_board_bucket"),
    })
    .map("f2_buckets");
  const gem = s
    .model({
      id: s.int().id().increment(),
      tag: s.string(),
      // One endpoint owns every junction override (R011).
      buckets: s.toMany(() => bucket),
    })
    .index(["tag"], { unique: true, name: "f2_gems_tag_uq" })
    .map("f2_gems");
  const board = s
    .model({
      id: s.string().id(),
      marker: s.string(),
      // One endpoint owns every junction override (R011).
      buckets: s.toMany(() => bucket),
    })
    .map("f2_boards");
  return { board, bucket, gem, owner };
})();

describe("nested root-first suppression keeps each progressive guard exact", () => {
  test("an outer scalar prefix and nested updateMany both land", async () => {
    const database = new PGlite();
    const state = createClient({
      schema: progressiveSkipSchema,
      driver: new PGliteDriver({ client: database }),
    });
    await syncLiveSchema(state);
    await state.owner.create({ data: { id: "o1", marker: "before" } });
    await state.bucket.create({
      data: { id: "b1", label: "before", ownerId: "o1" },
    });
    await state.gem.create({ data: { tag: "taken" } });

    const driver = new CountingProgressivePGlite({ client: database });
    const client = createClient({
      schema: progressiveSkipSchema,
      driver,
    });
    driver.statements = 0;
    await client.owner.update({
      where: { id: "o1" },
      data: {
        marker: "after",
        buckets: {
          updateMany: {
            where: {},
            data: {
              label: "after",
              gems: {
                createMany: {
                  data: [{ tag: "taken" }],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      state.owner.findUnique({ where: { id: "o1" } })
    ).resolves.toMatchObject({
      marker: "after",
    });
    await expect(
      state.bucket.findUnique({ where: { id: "b1" } })
    ).resolves.toMatchObject({
      label: "after",
    });
    await expect(
      state.gem.findMany({ select: { tag: true } })
    ).resolves.toEqual([{ tag: "taken" }]);
    await expect(
      state.gem.findMany({
        where: { buckets: { some: { id: "b1" } } },
      })
    ).resolves.toEqual([]);
    expect(driver.statements).toBeGreaterThan(0);
    await state.$disconnect();
  }, 60_000);

  test("junction updateMany lands its prefix without linking the skipped root", async () => {
    const database = new PGlite();
    const state = createClient({
      schema: progressiveSkipSchema,
      driver: new PGliteDriver({ client: database }),
    });
    await syncLiveSchema(state);
    await state.bucket.create({ data: { id: "b1", label: "before" } });
    await state.board.create({
      data: {
        id: "board-1",
        marker: "before",
        buckets: { connect: { id: "b1" } },
      },
    });
    await state.gem.create({ data: { tag: "taken" } });

    const driver = new CountingProgressivePGlite({ client: database });
    const client = createClient({
      schema: progressiveSkipSchema,
      driver,
    });
    driver.statements = 0;
    await client.board.update({
      where: { id: "board-1" },
      data: {
        marker: "after",
        buckets: {
          updateMany: {
            where: {},
            data: {
              label: "after",
              gems: {
                createMany: {
                  data: [{ tag: "taken" }],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      state.board.findUnique({ where: { id: "board-1" } })
    ).resolves.toMatchObject({ marker: "after" });
    await expect(
      state.bucket.findUnique({ where: { id: "b1" } })
    ).resolves.toMatchObject({ label: "after" });
    await expect(
      state.gem.findMany({ select: { tag: true } })
    ).resolves.toEqual([{ tag: "taken" }]);
    await expect(
      state.gem.findMany({
        where: { buckets: { some: { id: "b1" } } },
      })
    ).resolves.toEqual([]);
    expect(driver.statements).toBeGreaterThan(0);
    await state.$disconnect();
  }, 60_000);
});

function alternatingDefaultSkipSchema(replay: { complete: boolean }) {
  const owner = s
    .model({
      id: s.string().id(),
      marker: s.string(),
      buckets: s.toMany(() => bucket),
    })
    .map("f2_alt_owners");
  const bucket = s
    .model({
      id: s.string().id(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      gems: s.toMany(() => gem).through("f2_alt_bucket_gem"),
    })
    .map("f2_alt_buckets");
  const gem = s
    .model({
      id: s.int().id().increment(),
      stable: s.string().unique(),
      slug: s
        .string()
        .nullable()
        .default(() => (replay.complete ? "dynamic" : null))
        .unique(),
      // One endpoint owns every junction override (R011).
      buckets: s.toMany(() => bucket),
    })
    .map("f2_alt_gems");
  return { bucket, gem, owner };
}

describe("replayable defaults are evaluated for each selected member", () => {
  test("a default is reparsed after the committed prefix", async () => {
    const replay = { complete: false };
    const schema = alternatingDefaultSkipSchema(replay);
    const database = new PGlite();
    const state = createClient({
      schema,
      driver: new PGliteDriver({ client: database }),
    });
    await syncLiveSchema(state);
    await state.owner.create({ data: { id: "o1", marker: "before" } });
    await state.bucket.create({ data: { id: "b1", ownerId: "o1" } });

    const driver = new CountingProgressivePGlite({ client: database });
    const client = createClient({ schema, driver });
    driver.afterCommittedBatch = async () => {
      replay.complete = true;
    };
    await client.owner.update({
      where: { id: "o1" },
      data: {
        marker: "after",
        buckets: {
          updateMany: {
            where: {},
            data: {
              gems: {
                createMany: {
                  data: [{ stable: "S" }],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      state.owner.findUnique({ where: { id: "o1" } })
    ).resolves.toMatchObject({ marker: "after" });
    expect(replay.complete).toBe(true);
    await expect(
      state.gem.findMany({ select: { stable: true, slug: true } })
    ).resolves.toEqual([{ stable: "S", slug: "dynamic" }]);
    await expect(
      state.gem.findMany({
        where: { buckets: { some: { id: "b1" } } },
        select: { stable: true },
      })
    ).resolves.toEqual([{ stable: "S" }]);
    await state.$disconnect();
  }, 60_000);
});

const vacuousProgressiveSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      targets: s.toMany(() => target).through("f3_owner_target"),
    })
    .map("f3_owners");
  const target = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      // One endpoint owns every junction override (R011).
      owners: s.toMany(() => owner),
      details: s.toMany(() => detail),
    })
    .map("f3_targets");
  const detail = s
    .model({
      id: s.string().id(),
      body: s.string(),
      targetId: s.int().nullable(),
      target: s
        .toOne(() => target)
        .fields("targetId")
        .references("id"),
    })
    .map("f3_details");
  return { detail, owner, target };
})();

describe("residual F3 — a vacuous relation-bearing skip drops the flag", () => {
  test("the unchanged relation series runs on ordered committed segments", async () => {
    const driver = new ProgressiveSQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({
      schema: vacuousProgressiveSchema,
      driver,
    });
    await syncLiveSchema(client);
    await client.owner.create({ data: { id: "o1" } });

    await client.owner.update({
      where: { id: "o1" },
      data: {
        targets: {
          createMany: {
            data: [
              {
                label: "one",
                details: { create: { id: "d1", body: "child" } },
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.target.findMany({
        where: { owners: { some: { id: "o1" } } },
        select: { label: true },
      })
    ).resolves.toEqual([{ label: "one" }]);
    await expect(
      client.detail.findMany({ select: { body: true } })
    ).resolves.toEqual([{ body: "child" }]);
    await client.$disconnect();
  }, 60_000);
});

/**
 * PACKAGE E, §9.6 — THE COLLECTION-BEARING ROOT `createMany`, and the MEASUREMENT
 * that decided its preflight.
 *
 * §9.6 requires the progressive root-conflict refusal to fire "before member
 * zero". `OperationExecutor.prepareProgressiveMember` returns EARLY for any member
 * whose planning phase is non-empty, and only members with EMPTY planning are
 * compiled during series preflight — so whether a collection-bearing member gets
 * the pre-member-zero check is a question about planning, not about collections.
 *
 * MEASURED, and pinned here so the answer cannot rot: every collection verb a bulk
 * row may spell (`connect`, `create`, `createMany`, `connectOrCreate`) contributes
 * ZERO planning steps, ALONE and BESIDE a parent-held to-one arm — which is the
 * one shape §9.6 asks to be refused early ("if a target create or nested record
 * series must execute before the owner root"). So the collection half needs no
 * second preflight reader, and none was added: the existing
 * `assertProgressiveRootConflictEligibility` is reached at preflight for exactly
 * the shapes the plan names.
 *
 * PROBING verbs (`connect`, `connectOrCreate`) DO plan, so a row spelling one of
 * those takes the early return — and so does a row spelling an ORDINARY junction
 * `connect`, with or without any collection key. That is the gap the measurement
 * found, and it is CLOSED here rather than merely recorded: the early return now
 * asks the member's PARSED SHAPE the same question the compiled fragment answers
 * later (`assertDeclaredRootConflictEligibility`), so the refusal arrives before
 * member zero for the planning members too. The rows below pin all three facts —
 * which verbs plan, what the shape declares, and that nothing commits.
 */
const collectionBulkSchema = (() => {
  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("e6_notes");
  const crate = s
    .model({
      id: s.string().id(),
      name: s.string(),
      boxes: s.toMany(() => box).through("e6_box_crate"),
    })
    .map("e6_crates");
  const holder = s
    .model({
      id: s.string().id(),
      name: s.string(),
      boxes: s.toMany(() => box),
    })
    .map("e6_holders");
  const box = s
    .model({
      id: s.string().id(),
      title: s.string(),
      holderId: s.string(),
      // PARENT-HELD: this arm's target write must execute BEFORE the root INSERT,
      // which is exactly the "prior effect" the root-conflict preflight refuses.
      holder: s
        .toOne(() => holder)
        .fields("holderId")
        .references("id"),
      // One endpoint owns every junction override (R011).
      crates: s.toMany(() => crate),
      items: s.toMany({ note: () => note }, { values: { note: "e6.note.v1" } }),
    })
    .index(["title"], { unique: true, name: "e6_boxes_title_uq" })
    .map("e6_boxes");
  return { note, crate, holder, box };
})();

hydrateSchemaNames(collectionBulkSchema);
// The polymorphic member needs its storage RESOLVED before any engine is built
// over these models, which is what the client does on construction
// (`validateClientSchemaOrThrow`). The measurements below build engines directly,
// and a model whose storage is first read UNRESOLVED keeps that answer — so the
// behavioural row that follows silently lost its collection arm, and the planning
// measurement silently answered zero for every collection verb. Same requirement
// and same spelling as `parity-j-create-many.test.ts`, and it is load-bearing
// here in a way that file did not have to say: without it these numbers are wrong
// rather than merely absent.
validateClientSchemaOrThrow(collectionBulkSchema);

describe("§9.6 — a collection-bearing createMany row", () => {
  const engineFor = () => {
    const schemas = createSchemaRegistry(collectionBulkSchema);
    return new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(collectionBulkSchema, schemas)
    );
  };

  const planningSteps = (data: readonly unknown[]) =>
    new CreateManyRecordSeries(engineFor(), collectionBulkSchema.box, {
      data,
      skipDuplicates: true,
    })
      .compileMembers()
      .reduce((total, member) => total + member.planning().steps.length, 0);

  test("MEASURED: which collection verbs make a member PLAN — the fact the preflight timing turns on", () => {
    const row = (extra: Record<string, unknown>) => [
      { id: "b1", title: "t", holderId: "h1", ...extra },
    ];
    // PROBING verbs plan: `connect` and `connectOrCreate` each read the target
    // before the member's fragment can be compiled, so such a member takes the
    // early return and is NOT compiled during series preflight.
    expect(
      planningSteps(
        row({ items: { connect: [{ type: "note", where: { id: "n1" } }] } })
      )
    ).toBe(1);
    expect(
      planningSteps(
        row({
          items: {
            connectOrCreate: [
              {
                type: "note",
                where: { id: "n4" },
                create: { id: "n4", body: "x" },
              },
            ],
          },
        })
      )
    ).toBe(1);
    // PRODUCING verbs do not: a row this member is inserting has nothing to read.
    expect(
      planningSteps(
        row({
          items: { create: [{ type: "note", data: { id: "n2", body: "x" } }] },
        })
      )
    ).toBe(0);
    expect(
      planningSteps(
        row({
          items: {
            createMany: [{ type: "note", data: [{ id: "n3", body: "x" }] }],
          },
        })
      )
    ).toBe(0);
    // A PARENT-HELD arm alone plans nothing, so the §9.6 shape spelled with a
    // producing collection verb IS compiled at preflight and refused before
    // member zero by `assertProgressiveRootConflictEligibility`.
    expect(
      planningSteps([
        {
          id: "b2",
          title: "t",
          holder: { create: { id: "h2", name: "fresh" } },
          items: { create: [{ type: "note", data: { id: "n5", body: "x" } }] },
        },
      ])
    ).toBe(0);
  });

  /**
   * THE SHAPE THE PREFLIGHT NOW READS.
   *
   * `prepareProgressiveMember` returns early for any member whose planning phase
   * is non-empty — it has no planning outputs with which to compile one — so the
   * compiled root-conflict reader cannot see such a member until its own turn.
   * `CreateOperation.declaredPreRootWriteId` is what it CAN be asked, and these
   * rows pin exactly what that shape does and does not promise.
   *
   * The negative rows matter as much as the positive one: a collection arm is
   * never a parent-held arm (it stores nothing on the owner's row), so no
   * collection verb can make this answer, and a `connectOrCreate` writes before
   * the root only on the arm its probe picks — declaring it would refuse the
   * found-arm program that runs correctly today.
   */
  test("the parsed shape promises a pre-root write for exactly the parent-held `create`", () => {
    const declared = (row: Record<string, unknown>) =>
      new CreateManyRecordSeries(engineFor(), collectionBulkSchema.box, {
        data: [row],
        skipDuplicates: true,
      }).compileMembers()[0]?.declaredPreRootWriteId;

    // A parent-held `create` ALWAYS writes before the root INSERT.
    expect(
      declared({
        id: "b5",
        title: "t",
        holder: { create: { id: "h5", name: "fresh" } },
        items: { connect: [{ type: "note", where: { id: "n1" } }] },
      })
    ).toBe("holder.create");
    // Collection work alone promises nothing: a member row cannot precede the
    // owner row it references.
    expect(
      declared({
        id: "b6",
        title: "t",
        holderId: "h1",
        items: { connect: [{ type: "note", where: { id: "n1" } }] },
      })
    ).toBeUndefined();
    expect(
      declared({
        id: "b7",
        title: "t",
        holderId: "h1",
        items: { create: [{ type: "note", data: { id: "n7", body: "x" } }] },
      })
    ).toBeUndefined();
    // A probe-dependent parent-held arm is left to the compiled reader.
    expect(
      declared({
        id: "b8",
        title: "t",
        holder: {
          connectOrCreate: {
            where: { id: "h8" },
            create: { id: "h8", name: "either" },
          },
        },
      })
    ).toBeUndefined();
  });

  /**
   * THE GAP ITSELF, closed and pinned by DATABASE STATE.
   *
   * Member zero is an ordinary row that would commit its own durable segment.
   * Member one both PLANS (the collection probe) and promises a write before its
   * skippable root. Before the declared reader existed, member zero committed and
   * the refusal arrived at member one; now the refusal precedes member zero and
   * the database is untouched — which is the whole of §9.6's "before member zero".
   *
   * A batch-only substrate is not decoration here: it is the only substrate on
   * which a member's commit is durable before its successors run. The same series
   * on a transactional driver rolls the prefix back, so nothing about the timing
   * would be observable.
   */
  test("PREFLIGHT: a planning member that promises a pre-root write refuses before member zero commits", async () => {
    const database = new PGlite();
    const state = createClient({
      schema: collectionBulkSchema,
      driver: new PGliteDriver({ client: database }),
    });
    await syncLiveSchema(state);
    await state.holder.create({ data: { id: "h1", name: "Holder" } });
    await state.note.create({ data: { id: "n1", body: "Note one" } });

    const client = createClient({
      schema: collectionBulkSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    });
    await expect(
      client.box.createMany({
        data: [
          { id: "b1", title: "first", holderId: "h1" },
          {
            id: "b2",
            title: "second",
            holder: { create: { id: "h2", name: "fresh" } },
            items: { connect: [{ type: "note", where: { id: "n1" } }] },
          },
        ],
        skipDuplicates: true,
      })
    ).rejects.toThrow(STRANDED_PREFIX_REFUSAL);

    // NOTHING committed — not member zero's root, not member one's target.
    await expect(state.box.findMany({ select: { id: true } })).resolves.toEqual(
      []
    );
    await expect(
      state.holder.findMany({ orderBy: { id: "asc" }, select: { id: true } })
    ).resolves.toEqual([{ id: "h1" }]);
    await state.$disconnect();
  }, 60_000);

  /**
   * The measurement that decided the placement, kept as the before-picture: a
   * probing arm makes a member plan with or WITHOUT a collection key, so the
   * early return is a pre-existing Package J shape that a collection key adds one
   * more spelling to. It is what makes the declared reader's coverage TIMING
   * rather than "collections".
   */
  test("a probing arm beside a parent-held write plans, with or WITHOUT a collection key", () => {
    const base = {
      id: "b3",
      title: "t",
      holder: { create: { id: "h3", name: "fresh" } },
      crates: { connect: [{ id: "c1" }] },
    };
    expect(planningSteps([base])).toBe(1);
    // The collection `connect` adds its own probe; neither row is preflighted.
    expect(
      planningSteps([
        {
          ...base,
          items: { connect: [{ type: "note", where: { id: "n1" } }] },
        },
      ])
    ).toBe(2);
    // …and a collection `connect` ALONE beside the parent-held write is the
    // spelling E newly admits into that set.
    expect(
      planningSteps([
        {
          id: "b4",
          title: "t",
          holder: { create: { id: "h4", name: "fresh" } },
          items: { connect: [{ type: "note", where: { id: "n1" } }] },
        },
      ])
    ).toBe(1);
  });

  /**
   * §10.2 — THE COMMITTED PREFIX, with a collection member in it.
   *
   * Member zero writes a root AND a member junction row and commits its segment.
   * Member one then fails on a premise the series cannot satisfy. The claim is
   * two-part and both halves are read off the database rather than off the plan:
   * the failure reports EXACTLY how far the series got, and the committed prefix
   * — including the member tuple, which is a separate statement from its root —
   * is still there afterwards, unreplayed and unrolled-back.
   */
  test("§10.2 — a failing successor reports exact progress and leaves the collection prefix committed", async () => {
    const database = new PGlite();
    const state = createClient({
      schema: collectionBulkSchema,
      driver: new PGliteDriver({ client: database }),
    });
    await syncLiveSchema(state);
    await state.holder.create({ data: { id: "h1", name: "Holder" } });
    await state.note.create({ data: { id: "n1", body: "Note one" } });

    const client = createClient({
      schema: collectionBulkSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    });
    const failure = await client.box
      .createMany({
        data: [
          {
            id: "b1",
            title: "committed",
            holderId: "h1",
            items: { connect: [{ type: "note", where: { id: "n1" } }] },
          },
          {
            id: "b2",
            title: "doomed",
            holderId: "h1",
            items: { connect: [{ type: "note", where: { id: "gone" } }] },
          },
        ],
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          committedSegments: 1,
          completedMembers: 1,
          memberPath: [1],
          totalMembers: 2,
        },
      },
    });
    await expect(
      state.box.findMany({ orderBy: { id: "asc" }, select: { id: true } })
    ).resolves.toEqual([{ id: "b1" }]);
    const members = await state.$queryRawUnsafe<Record<string, unknown>>(
      'SELECT * FROM "e6_boxes_items_note"'
    );
    expect(members).toHaveLength(1);
    expect(Object.values(members[0] ?? {})).toEqual(
      expect.arrayContaining(["b1", "n1"])
    );
    await state.$disconnect();
  }, 60_000);

  test("a skipped collection-bearing root emits no member effect, and a fresh sibling lands", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: collectionBulkSchema, driver });
    await syncLiveSchema(client);
    await client.holder.create({ data: { id: "h1", name: "Holder" } });
    await client.note.create({ data: { id: "n1", body: "Note one" } });
    await client.note.create({ data: { id: "n2", body: "Note two" } });
    await client.box.create({
      data: { id: "b0", title: "taken", holderId: "h1" },
    });

    const result = await client.box.createMany({
      data: [
        {
          id: "b1",
          title: "taken",
          holderId: "h1",
          items: { connect: [{ type: "note", where: { id: "n1" } }] },
        },
        {
          id: "b2",
          title: "fresh",
          holderId: "h1",
          items: { connect: [{ type: "note", where: { id: "n2" } }] },
        },
      ],
      skipDuplicates: true,
    });

    // The duplicate root is suppressed WITH its member subtree; the sibling lands
    // both its root and its membership.
    expect(result).toEqual({ count: 1 });
    await expect(
      client.box.findMany({ orderBy: { id: "asc" }, select: { id: true } })
    ).resolves.toEqual([{ id: "b0" }, { id: "b2" }]);
    const members = await client.$queryRawUnsafe<Record<string, unknown>>(
      'SELECT * FROM "e6_boxes_items_note"'
    );
    expect(members).toHaveLength(1);
    expect(Object.values(members[0] ?? {})).toEqual(
      expect.arrayContaining(["b2", "n2"])
    );
    await client.$disconnect();
  }, 60_000);

  /**
   * THE DECIDED ASYMMETRY (plan §9.6 read against §10, decision (b)): the skip
   * rule covers EFFECTS, not PREMISES.
   *
   * A collection `connect` reads its target during the member's PLANNING phase,
   * which runs before the root INSERT is even attempted — so a row whose root
   * would have been skipped still raises when its target does not exist. This is
   * accepted rather than fixed: the alternative is reordering a premise read
   * behind a conditional write, which would make the probe answer a question about
   * a row the series has already decided not to write.
   *
   * Pinned so the decision is a measurement rather than a memory, and paired with
   * the row above where the same duplicate root with a PRESENT target skips
   * silently — the difference is the premise, never the duplicate.
   */
  test("a duplicate root still raises for a MISSING collection target: the skip rule covers effects, not premises", async () => {
    const driver = new PGliteDriver();
    const client = createClient({ schema: collectionBulkSchema, driver });
    await syncLiveSchema(client);
    await client.holder.create({ data: { id: "h1", name: "Holder" } });
    await client.box.create({
      data: { id: "b0", title: "taken", holderId: "h1" },
    });

    await expect(
      client.box.createMany({
        data: [
          {
            id: "b1",
            title: "taken",
            holderId: "h1",
            items: { connect: [{ type: "note", where: { id: "absent" } }] },
          },
        ],
        skipDuplicates: true,
      })
    ).rejects.toThrow();
    await expect(
      client.box.findMany({ orderBy: { id: "asc" }, select: { id: true } })
    ).resolves.toEqual([{ id: "b0" }]);
    await client.$disconnect();
  }, 60_000);
});
