import { createClient } from "@client/client";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  buildRelationMutationProgram,
} from "@query-engine/builders/relation-mutation-parser";
import {
  createQueryScope,
  getRelationInfo,
} from "@query-engine/context/query-scope";
import { assertUpdateOwnWriteSafety } from "@query-engine/OwnWriteAnalyzer";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import { sql } from "@sql";
import { NestedSelectedRecordSeries } from "@src/query-engine/write-engine/NestedSelectedRecordSeries";
import type { ReadStep } from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import type { RecordCompilerSeam } from "@src/query-engine/write-engine/RecordUpdateCompiler";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { bindCorrelatedRelationMembership } from "@src/query-engine/write-engine/relation-membership";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { sortCapturedRowKeys } from "@src/query-engine/write-engine/target-projection";
import {
  registerUpdateManySeriesBehavior,
  updateManySeriesSchema,
} from "@tests/contracts/engine/write/update-many-relation-series-behavior";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE K — the record-series route for root `updateMany`, on PGlite.
 *
 * Two kinds of claim live here and nowhere else:
 *
 *   · WHICH DESTINATION the router picks, per payload shape. K2 gave `updateMany`
 *     three of them and one of the three is new, so "scalar data never becomes a
 *     series" and "a polymorphic key DOES" are assertions, not comments — the first
 *     protects the one-statement fast path, the second protects against a silent
 *     drop (`buildSet` skips any non-scalar key).
 *   · WHAT THE EXECUTOR ACTUALLY RAN, read off a traced driver. The capture happening
 *     ONCE, before every member, and the result reads happening after ALL of them, are
 *     only as good as the statement list.
 *
 * The portable behavior — counts, ordering, rollback, the refusals — is
 * `update-many-relation-series-behavior.ts`, run below on PGlite and on the live
 * servers by the `-docker` sibling.
 */

hydrateSchemaNames(updateManySeriesSchema);

/** A SECOND schema, with a direct polymorphic edge, because the routing question K2
 *  answers differently from J2 is exactly about polymorphic keys. Compiler-only
 *  probes MUST run the client-schema validator: `hydrateSchemaNames` alone leaves
 *  `getPolymorphicStorage` empty, so every polymorphic probe early-exits and a test
 *  goes green having asserted nothing (Package J outcomes, item 2). */
const polySchema = (() => {
  const image = s
    .model({ id: s.int().id(), url: s.string() })
    .map("kpoly_images");
  const clip = s
    .model({ id: s.int().id(), url: s.string() })
    .map("kpoly_clips");
  const board = s
    .model({
      id: s.int().id(),
      name: s.string(),
      slots: s.oneToMany(() => slot),
    })
    .map("kpoly_boards");
  const slot = s
    .model({
      id: s.int().id(),
      caption: s.string(),
      boardId: s.int(),
      board: s
        .manyToOne(() => board)
        .fields("boardId")
        .references("id"),
      media: s
        .polymorphic(
          { image: () => image, clip: () => clip },
          { values: { image: "kpoly.image.v1", clip: "kpoly.clip.v1" } }
        )
        .optional(),
    })
    .map("kpoly_slots");
  return { image, clip, board, slot };
})();
hydrateSchemaNames(polySchema);
validateClientSchemaOrThrow(polySchema);

let replayOwnWriteDefaultValue = 1;
let replayOwnWriteDefaultCalls = 0;

const replayOwnWriteSchema = (() => {
  const shelf = s
    .model({
      id: s.int().id(),
      bins: s.oneToMany(() => bin),
    })
    .map("k_replay_own_write_shelves");
  const bin = s
    .model({
      id: s.int().id(),
      shelfId: s.int().nullable(),
      shelf: s
        .manyToOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .optional(),
      targets: s
        .manyToMany(() => target)
        .through("k_replay_own_write_bin_target"),
    })
    .map("k_replay_own_write_bins");
  const target = s
    .model({
      id: s
        .int()
        .id()
        .default(() => {
          replayOwnWriteDefaultCalls += 1;
          return replayOwnWriteDefaultValue;
        }),
      bins: s.manyToMany(() => bin).through("k_replay_own_write_bin_target"),
    })
    .map("k_replay_own_write_targets");
  return { shelf, bin, target };
})();

hydrateSchemaNames(replayOwnWriteSchema);

function engineFor(
  driver: AnyDriver,
  schema = updateManySeriesSchema
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema as any, createSchemaRegistry(schema as any))
  );
}

