import { createClient } from "@client/client";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { CreateManyRecordSeries } from "@src/query-engine/write-engine/CreateManyRecordSeries";
import {
  isRecordSeries,
  isSkippableCreateMemberResult,
} from "@src/query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import {
  createManySeriesSchema,
  registerCreateManySeriesBehavior,
} from "@tests/contracts/engine/write/create-many-relation-series-behavior";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE J — the record-series route for root `createMany`, on PGlite.
 *
 * Two kinds of claim live here and nowhere else:
 *
 *   · WHICH DESTINATION the router picks, per payload shape. J2 gave `createMany`
 *     three of them and one of the three is new, so "an empty payload never becomes
 *     a series" and "a polymorphic-only row never becomes a series" are assertions,
 *     not comments — an empty series would pay a BEGIN/COMMIT for nothing, and a
 *     polymorphic-only series would trade two grouped probes for N single lookups.
 *   · WHAT THE EXECUTOR ACTUALLY RAN, read off a traced driver. Ordering claims like
 *     "left to right" and "the returning read happens after every member" are only
 *     as good as the statement list, and a mid-transaction injection is the only way
 *     to reach the raceable retry on a single-connection substrate.
 *
 * The portable behavior — counts, first-create-wins, rollback, the returning
 * projection, the refusals — is `create-many-relation-series-behavior.ts`, run below
 * on PGlite and on the live servers by the `-docker` sibling.
 */

hydrateSchemaNames(createManySeriesSchema);

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(
      createManySeriesSchema,
      createSchemaRegistry(createManySeriesSchema)
    )
  );
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
}

function routeCreateMany(
  driver: AnyDriver,
  model: Model<any>,
  args: Record<string, unknown>
) {
  return constructRoutedOperation(engineFor(driver), model, "createMany", args);
}

/** Batch-only AND non-returning — the one substrate the `select` refusal names. */
class BatchOnlyNonReturningDriver extends MySQL2Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const LEADING_WORD = /\s+/;

const JSERIES_TABLE = /jseries_\w+/;

/** One ordered list of every statement the provider was actually asked to run,
 *  as `<VERB> <table>` — enough to read execution ORDER off, and stable across
 *  the column-list churn a byte pin would suffer. */
class TracingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];

  // The transaction ENVELOPE is traced too. PGlite opens its scope through its own
  // API rather than by issuing a `BEGIN` through `execute`, so without this an empty
  // series would look indistinguishable from the zero-I/O no-op it must stay.
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
    const table = JSERIES_TABLE.exec(statement)?.[0] ?? "?";
    this.statements.push(`${verb} ${table}`);
    return super.execute<T>(client, statement, params, context);
  }
}

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

// ---------------------------------------------------------------------------
// (1) Where the router sends each payload.
// ---------------------------------------------------------------------------