function routeUpdateMany(
  driver: AnyDriver,
  model: Model<any>,
  args: Record<string, unknown>,
  schema = updateManySeriesSchema
) {
  return constructRoutedOperation(
    engineFor(driver, schema),
    model,
    "updateMany",
    args
  );
}

/** Batch-only AND non-returning — the one substrate the `select` refusal names. */
class BatchOnlyNonReturningDriver extends MySQL2Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const LEADING_WORD = /\s+/;
const KSERIES_TABLE = /kseries_\w+/;

/** One ordered list of every statement the provider was actually asked to run, as
 *  `<VERB> <table>` — enough to read execution ORDER off, and stable across the
 *  column-list churn a byte pin would suffer. */
class TracingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];

  override withTransaction<T>(
    fn: Parameters<PGliteDriver["withTransaction"]>[0],
    options?: Parameters<PGliteDriver["withTransaction"]>[1],
    context?: QueryExecutionContext
  ): Promise<T> {
    this.statements.push("BEGIN");
    return super.withTransaction(fn, options, context) as Promise<T>;
  }

  protected override execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ) {
    const verb = statement.trim().split(LEADING_WORD)[0]?.toUpperCase() ?? "?";
    const table = KSERIES_TABLE.exec(statement)?.[0] ?? "?";
    this.statements.push(`${verb} ${table}`);
    return super.execute<T>(client, statement, params, context);
  }
}

// ---------------------------------------------------------------------------
// (1) Which destination.
// ---------------------------------------------------------------------------

describe("K2 — the three destinations of one operation name", () => {
  const driver = new PGliteDriver();

  const isSeries = (
    args: Record<string, unknown>,
    model: Model<any> = updateManySeriesSchema.bin,
    schema = updateManySeriesSchema
  ) => {
    const routed = routeUpdateMany(driver, model, args, schema);
    return routed !== undefined && isRecordSeries(routed);
  };

  test("scalar-only data keeps the one-statement owner, on both arms", () => {
    expect(isSeries({ where: { id: 1 }, data: { label: "x" } })).toBe(false);
    expect(
      isSeries({ where: { id: 1 }, data: { label: "x" }, select: { id: true } })
    ).toBe(false);
  });

  test("one relation key routes the WHOLE operation", () => {
    expect(
      isSeries({ data: { label: "x", shelf: { connect: { id: 1 } } } })
    ).toBe(true);
  });

  test("a relation key spelled `undefined` is an ABSENT relation key", () => {
    // The spread-an-optional idiom must not drag a scalar payload off its one-statement
    // fast path and into capture plus per-record execution.
    expect(isSeries({ data: { label: "x", shelf: undefined } })).toBe(false);
  });

  test("a DIRECT POLYMORPHIC key routes too — where J's createMany predicate does not", () => {
    // The one place K's discriminant is deliberately WIDER than J's. J excludes direct
    // polymorphic memberships because `createMany` has a grouped bulk probe route for
    // them; `updateMany` has no such route, and `buildSet` SKIPS every non-scalar key,
    // so a polymorphic key sent to the one-statement owner would be silently dropped
    // from the UPDATE.
    expect(
      isSeries(
        {
          data: {
            caption: "c",
            media: { connect: { type: "image", where: { id: 1 } } },
          },
        },
        polySchema.slot,
        polySchema as any
      )
    ).toBe(true);
    // …including the targetless disconnect, whose resolved intent carries no relation
    // program at all — the exact shape that used to slip past a `.relations`-only read.
    expect(
      isSeries(
        { data: { media: { disconnect: true } } },
        polySchema.slot,
        polySchema as any
      )
    ).toBe(true);
  });

  test("deleteMany is untouched by the new branch", () => {
    const routed = constructRoutedOperation(
      engineFor(driver),
      updateManySeriesSchema.bin,
      "deleteMany",
      { where: { id: 1 } }
    );
    expect(routed !== undefined && isRecordSeries(routed)).toBe(false);
  });

  test("a malformed payload keeps its existing owner and its existing error", () => {
    // The discriminant is total and non-throwing: what it cannot classify with
    // certainty falls back to the existing owner, so a malformed payload keeps the
    // exact message it had — raised, as before, by that owner's own parse.
    const messageOf = (args: Record<string, unknown>) => {
      try {
        routeUpdateMany(driver, updateManySeriesSchema.bin, args);
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    expect(messageOf({ data: "not an object" })).toBe(
      "Validation failed for updateMany: Expected object"
    );
    expect(
      messageOf({ data: { label: 7, shelf: { connect: { id: 1 } } } })
    ).toBe(
      "Validation failed for updateMany: Value did not match any union member: Expected string, Expected object"
    );
  });
});

describe("K2 — select keeps its typed refusal while count uses default batch", () => {
  const RELATION_DATA = { label: "x", shelf: { connect: { id: 1 } } };

  test("a relation-bearing payload WITH select still gets the specific sentence", () => {
    // `select` is a separate row-returning contract. This non-returning provider cannot
    // roll back public result parsing, so its specific owner answers before the default
    // record-series route.
    let thrown: unknown;
    try {
      routeUpdateMany(
        new BatchOnlyNonReturningDriver(),
        updateManySeriesSchema.bin,
        {
          data: RELATION_DATA,
          select: { id: true },
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      "Driver 'mysql2' cannot execute 'updateMany' with 'select' because public result parsing cannot be rolled back."
    );
  });

  test("the { count } arm executes as ordered batches with exact state", async () => {
    const database = new PGlite();
    const setup = createClient({
      schema: updateManySeriesSchema,
      driver: new PGliteDriver({ client: database }),
    }) as any;
    const { push } = await import("@migrations");
    await push(setup, { force: true });
    await setup.shelf.create({ data: { id: 1, room: "north" } });
    await setup.bin.createMany({
      data: [
        { id: 1, label: "one" },
        { id: 2, label: "two" },
        { id: 3, label: "untouched" },
      ],
    });
    const batchOnly = createClient({
      schema: updateManySeriesSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    }) as any;

    await expect(
      batchOnly.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: RELATION_DATA,
      })
    ).resolves.toEqual({ count: 2 });
    await expect(
      batchOnly.bin.findMany({
        orderBy: { id: "asc" },
        select: { id: true, label: true, shelfId: true },
      })
    ).resolves.toEqual([
      { id: 1, label: "x", shelfId: 1 },
      { id: 2, label: "x", shelfId: 1 },
      { id: 3, label: "untouched", shelfId: null },
    ]);
    await expect(
      batchOnly.shelf.findMany({ select: { id: true, room: true } })
    ).resolves.toEqual([{ id: 1, room: "north" }]);
    await batchOnly.$disconnect();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// (2) What the executor ran.
// ---------------------------------------------------------------------------

describe("K3/K6 — the statement list the series actually issues", () => {
  const seed = async (client: any) => {
    await client.shelf.create({ data: { id: 1, room: "north" } });
    await client.bin.create({ data: { id: 1, label: "one" } });
    await client.bin.create({ data: { id: 2, label: "two" } });
  };

  test("ONE capture, then one complete update per root, then the grouped read", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: updateManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    await seed(client);
    driver.statements.length = 0;

    await client.bin.updateMany({
      where: { id: { in: [1, 2] } },
      data: { label: "seen", shelf: { connect: { id: 1 } } },
      select: { id: true },
    });

    // Read it as §5.2's recipe: ONE capture of the root keys (the only evaluation of
    // the public `where`), then member 0's complete ordinary update — its own locate,
    // its own probe of the shelf it is connecting to, its UPDATE with the FK folded
    // in, its terminal read — then member 1's, and only THEN one grouped read that
    // answers the public projection. Nothing writes after that read, which is what
    // "read after every member effect" means operationally.
    //
    // The per-member shelf probe is the visible price of the lift and it is the RIGHT
    // price: it is what an ordinary `update` issues for the same payload, which is the
    // one property this route exists to preserve.
    expect(driver.statements).toEqual([
      "BEGIN",
      "SELECT kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_shelves",
      "UPDATE kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_shelves",
      "UPDATE kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_bins",
    ]);
    await client.$disconnect();
  }, 60_000);

  test("the { count } arm issues no result reads at all", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: updateManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    await seed(client);
    driver.statements.length = 0;

    await client.bin.updateMany({
      where: { id: { in: [1, 2] } },
      data: { label: "seen", shelf: { connect: { id: 1 } } },
    });

    // Each member still ends with its own terminal read: it is an ORDINARY update, and
    // that read is how it publishes its final row key. What the count arm does NOT do
    // is read anything a second time — `count` is the captured root count.
    expect(driver.statements).toEqual([
      "BEGIN",
      "SELECT kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_shelves",
      "UPDATE kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_bins",
      "SELECT kseries_shelves",
      "UPDATE kseries_bins",
      "SELECT kseries_bins",
    ]);
    await client.$disconnect();
  }, 60_000);

  test("an empty capture issues the capture and nothing else", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: updateManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    driver.statements.length = 0;

    await expect(
      client.bin.updateMany({
        where: { label: "nothing" },
        data: { label: "x", shelf: { connect: { id: 1 } } },
      })
    ).resolves.toEqual({ count: 0 });

    // "Empty capture emits no effects" (§5.2) — measured as exactly one statement.
    expect(driver.statements).toEqual(["BEGIN", "SELECT kseries_bins"]);
    await client.$disconnect();
  }, 60_000);

  test("limit: 0 issues nothing, not even the capture", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: updateManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    await seed(client);
    driver.statements.length = 0;

    await expect(
      client.bin.updateMany({
        data: { label: "x", shelf: { connect: { id: 1 } } },
        limit: 0,
      })
    ).resolves.toEqual({ count: 0 });

    // A cap that selects nothing must LOCK nothing: the capture is `FOR UPDATE`, so
    // running it would take row locks for a call that cannot write.
    expect(driver.statements).toEqual(["BEGIN"]);
    await client.$disconnect();
  }, 60_000);

  test("the public where is evaluated ONCE, even when data would change what it matches", async () => {
    // The keep-gate sentence, made falsifiable. The filter selects `label: "one"`, and
    // the update rewrites `label` — so a second evaluation of the same filter after
    // the first member wrote would match a different set. It matches once.
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: updateManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    await client.shelf.create({ data: { id: 1, room: "north" } });
    await client.bin.create({ data: { id: 1, label: "one" } });
    await client.bin.create({ data: { id: 2, label: "one" } });
    driver.statements.length = 0;

    await expect(
      client.bin.updateMany({
        where: { label: "one" },
        data: { label: "two", shelf: { connect: { id: 1 } } },
      })
    ).resolves.toEqual({ count: 2 });

    // One capture, two members, two roots moved — not one.
    expect(
      driver.statements.filter((entry) => entry === "UPDATE kseries_bins")
    ).toHaveLength(2);
    await expect(
      client.bin.findMany({
        orderBy: { id: "asc" },
        select: { id: true, shelfId: true },
      })
    ).resolves.toEqual([
      { id: 1, shelfId: 1 },
      { id: 2, shelfId: 1 },
    ]);
    await client.$disconnect();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// (3) The N-dependent refusal, at the construction seam.
// ---------------------------------------------------------------------------

describe("K4 — the N-dependent refusal runs before any member is built", () => {
  const seriesFor = (
    args: Record<string, unknown>,
    model = updateManySeriesSchema.bin
  ) => {
    const routed = routeUpdateMany(new PGliteDriver(), model, args);
    if (!(routed && isRecordSeries(routed))) {
      throw new Error("updateMany did not route to a record series");
    }
    return routed;
  };

  const capturedRows = (
    model: string,
    rows: readonly Record<string, unknown>[]
  ) => ({
    [planningKey(`${model}.updateManySeries.capture`, "rows")]: rows,
  });

  test.each([
    "connect",
    "connectOrCreate",
    "set",
  ])("child-held %s is refused at N = 2 and allowed at N = 1", (kind) => {
    const payload =
      kind === "connectOrCreate"
        ? { connectOrCreate: [{ where: { id: 1 }, create: { name: "x" } }] }
        : { [kind]: [{ id: 1 }] };
    const series = seriesFor({ data: { gadgets: payload } });
    expect(() =>
      series.compileMembers(capturedRows("bin", [{ id: 1 }, { id: 2 }]))
    ).toThrow(`it cannot apply '${kind}' to relation 'gadgets'`);
    expect(
      seriesFor({ data: { gadgets: payload } }).compileMembers(
        capturedRows("bin", [{ id: 1 }])
      )
    ).toHaveLength(1);
  });

  test("child-held create, update, delete and deleteMany are NOT refused", () => {
    for (const payload of [
      { create: { name: "fresh" } },
      { update: [{ where: { id: 1 }, data: { name: "x" } }] },
      { delete: [{ id: 1 }] },
      { deleteMany: [{}] },
      { disconnect: [{ id: 1 }] },
    ]) {
      expect(
        seriesFor({ data: { gadgets: payload } }).compileMembers(
          capturedRows("bin", [{ id: 1 }, { id: 2 }])
        )
      ).toHaveLength(2);
    }
  });

  test("junction and parent-held connect mean one thing per root and are allowed", () => {
    expect(
      seriesFor({ data: { zones: { connect: [{ id: 1 }] } } }).compileMembers(
        capturedRows("bin", [{ id: 1 }, { id: 2 }])
      )
    ).toHaveLength(2);
    expect(
      seriesFor({ data: { zones: { set: [{ id: 1 }] } } }).compileMembers(
        capturedRows("bin", [{ id: 1 }, { id: 2 }])
      )
    ).toHaveLength(2);
    expect(
      seriesFor({ data: { shelf: { connect: { id: 1 } } } }).compileMembers(
        capturedRows("bin", [{ id: 1 }, { id: 2 }])
      )
    ).toHaveLength(2);
  });

  test("an empty capture refuses nothing — it has no N to be dependent on", () => {
    const series = seriesFor({ data: { gadgets: { connect: [{ id: 1 }] } } });
    expect(series.compileMembers(capturedRows("bin", []))).toEqual([]);
    expect(
      series.parseSeries({
        captured: capturedRows("bin", []),
        memberResults: [],
        resultReadResults: [],
      })
    ).toEqual({ count: 0 });
  });
});

describe("nested updateMany replay owns its replayed OwnWrite footprint", () => {
  test("a changed client default is analyzed again before a selected member compiles", () => {
    replayOwnWriteDefaultValue = 1;
    replayOwnWriteDefaultCalls = 0;

    const schemas = createSchemaRegistry(replayOwnWriteSchema);
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(replayOwnWriteSchema, schemas)
    );
    const sourceScope = createQueryScope(
      engine.adapter,
      replayOwnWriteSchema.shelf
    );
    const targetScope = createQueryScope(
      engine.adapter,
      replayOwnWriteSchema.bin
    );
    const relationInfo = getRelationInfo(sourceScope, "bins");
    const relationSchemas = engine.schemaRegistry.getModelSchemas(
      replayOwnWriteSchema.shelf
    ).relations.bins;
    if (!(relationInfo && relationSchemas)) {
      throw new Error("expected the replay OwnWrite relation schema");
    }

    const source = {
      targets: {
        connectOrCreate: {
          where: { id: 99 },
          create: {},
        },
        set: [{ id: 2 }],
      },
    };
    const sourcePayload = { updateMany: { data: source } };
    const parsedPayload = parseValidated(
      relationSchemas.update,
      sourcePayload,
      "update",
      "data.bins"
    );
    const program = buildRelationMutationProgram(
      relationInfo,
      parsedPayload,
      sourcePayload
    );
    const updateMany = program?.entries.find(
      (entry) => entry.kind === "updateMany"
    );
    const mutationData = updateMany?.items[0]?.data;
    if (!(updateMany && mutationData)) {
      throw new Error("expected replayable nested updateMany data");
    }

    const initiallyParsed = buildParsedRelationPrograms(
      targetScope,
      mutationData.parsed,
      mutationData.source
    );
    expect(() =>
      assertUpdateOwnWriteSafety(
        targetScope,
        initiallyParsed.scalarData,
        initiallyParsed.relations,
        { id: 10 }
      )
    ).not.toThrow();
    const callsAfterEnclosingParse = replayOwnWriteDefaultCalls;

    replayOwnWriteDefaultValue = 2;
    const capture: ReadStep = {
      id: "nestedReplay.capture",
      kind: "read",
      statement: sql`SELECT 1`,
      outputs: { rows: { kind: "rows" } },
    };
    const unreachableCompiler = () => {
      throw new Error("member compilation reached an unsafe replayed program");
    };
    const recordCompilers: RecordCompilerSeam = {
      createFresh: unreachableCompiler,
      updateSelected: unreachableCompiler,
    };
    const boundRelation = bindRelation(sourceScope, relationInfo);
    if (boundRelation.position !== "childHeld") {
      throw new Error("expected child-held replay relation topology");
    }
    const series = new NestedSelectedRecordSeries({
      engine,
      sourceScope,
      targetScope,
      relationInfo,
      member: { kind: "replayPerRecord", data: mutationData },
      capture,
      recordCompilers,
      membership: {
        kind: "childHeld",
        binding: bindCorrelatedRelationMembership(
          boundRelation,
          { kind: "literal", value: 1 },
          { kind: "literal", value: 1 }
        ),
        known: {},
        correlate: "existingMembers",
      },
    });

    expect(() =>
      series.compileMembers({
        [`${capture.id}.rows`]: [{ id: 10 }],
      })
    ).toThrow(
      "Nested operation 'set' on relation 'targets' depends on an earlier 'connectOrCreate' target write"
    );
    expect(replayOwnWriteDefaultCalls).toBeGreaterThan(
      callsAfterEnclosingParse
    );
  });
});

/**
 * Runs one statement on the series' OWN transaction, immediately before the first
 * statement the caller's predicate matches — the concurrent-writer injection this
 * estate uses everywhere a race has to be reached on a single connection. Inside the
 * scope, so the rollback takes it back with everything else, which is exactly what
 * lets the retry converge.
 */
class MidSeriesPGliteDriver extends PGliteDriver {
  readonly statements: { sql: string; params: unknown[] }[] = [];
  private hook: string | undefined;
  private readonly matches: (sql: string, params: unknown[]) => boolean;

  constructor(
    hook: string,
    matches: (sql: string, params: unknown[]) => boolean,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.hook = hook;
    this.matches = matches;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ) {
    if (this.hook && this.matches(statement, params)) {
      const injected = this.hook;
      this.hook = undefined;
      await super.execute(client, injected, [], context);
    }
    this.statements.push({ sql: statement, params });
    return super.execute<T>(client, statement, params, context);
  }
}

describe("K — a raceable member failure retries the whole series, CAPTURE included", () => {
  test("the capture re-runs, every member re-runs, and the first attempt leaves nothing", async () => {
    // Member zero's `connectOrCreate` probes for shelf 9, misses, and takes its
    // CREATE arm — an INSERT carrying the `whenMissing: "constraint"` race pin. The
    // injection puts the row there first, inside this very scope, so that INSERT
    // violates the pinned unique: a raceable failure, which `executeRoutedOperation`
    // retries ONCE.
    //
    // This is the half Package J could not show. A `createMany` capture is EMPTY by
    // contract (plan §4.4), so J's retry witness could only observe its MEMBERS
    // re-running; `updateMany` is the first series whose capture issues a real
    // statement, and re-running it is what makes the retry correct rather than merely
    // repeated — the roots the second attempt updates are the roots that exist after
    // the first attempt rolled back.
    const driver = new MidSeriesPGliteDriver(
      `INSERT INTO "kseries_shelves" ("id", "room") VALUES (9, 'contended')`,
      (sql, params) =>
        sql.startsWith("INSERT") &&
        sql.includes("kseries_shelves") &&
        params.includes(9),
      undefined
    );
    const client = createClient({
      schema: updateManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    await client.bin.create({ data: { id: 1, label: "one" } });
    await client.bin.create({ data: { id: 2, label: "two" } });
    driver.statements.length = 0;

    const result = await client.bin.updateMany({
      where: { id: { in: [1, 2] } },
      data: {
        label: "retried",
        shelf: {
          connectOrCreate: {
            where: { id: 9 },
            create: { id: 9, room: "made" },
          },
        },
      },
    });

    expect(result).toEqual({ count: 2 });
    // THE CAPTURE RAN TWICE. Both attempts lock and read the root set; a member's own
    // locate is `FOR UPDATE` too, so the two are told apart by their parameters — the
    // capture carries the filter's two bin ids, a locate carries one captured key.
    const locking = driver.statements.filter(
      (entry) =>
        entry.sql.includes("FOR UPDATE") && entry.sql.includes("kseries_bins")
    );
    expect(locking.filter((entry) => entry.params.length === 2)).toHaveLength(
      2
    );
    // Member ZERO ran on both attempts — it is the one that raced, and the retry
    // restarts the SERIES rather than resuming it. (Member one never ran on the first
    // attempt: member zero failed before reaching it, which is what "sequentially" and
    // "a failure rolls everything back" mean together.)
    expect(locking.filter((entry) => entry.params.length === 1)).toHaveLength(
      3
    );
    // Two roots, two root UPDATEs: the failed attempt reached neither.
    const rootWrites = driver.statements.filter(
      (entry) =>
        entry.sql.startsWith("UPDATE") && entry.sql.includes("kseries_bins")
    );
    expect(rootWrites).toHaveLength(2);
    // The first attempt left nothing: ONE shelf, both bins pointing at it.
    await expect(
      client.shelf.findMany({ select: { id: true } })
    ).resolves.toEqual([{ id: 9 }]);
    await expect(
      client.bin.findMany({
        orderBy: { id: "asc" },
        select: { id: true, shelfId: true },
      })
    ).resolves.toEqual([
      { id: 1, shelfId: 9 },
      { id: 2, shelfId: 9 },
    ]);
    await client.$disconnect();
  }, 60_000);
});

describe("the series seams on PendingOperation answer for a SECOND operation name", () => {
  // Package I wrote these refusals type-forced and unreachable; Package J made them
  // reachable through `createMany`. What is new here is that both sentences NAME the
  // operation, so a seam that happened to be hard-coded to one family would have gone
  // unnoticed with a single caller.
  const pendingFor = (data: Record<string, unknown>) =>
    engineFor(new PGliteDriver()).prepare<unknown>(
      updateManySeriesSchema.bin,
      "updateMany",
      { where: { id: 1 }, data }
    );
  const RELATION_DATA = { label: "x", shelf: { connect: { id: 1 } } };
  const SCALAR_DATA = { label: "x" };

  test("parseResult refuses a series by name — and the scalar arm still answers", () => {
    expect(() =>
      pendingFor(RELATION_DATA).parseResult({ rows: [], rowCount: 0 })
    ).toThrow(
      "Operation 'updateMany' on model 'bin' runs as a transactional record series and parses no single driver result."
    );
    expect(
      pendingFor(SCALAR_DATA).parseResult({ rows: [], rowCount: 3 })
    ).toEqual({
      count: 3,
    });
  });

  test("prepare() and buildStatement() decline a series without touching a phase", () => {
    const pending = pendingFor(RELATION_DATA);
    expect(pending.prepare()).toBeUndefined();
    expect(pending.buildStatement()).toBeUndefined();
    // …while the scalar arm is exactly the single statement it always was.
    expect(pendingFor(SCALAR_DATA).buildStatement()).toBeDefined();
  });
});

describe("K3 — the captured-order comparator is a TOTAL order over row keys", () => {
  // The series' ordering owner, probed directly: a schema-driven test can only reach
  // the int and string branches, and "total" is the property that makes execution
  // order reproducible — a comparator answering 0 for two unequal keys would make the
  // sort's output depend on the engine's sort implementation.
  const sorted = (fields: readonly string[], rows: Record<string, unknown>[]) =>
    sortCapturedRowKeys(fields, rows);

  test("a COMPOUND key orders by field, in schema order", () => {
    expect(
      sorted(
        ["a", "b"],
        [
          { a: 2, b: "x" },
          { a: 1, b: "z" },
          { a: 1, b: "a" },
        ]
      )
    ).toEqual([
      { a: 1, b: "a" },
      { a: 1, b: "z" },
      { a: 2, b: "x" },
    ]);
  });

  test("numbers and bigints compare across the two types, and null sorts first", () => {
    expect(
      sorted(["k"], [{ k: 10n }, { k: 2 }, { k: null }, { k: 9n }])
    ).toEqual([{ k: null }, { k: 2 }, { k: 9n }, { k: 10n }]);
  });

  test("Dates order by instant and byte arrays lexicographically", () => {
    expect(sorted(["k"], [{ k: new Date(20) }, { k: new Date(10) }])).toEqual([
      { k: new Date(10) },
      { k: new Date(20) },
    ]);
    expect(
      sorted(
        ["k"],
        [
          { k: Uint8Array.from([1, 2, 3]) },
          { k: Uint8Array.from([1, 2]) },
          { k: Uint8Array.from([0, 9]) },
        ]
      )
    ).toEqual([
      { k: Uint8Array.from([0, 9]) },
      { k: Uint8Array.from([1, 2]) },
      { k: Uint8Array.from([1, 2, 3]) },
    ]);
    // A view into a POOLED buffer must compare through its own window: both of
    // these are the same two bytes, sitting at different offsets of one allocation.
    const pool = Uint8Array.from([9, 9, 1, 2, 9, 1, 3, 9]);
    expect(
      sorted(
        ["k"],
        [{ k: pool.subarray(5, 7) }, { k: pool.subarray(2, 4) }]
      ).map((row) => Array.from(row.k as Uint8Array))
    ).toEqual([
      [1, 2],
      [1, 3],
    ]);
  });

  test("values of different types never compare equal", () => {
    // The falsifiable half: every adjacent pair below is ordered, so no two of them
    // answered 0, which is what keeps the sort's output independent of the engine's
    // sort algorithm.
    // The type ranks, in order: null/absent, boolean, number/bigint, string.
    const mixed = [{ k: null }, { k: true }, { k: 1 }, { k: "1" }];
    expect(sorted(["k"], [...mixed].reverse())).toEqual(mixed);
  });
});

// ---------------------------------------------------------------------------
// (4) The G blind spot this package closed.
// ---------------------------------------------------------------------------

describe("D — polymorphic writes inside nested updateMany", () => {
  const polyFamily = usePGliteSchemaFamily(polySchema);

  test("a targetless disconnect clears every matched member's storage pair", async () => {
    const client = polyFamily().client as any;
    await client.image.create({ data: { id: 1, url: "one" } });
    await client.board.create({ data: { id: 1, name: "board" } });
    await client.slot.create({
      data: {
        id: 1,
        caption: "before",
        board: { connect: { id: 1 } },
        media: { connect: { type: "image", where: { id: 1 } } },
      },
    });

    await client.board.update({
      where: { id: 1 },
      data: {
        slots: {
          updateMany: {
            where: { id: 1 },
            data: { caption: "after", media: { disconnect: true } },
          },
        },
      },
    });

    const stored = await client.$queryRawUnsafe(
      "SELECT caption, media_type, media_id FROM kpoly_slots WHERE id = 1"
    );
    expect(stored).toEqual([
      { caption: "after", media_type: null, media_id: null },
    ]);
  });

  test("a MALFORMED polymorphic envelope still reports its parse error", () => {
    const engine = engineFor(new PGliteDriver(), polySchema as any);
    let caught: unknown;
    try {
      constructRoutedOperation(engine, polySchema.board, "update", {
        where: { id: 1 },
        data: {
          slots: {
            updateMany: {
              where: {},
              data: {
                caption: "x",
                media: { connect: { type: "bogus", where: { id: 1 } } },
              },
            },
          },
        },
      });
      throw new Error("expected the malformed envelope to be refused");
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain(
      "ValidationError: Validation failed for update:"
    );
  });
});

// ---------------------------------------------------------------------------
// (5) How deep the N>1 membership refusal reaches.
// ---------------------------------------------------------------------------

/** A root, a to-many child with a PRODUCED identity (so N roots make N distinct
 *  children rather than colliding on a literal), and a grandchild the fresh child
 *  can ADOPT. The one schema shape that can ask the depth question at all. */
const depthSchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      label: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("kdepth_owners");
  const post = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      ownerId: s.int().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      comments: s.oneToMany(() => comment),
    })
    .map("kdepth_posts");
  const comment = s
    .model({
      id: s.int().id(),
      body: s.string(),
      postId: s.int().nullable(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id")
        .optional(),
    })
    .map("kdepth_comments");
  return { owner, post, comment };
})();
hydrateSchemaNames(depthSchema);

describe("K4 — the refusal covers the ROOT's relation keys, and says so", () => {
  const depthFamily = usePGliteSchemaFamily(depthSchema);

  test("a fresh DESCENDANT may adopt one shared target, and the last root keeps it", async () => {
    // THE MEASURED BOUNDARY, pinned so it stays a decision rather than a drift.
    // Spelled at the ROOT this is the refused shape: one child-held membership,
    // N roots, last-parent-wins. Spelled one level down — inside a `create` that is
    // itself per-root — nothing refuses it, and comment 7 ends under the LAST root's
    // fresh post with the first root's post silently unlinked.
    //
    // Deliberate: at that depth the series is doing EXACTLY what the same payload
    // spelled as N ordinary `update` calls does, so refusing here would make the
    // bulk spelling reject what the single spelling executes — the kind-gated
    // incoherence Package D removed. §5.2 legislates root shapes; this is the
    // sentence the plan does not have, recorded rather than left to be discovered.
    const client = depthFamily().client as any;
    await depthFamily().reset();
    await client.owner.create({ data: { id: 1, label: "a" } });
    await client.owner.create({ data: { id: 2, label: "b" } });
    await client.comment.create({ data: { id: 7, body: "shared" } });

    expect(
      await client.owner.updateMany({
        where: { id: { in: [1, 2] } },
        data: {
          label: "x",
          posts: {
            create: { title: "fresh", comments: { connect: [{ id: 7 }] } },
          },
        },
      })
    ).toEqual({ count: 2 });

    // One fresh post per root — that half IS per-root and is why `create` is not in
    // the refused set.
    expect(
      await client.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, ownerId: true },
      })
    ).toEqual([
      { id: 1, ownerId: 1 },
      { id: 2, ownerId: 2 },
    ]);
    // The adopted grandchild, however, is ONE row and belongs to the LAST root's post.
    expect(await client.comment.findUnique({ where: { id: 7 } })).toMatchObject(
      { postId: 2 }
    );
  });
});

// ---------------------------------------------------------------------------
// (6) The portable behavior.
// ---------------------------------------------------------------------------

const pgliteFamily = usePGliteSchemaFamily(updateManySeriesSchema);

registerUpdateManySeriesBehavior("PGlite transaction", () =>
  Promise.resolve(pgliteFamily().client)
);