describe("J2 — the three destinations of one operation name", () => {
  const driver = new PGliteDriver();

  const isSeries = (args: Record<string, unknown>, model?: Model<any>) => {
    const routed = routeCreateMany(
      driver,
      model ?? createManySeriesSchema.post,
      args
    );
    return routed !== undefined && isRecordSeries(routed);
  };

  test("a scalar-only payload keeps the bulk owner", () => {
    expect(
      isSeries({
        data: [
          { id: 1, title: "a", authorId: 1 },
          { id: 2, title: "b", authorId: 1 },
        ],
      })
    ).toBe(false);
  });

  test("EMPTY data never becomes a series", () => {
    // I-outcomes item 2: `runSeriesOn` has no zero-member short-circuit, so an empty
    // series would open a transaction, commit it, and answer `{ count: 0 }` — where
    // the existing arm answers the same thing with no I/O at all. The rule that keeps
    // it out is structural (no row ⇒ no relation key), and this is the assertion that
    // the rule is actually load-bearing.
    expect(isSeries({ data: [] })).toBe(false);
    expect(isSeries({ data: [], select: { id: true } })).toBe(false);
  });

  test("one relation-bearing row routes the WHOLE operation", () => {
    expect(
      isSeries({
        data: [
          { id: 1, title: "a", authorId: 1 },
          { id: 2, title: "b", author: { connect: { id: 1 } } },
        ],
      })
    ).toBe(true);
  });

  test("a relation key spelled `undefined` is an ABSENT relation key", () => {
    // The spread-an-optional idiom (`{ ...(rel && { author: rel }) }` collapsed) must
    // not drag a scalar payload onto the series.
    expect(
      isSeries({
        data: [{ id: 1, title: "a", authorId: 1, author: undefined }],
      })
    ).toBe(false);
  });

  test("a direct polymorphic connect is NOT a general relation program", () => {
    expect(
      isSeries(
        {
          data: [
            {
              id: 1,
              caption: "c",
              postId: 1,
              media: { connect: { type: "image", where: { id: 1 } } },
            },
          ],
        },
        createManySeriesSchema.attachment
      )
    ).toBe(false);
  });

  test("…but the same membership BESIDE an ordinary relation does route", () => {
    expect(
      isSeries(
        {
          data: [
            {
              id: 1,
              caption: "c",
              media: { connect: { type: "image", where: { id: 1 } } },
              post: { connect: { id: 1 } },
            },
          ],
        },
        createManySeriesSchema.attachment
      )
    ).toBe(true);
  });

  test("a malformed payload keeps its existing owner and its existing error", () => {
    // The discriminant is total and non-throwing: what it cannot classify with
    // certainty falls back to the existing owner, so a malformed payload keeps the
    // exact message it had — raised, as before, by that owner's own parse.
    const messageOf = (args: Record<string, unknown>) => {
      try {
        routeCreateMany(driver, createManySeriesSchema.post, args);
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    expect(messageOf({ data: "not an array" })).toBe(
      "Validation failed for createMany: Expected array"
    );
    expect(messageOf({ data: [7] })).toBe(
      "Validation failed for createMany: Expected object"
    );
  });
});

describe("J2 — select keeps its typed refusal while default batch routes", () => {
  const RELATION_ROW = { id: 1, title: "a", author: { connect: { id: 1 } } };

  test("a relation-bearing payload WITH select still gets the specific sentence", () => {
    // `select` is a separate row-returning contract. This non-returning provider cannot
    // roll back public result parsing, so its specific owner answers before the default
    // record-series route.
    let thrown: unknown;
    try {
      routeCreateMany(
        new BatchOnlyNonReturningDriver(),
        createManySeriesSchema.post,
        { data: [RELATION_ROW], select: { id: true } }
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      "Driver 'mysql2' cannot execute 'createMany' with 'select' because public result parsing cannot be rolled back."
    );
  });

  test("without select the same substrate takes the series", () => {
    // The row-returning limitation belongs only to `select`. The default `{ count }`
    // payload keeps the record-series route and can use ordered atomic batches.
    const routed = routeCreateMany(
      new BatchOnlyNonReturningDriver(),
      createManySeriesSchema.post,
      { data: [RELATION_ROW] }
    );
    expect(routed !== undefined && isRecordSeries(routed)).toBe(true);
  });

  test("a RETURNING batch-only driver has no such refusal and takes the series", () => {
    // The predicate is three conditions, not two: PGlite in a forced batch returns
    // rows, so the sentence above does not apply and the payload routes normally.
    const routed = routeCreateMany(
      new BatchOnlyPGliteDriver(),
      createManySeriesSchema.post,
      { data: [RELATION_ROW], select: { id: true } }
    );
    expect(routed !== undefined && isRecordSeries(routed)).toBe(true);
  });

  test("`$transaction([...])` on a batch-only driver refuses the series by NAME", async () => {
    // The fourth seam plan §4.4 names — "transaction-array merging on a driver that
    // offers only a prebuilt batch". Package I wired it (a series contributes no
    // prepared batch, so the merge falls through to the client's own sentence); this
    // is the first payload that actually reaches it. No new machinery: the message is
    // the client's pre-existing one, word for word.
    const database = new PGlite();
    const setup = createClient({
      schema: createManySeriesSchema,
      driver: new PGliteDriver({ client: database }),
    }) as any;
    const { push } = await import("@migrations");
    await push(setup, { force: true });
    const batchOnly = createClient({
      schema: createManySeriesSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    }) as any;

    await expect(
      batchOnly.$transaction([
        batchOnly.post.createMany({
          data: [{ id: 1, title: "a", author: { create: { name: "n" } } }],
        }),
      ])
    ).rejects.toThrow(
      'Driver "pglite" does not support callback transactions and this transaction contains operations that cannot be batched atomically.'
    );
    await expect(batchOnly.post.count({})).resolves.toBe(0);
    await batchOnly.$disconnect();
  }, 60_000);

  test("PACKAGE E §10.3 — a COLLECTION-bearing member reaches the same array refusal, before any write", async () => {
    // §10.3: an explicit `$transaction([...])` must decide preparability BEFORE it
    // writes anything. A collection row is prepared by exactly the machinery an
    // ordinary relation row is — it contributes no shared batch because it is a
    // record series — so the refusal is the same client sentence, reached one
    // payload shape wider. The pin is that E did NOT open a path where a
    // collection member is prepared as a merged fragment and half-lands.
    const database = new PGlite();
    const setup = createClient({
      schema: createManySeriesSchema,
      driver: new PGliteDriver({ client: database }),
    }) as any;
    const { push } = await import("@migrations");
    await push(setup, { force: true });
    await setup.seal.create({ data: { id: 3, label: "target" } });
    const batchOnly = createClient({
      schema: createManySeriesSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    }) as any;

    await expect(
      batchOnly.$transaction([
        batchOnly.author.createMany({
          data: [
            {
              name: "arrayed",
              badges: { connect: [{ type: "seal", where: { id: 3 } }] },
            },
          ],
        }),
      ])
    ).rejects.toThrow(
      'Driver "pglite" does not support callback transactions and this transaction contains operations that cannot be batched atomically.'
    );
    await expect(batchOnly.author.count({})).resolves.toBe(0);
    await batchOnly.$disconnect();
  }, 60_000);
});

describe("record-series skip outcome integrity", () => {
  test("only the executor's exact inserted/skipped shapes are accepted", () => {
    expect(isSkippableCreateMemberResult({ kind: "skipped" })).toBe(true);
    expect(
      isSkippableCreateMemberResult({ kind: "inserted", value: { id: 1 } })
    ).toBe(true);
    expect(isSkippableCreateMemberResult({ kind: "inserted" })).toBe(false);
    expect(
      isSkippableCreateMemberResult({ kind: "skipped", value: { id: 1 } })
    ).toBe(false);
  });

  test("a skip-enabled series refuses a raw member row instead of counting it", () => {
    const series = new CreateManyRecordSeries(
      engineFor(new PGliteDriver()),
      createManySeriesSchema.post,
      {
        data: [
          {
            id: 1,
            title: "one",
            author: { connect: { name: "resident" } },
          },
        ],
        skipDuplicates: true,
      }
    );

    expect(() =>
      series.parseSeries({
        captured: {},
        memberResults: [{ id: 1 }],
        resultReadResults: [],
      })
    ).toThrow(
      "query-engine-v2 createMany with skipDuplicates lost a member's exact inserted/skipped outcome."
    );
  });
});

describe("child-held relation-bearing skip on default batch execution", () => {
  const nestedSkip = {
    where: { id: 1 },
    data: {
      posts: {
        createMany: {
          data: [
            { id: 1, title: "a", tags: { connect: { name: "t" } } },
            { id: 2, title: "b", tags: { connect: { name: "t" } } },
          ],
          skipDuplicates: true,
        },
      },
    },
  };

  test("a duplicate root suppresses its subtree and a fresh sibling lands", async () => {
    const database = new PGlite();
    const setup = createClient({
      schema: createManySeriesSchema,
      driver: new PGliteDriver({ client: database }),
    }) as any;
    const { push } = await import("@migrations");
    await push(setup, { force: true });
    await setup.author.create({ data: { id: 1, name: "owner" } });
    await setup.tag.create({ data: { id: 1, name: "t" } });
    await setup.post.create({
      data: {
        id: 1,
        title: "existing",
        author: { connect: { id: 1 } },
      },
    });

    const batchOnly = createClient({
      schema: createManySeriesSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    }) as any;

    await expect(batchOnly.author.update(nestedSkip)).resolves.toEqual({
      id: 1,
      name: "owner",
    });

    await expect(
      batchOnly.post.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          title: true,
          authorId: true,
          tags: { select: { id: true, name: true } },
        },
      })
    ).resolves.toEqual([
      { id: 1, title: "existing", authorId: 1, tags: [] },
      {
        id: 2,
        title: "b",
        authorId: 1,
        tags: [{ id: 1, name: "t" }],
      },
    ]);
    await expect(
      batchOnly.author.findMany({ select: { id: true, name: true } })
    ).resolves.toEqual([{ id: 1, name: "owner" }]);
    await expect(
      batchOnly.tag.findMany({ select: { id: true, name: true } })
    ).resolves.toEqual([{ id: 1, name: "t" }]);
    await batchOnly.$disconnect();
  }, 60_000);
});

describe("relation-bearing skipDuplicates construction", () => {
  test("routes through the record series", () => {
    const routed = routeCreateMany(
      new PGliteDriver(),
      createManySeriesSchema.post,
      {
        data: [{ id: 1, title: "a", author: { create: { name: "n" } } }],
        skipDuplicates: true,
      }
    );
    expect(routed !== undefined && isRecordSeries(routed)).toBe(true);
  });

  test("a malformed payload still fails VALIDATION first", () => {
    // The series shell still parses before it constructs any member.
    expect(() =>
      routeCreateMany(new PGliteDriver(), createManySeriesSchema.post, {
        data: [{ id: 1, titlle: "typo", author: { create: { name: "n" } } }],
        skipDuplicates: true,
      })
    ).toThrow("Validation failed for createMany: Unknown key: titlle");
  });
});

describe("J3 — each row is parsed EXACTLY once", () => {
  test("the createMany schema validates once; the create schema never", async () => {
    // Plan §5.1's rule, and the one nobody could see. It holds today only because the
    // series parses the whole payload once and hands its members already-parsed rows
    // (`SubOperationOptions.parsedRoot`). The obvious "simplification" — give members
    // the RAW rows and let `CreateOperation` parse each one — would pass every other
    // test in this estate while silently re-materializing ulid/now defaults and
    // re-parsing a schema's own transformed output, which is measured NON-idempotent
    // (X2, `parse-boundary.ts`). Counted at the schemas themselves, so no refactor can
    // route around it.
    const driver = new PGliteDriver();
    const engine = engineFor(driver);
    const schemas = engine.schemaRegistry.getModelSchemas(
      createManySeriesSchema.post
    ) as any;
    const counts = { createMany: 0, create: 0 };
    const restore: (() => void)[] = [];
    for (const key of ["createMany", "create"] as const) {
      const standard = schemas.args[key]["~standard"];
      const original = standard.validate.bind(standard);
      standard.validate = (value: unknown) => {
        counts[key] += 1;
        return original(value);
      };
      restore.push(() => {
        standard.validate = original;
      });
    }

    try {
      constructRoutedOperation(engine, createManySeriesSchema.post, "create", {
        data: { id: 9, title: "control", author: { create: { name: "c" } } },
      });
      // The control says the counter works: an ordinary `create` DOES validate through
      // `args.create`. The series below must leave that number where it is.
      expect(counts).toEqual({ createMany: 0, create: 1 });

      const routed = constructRoutedOperation(
        engine,
        createManySeriesSchema.post,
        "createMany",
        {
          data: [
            { id: 1, title: "a", author: { create: { name: "a1" } } },
            { id: 2, title: "b", author: { create: { name: "a2" } } },
            { id: 3, title: "c", author: { create: { name: "a3" } } },
          ],
        }
      );
      expect(routed !== undefined && isRecordSeries(routed)).toBe(true);
      // ONE parse for the whole payload…
      expect(counts).toEqual({ createMany: 1, create: 1 });
      // …and BUILDING all three members — the step that would re-parse — adds none.
      expect((routed as any).compileMembers({})).toHaveLength(3);
      expect(counts).toEqual({ createMany: 1, create: 1 });
    } finally {
      for (const undo of restore) undo();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) What the executor ran.
// ---------------------------------------------------------------------------

describe("J3/J4 — the statement list the series actually issues", () => {
  test("empty data issues no statement, and keeps the arm a batch-only driver can run", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: createManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    driver.statements.length = 0;

    await expect(client.post.createMany({ data: [] })).resolves.toEqual({
      count: 0,
    });
    // MEASURED, and it corrects the Package I brief's stated cost: the existing empty
    // arm ALREADY opens a transaction envelope (its plan is not one statement, so the
    // executor wraps it), so "an empty series would pay a BEGIN/COMMIT" is not the
    // difference. It issues no STATEMENT either way. The difference that is real is
    // below.
    expect(driver.statements).toEqual(["BEGIN"]);
    await client.$disconnect();
  }, 60_000);

  test("…and on a batch-only substrate the empty payload still ANSWERS", async () => {
    // No row means no relation-bearing member and no batch to submit. The common
    // spread-a-possibly-empty-array call stays on the no-op arm and answers zero.
    const database = new PGlite();
    const setup = createClient({
      schema: createManySeriesSchema,
      driver: new PGliteDriver({ client: database }),
    }) as any;
    const { push } = await import("@migrations");
    await push(setup, { force: true });
    const batchOnly = createClient({
      schema: createManySeriesSchema,
      driver: new BatchOnlyPGliteDriver({ client: database }),
    }) as any;

    await expect(batchOnly.post.createMany({ data: [] })).resolves.toEqual({
      count: 0,
    });
    await setup.$disconnect();
  }, 60_000);

  test("members run left to right and the returning read comes after all of them", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: createManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    driver.statements.length = 0;

    await client.post.createMany({
      data: [
        { id: 1, title: "one", author: { create: { name: "a1" } } },
        { id: 2, title: "two", author: { create: { name: "a2" } } },
      ],
      select: { id: true },
    });

    // The whole issued sequence, in order. Read it as the plan's sentence: member 0's
    // complete subtree (its author, then its own row, then the member's terminal read
    // of its final row key), then member 1's, and only THEN one grouped read that
    // answers the public projection. Nothing writes after that read, which is what
    // "read after every member finishes" means operationally.
    expect(driver.statements).toEqual([
      "BEGIN",
      "INSERT jseries_authors",
      "INSERT jseries_posts",
      "SELECT jseries_posts",
      "INSERT jseries_authors",
      "INSERT jseries_posts",
      "SELECT jseries_posts",
      "SELECT jseries_posts",
    ]);
    await client.$disconnect();
  }, 60_000);

  test("the `{ count }` arm issues no result reads at all", async () => {
    const driver = new TracingPGliteDriver();
    const client = createClient({
      schema: createManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    driver.statements.length = 0;

    await client.post.createMany({
      data: [
        { id: 1, title: "one", author: { create: { name: "a1" } } },
        { id: 2, title: "two", author: { create: { name: "a2" } } },
      ],
    });

    // Each member still ends with its own terminal read: plan §6 J3 step 4 asks every
    // member for its complete final root row key, and an ordinary `create` publishes
    // that through the read it already emits. What the count arm does NOT do is read
    // anything a second time — `count` is the member count, so `compileResultReads`
    // returns nothing.
    expect(driver.statements).toEqual([
      "BEGIN",
      "INSERT jseries_authors",
      "INSERT jseries_posts",
      "SELECT jseries_posts",
      "INSERT jseries_authors",
      "INSERT jseries_posts",
      "SELECT jseries_posts",
    ]);
    await client.$disconnect();
  }, 60_000);
});

describe("J — a raceable member failure retries the whole series", () => {
  test("the routed retry re-runs every member; the first attempt leaves nothing", async () => {
    // The member's `connectOrCreate` probes, misses, and takes its CREATE arm — an
    // INSERT carrying the `whenMissing: "constraint"` race pin. The injection puts the
    // row there first, inside this very scope, so that INSERT violates the pinned
    // unique: a raceable failure, which `executeRoutedOperation` retries ONCE. On the
    // second attempt the injection is spent AND rolled back, so the probe misses again
    // and the arm converges.
    //
    // The capture cannot be observed re-running here because a `createMany` capture is
    // EMPTY by contract (plan §4.4) — `record-series-contract.test.ts` owns that half
    // on a fake whose capture issues a statement. What this owns is the half only a
    // real payload can show: every MEMBER ran again, not just the one that failed.
    const driver = new MidSeriesPGliteDriver(
      `INSERT INTO "jseries_authors" ("name") VALUES ('contended')`,
      // The CONTENDED insert only — matching any author insert would land the row
      // before member zero's, which the second member's probe would then simply find.
      (sql, params) =>
        sql.startsWith("INSERT") &&
        sql.includes("jseries_authors") &&
        params.includes("contended"),
      undefined
    );
    const client = createClient({
      schema: createManySeriesSchema,
      driver,
    }) as any;
    const { push } = await import("@migrations");
    await push(client, { force: true });
    driver.statements.length = 0;

    const result = await client.post.createMany({
      data: [
        { id: 1, title: "one", author: { create: { name: "bystander" } } },
        {
          id: 2,
          title: "two",
          author: {
            connectOrCreate: {
              where: { name: "contended" },
              create: { name: "contended" },
            },
          },
        },
      ],
    });

    expect(result).toEqual({ count: 2 });
    // Member ZERO's author insert ran on BOTH attempts — the retry is of the whole
    // series, not of the member that failed. (Its own row is untouched by the race.)
    const bystanderInserts = driver.statements.filter(
      (entry) =>
        entry.sql.startsWith("INSERT") &&
        entry.sql.includes("jseries_authors") &&
        entry.params.includes("bystander")
    );
    expect(bystanderInserts).toHaveLength(2);
    // The first attempt left nothing: two authors, two posts, no duplicates.
    const authors = await client.author.findMany({ orderBy: { name: "asc" } });
    expect(authors.map((row: any) => row.name)).toEqual([
      "bystander",
      "contended",
    ]);
    await expect(client.post.count({})).resolves.toBe(2);
    await client.$disconnect();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// (3) The two PendingOperation refusals Package I could only type, not reach.
// ---------------------------------------------------------------------------

describe("the series seams on PendingOperation, now that a payload reaches them", () => {
  const RELATION_ROW = { id: 1, title: "a", author: { connect: { id: 1 } } };
  const SCALAR_ROW = { id: 1, title: "a", authorId: 1 };

  const pendingFor = (row: Record<string, unknown>) =>
    engineFor(new PGliteDriver()).prepare<unknown>(
      createManySeriesSchema.post,
      "createMany",
      { data: [row] }
    );

  test("parseResult refuses a series by name — and the scalar arm still answers", () => {
    // Package I wrote this refusal as TYPE-FORCED and unreachable: nothing routed a
    // series then. It is reachable now, and this is its falsifier — the same seam,
    // the same operation name, one payload apart.
    expect(() =>
      transactionOperation(pendingFor(RELATION_ROW)).parseResult({
        rows: [],
        rowCount: 0,
      })
    ).toThrow(
      "Operation 'createMany' on model 'post' runs as a transactional record series and parses no single driver result."
    );
    expect(
      transactionOperation(pendingFor(SCALAR_ROW)).parseResult({
        rows: [],
        rowCount: 3,
      })
    ).toEqual({ count: 3 });
  });

  test("cacheKeyArgs refuses a series — by the SAME absence every write lands on", () => {
    // The honest half: this refusal is now REACHED by a series, but it is not
    // DISTINGUISHABLE from the one a scalar bulk write already got. Both write forms
    // carry canonical `validatedArgs` for request/query inspection, but this
    // cache-only seam refuses every write with the same sentence. Recorded rather
    // than dressed up as a second observation.
    const message =
      "Operation 'createMany' on model 'post' exposes no validated payload to key a cache entry on.";
    expect(() => pendingFor(RELATION_ROW).cacheKeyArgs()).toThrow(message);
    expect(() => pendingFor(SCALAR_ROW).cacheKeyArgs()).toThrow(message);
    expect(
      engineFor(new PGliteDriver())
        .prepare<unknown>(createManySeriesSchema.post, "findMany", {
          where: { id: 1 },
        })
        .cacheKeyArgs()
      // The VALIDATED payload, normalized — which is the whole reason the key waits
      // for validation rather than using the caller's spelling.
    ).toMatchObject({ where: { id: { equals: 1 } } });
  });

  test("prepare() and buildStatement() decline a series without touching a phase", () => {
    const pending = pendingFor(RELATION_ROW);
    expect(transactionOperation(pending).prepare()).toBeUndefined();
    expect(pending.buildStatement()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (4) The ordinal contract of the returning arm.
// ---------------------------------------------------------------------------

/**
 * A root whose PRIMARY KEY contains a FOREIGN KEY — the one topology in which a
 * member's row key can stop addressing its row while the series is still running.
 * The main schema cannot express this (its post is keyed on a caller-supplied `id`
 * nothing else writes), and the failure is about ADDRESSING rather than dialect, so
 * it lives here on PGlite rather than in the portable behavior file.
 */
const sharedKeySchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string().unique(),
      items: s.toMany(() => item),
    })
    .map("jordinal_owners");

  const item = s
    .model({
      ownerId: s.int(),
      slug: s.string(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .id(["ownerId", "slug"])
    .map("jordinal_items");

  return { owner, item };
})();

describe("J4 — N rows in, N rows out, or a refusal", () => {
  const family = usePGliteSchemaFamily(sharedKeySchema);

  /** Row 1's nested `connect` ADOPTS row 0's root, which rewrites `ownerId` — and
   *  `ownerId` is half of the item's primary key, so row 0's key moves after row 0's
   *  own member already finished and published the old one. */
  const stealingPayload = [
    { slug: "a", owner: { connect: { id: 1 } } },
    {
      slug: "b",
      owner: {
        create: {
          id: 2,
          name: "u2",
          items: { connect: { ownerId_slug: { ownerId: 1, slug: "a" } } },
        },
      },
    },
  ];

  test("a row whose key a later row moved refuses instead of answering short", async () => {
    const client = family().client as any;
    await client.owner.create({ data: { id: 1, name: "u1" } });

    // WITHOUT the missing-key check this call RESOLVES with
    // `[{ ownerId: 2, slug: "b" }]`
    // — one row for a two-row `createMany`, no error, while the `{ count }` arm of the
    // byte-identical payload answers 2. The grouped result owner must therefore
    // reject a missing reported key instead of returning a plausible short list.
    await expect(
      client.item.createMany({
        data: stealingPayload,
        select: { slug: true, ownerId: true },
      })
    ).rejects.toThrow(
      "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls."
    );

    // A refusal, not a partial write: the whole series rolled back, so neither the two
    // items nor the owner row 1 created survive.
    await expect(client.item.findMany({})).resolves.toEqual([]);
    await expect(client.owner.count({})).resolves.toBe(1);
  });

  test("the `{ count }` arm of the same payload is untouched and correct", async () => {
    const client = family().client as any;
    await client.owner.create({ data: { id: 1, name: "u1" } });

    // The count arm reads nothing back, so nothing addresses a moved key: both roots
    // were inserted, `count` says 2, and both rows are there — under the new owner,
    // which is what the payload asked for. The refusal above is the RETURNING arm's
    // alone, and it is a refusal precisely because this arm proves the writes are fine.
    await expect(
      client.item.createMany({ data: stealingPayload })
    ).resolves.toEqual({ count: 2 });
    await expect(
      client.item.findMany({
        orderBy: [{ ownerId: "asc" }, { slug: "asc" }],
        select: { ownerId: true, slug: true },
      })
    ).resolves.toEqual([
      { ownerId: 2, slug: "a" },
      { ownerId: 2, slug: "b" },
    ]);
  });

  test("an ordinary relation-bearing returning payload still answers every row", async () => {
    const client = family().client as any;
    await client.owner.create({ data: { id: 1, name: "u1" } });

    // The missing-key contract is not a tax on the arm: the same shape without the
    // theft returns one row per input, in input order.
    await expect(
      client.item.createMany({
        data: [
          { slug: "a", owner: { connect: { id: 1 } } },
          { slug: "b", owner: { create: { id: 2, name: "u2" } } },
        ],
        select: { slug: true, ownerId: true },
      })
    ).resolves.toEqual([
      { slug: "a", ownerId: 1 },
      { slug: "b", ownerId: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// (5) The portable behavior.
// ---------------------------------------------------------------------------

const pgliteFamily = usePGliteSchemaFamily(createManySeriesSchema);

registerCreateManySeriesBehavior("PGlite transaction", () =>
  Promise.resolve(pgliteFamily().client)
);
