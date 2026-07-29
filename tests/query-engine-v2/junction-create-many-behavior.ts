import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "../../src/query-engine-v2/CreateOperation";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";

/**
 * N3 — the M2M completions, across the whole driver matrix.
 *
 * Two boundaries fall here, and neither needed a new mechanism:
 *
 * **N3-U1 — `createMany` through a junction.** `tags: { createMany: { data: […] } }`
 * refused with "does not support nested 'createMany' on many-to-many relation" under
 * BOTH roots, while `tags: { create: […] }` — the same rows, the same join rows —
 * executed. The junction already owned every piece: the per-row child INSERT, the
 * produced-identity backward `Ref` for a DB-generated target key, the idempotent join
 * write. `createMany` is now that same slot per row, plus `skipDuplicates` riding each
 * INSERT through the dialect's own primitive (`ON CONFLICT DO NOTHING` /
 * `INSERT OR IGNORE`, or the savepoint-wrapped executor effect on MySQL).
 *
 * **N3-U2 — a generated create-arm key in `upsert` through a junction.** The junction
 * upsert refused a create arm whose data omitted the target primary key, because its
 * same-operation dedup ledger and its duplicate-item UPDATE both addressed the target by
 * that literal. W4's closure gave the plain `upsert` a second identity source — a create
 * payload spelling a COMPLETE unique constraint names the row it is about to insert — and
 * the junction arm now takes the same one. The join row still rides the produced `Ref`;
 * the ledger and the duplicate's UPDATE ride the create-data unique, so no `Ref` ever
 * reaches a `where`.
 *
 * The pinned semantics of `skipDuplicates` here (deliberate — Prisma has no M2M
 * `createMany` to copy): the skip drops the CHILD ROW's insert; the JOIN ROW is a
 * different row and is written for every item. A duplicate item therefore leaves the
 * pre-existing target untouched and still links it to this parent. That is asserted
 * positively below — both halves, on the same call.
 *
 * Every witness runs through the OPERATION (not the routed client), so a batch-only
 * non-returning driver reaches the engine instead of stopping at the client's atomic
 * resolution; state is read back through a client on the caller's state driver.
 */
export const junctionCreateManySchema = (() => {
  // Explicit string keys on both sides: the base createMany shape, where every target
  // identity is a compile-time literal and `skipDuplicates` is expressible.
  const post = s
    .model({
      id: s.string().id(),
      // A second unique so a createMany can ride N1's located-parent Ref (the junction's
      // parent id comes from the located row, not from the `where`).
      slug: s.string().unique(),
      title: s.string(),
      tags: s.manyToMany(() => tag),
    })
    .map("n3_posts");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      color: s.string(),
      posts: s.manyToMany(() => post),
    })
    .map("n3_tags");
  // DB-generated keys on both sides, and a unique the create data can spell: the
  // produced-identity path (U1's generated leg, U2's identity source).
  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      labels: s.manyToMany(() => label),
    })
    .map("n3_articles");
  const label = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      note: s.string(),
      articles: s.manyToMany(() => article),
    })
    .map("n3_labels");
  // A generated key and NO other unique: the shape with no compile-time identity at all.
  const board = s
    .model({
      id: s.string().id(),
      marks: s.manyToMany(() => mark),
    })
    .map("n3_boards");
  const mark = s
    .model({
      id: s.int().id().increment(),
      text: s.string(),
      boards: s.manyToMany(() => board),
    })
    .map("n3_marks");
  return { post, tag, article, label, board, mark };
})();

function makeClient(driver: AnyDriver) {
  return createClient({ schema: junctionCreateManySchema, driver });
}
type JunctionClient = ReturnType<typeof makeClient>;

interface Runner {
  update(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<unknown>;
  create(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<unknown>;
}

function makeRunner(driver: AnyDriver): Runner {
  const schemas = createSchemaRegistry(junctionCreateManySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(junctionCreateManySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  // `async` deliberately: an operation's CONSTRUCTION is where every typed refusal is
  // raised, and a synchronous throw would escape `expect(...).rejects`. Wrapping it in a
  // promise makes "refused before any write" and "failed during execution" assertable the
  // same way — and the refusal witnesses below then also prove nothing was written.
  return {
    async update(modelName, model, args) {
      return await executor.execute(
        new UpdateOperation(engine, model, args),
        createOperationExecutionContext(
          modelName,
          "update",
          engine.instrumentation
        )
      );
    },
    async create(modelName, model, args) {
      return await executor.execute(
        new CreateOperation(engine, model, args),
        createOperationExecutionContext(
          modelName,
          "create",
          engine.instrumentation
        )
      );
    },
  };
}

/** The tag ids joined to a post, sorted — the membership the junction actually wrote. */
async function tagsOf(
  client: JunctionClient,
  postId: string
): Promise<string[]> {
  const rows = await client.tag.findMany({
    where: { posts: { some: { id: postId } } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

/** The label slugs joined to an article, sorted. */
async function labelsOf(
  client: JunctionClient,
  articleId: number
): Promise<string[]> {
  const rows = await client.label.findMany({
    where: { articles: { some: { id: articleId } } },
    orderBy: { slug: "asc" },
  });
  return rows.map((row) => row.slug);
}

const NO_BATCH_SKIP_LOWERING = /no atomic-batch lowering/;
/** N3-U1's new refusal: a skipped INSERT produces no identity for its join row. */
const SKIP_WITH_GENERATED_KEY =
  /a skipped row produces no identity for its join row/;
/** The own-write preflight's rejection of a second `upsert` item on one M2M relation. */
const SECOND_UPSERT_ITEM =
  /depends on an earlier 'upsert' target write in the same nested write/;
/** N3-U2's surviving refusal: a create arm with no compile-time identity at all. */
const NO_CREATE_ARM_IDENTITY =
  /cannot address the row its create arm inserts.*nor any complete unique constraint/s;

export function runJunctionCreateManyBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
  /**
   * Declared by the caller, never sniffed (the convention `located-parent-ref-behavior`
   * established): on a dialect whose `skipDuplicates` is NOT a SQL leaf
   * (`recoverableUniqueError` — MySQL) the skip is a savepoint-wrapped executor effect,
   * which a single atomic batch cannot carry. Such a leg must see the typed refusal with
   * NOTHING written. Requiring the leg to say so keeps it falsifiable both ways.
   */
  readonly skipDuplicatesInBatchIsInexpressible?: boolean;
}): void {
  describe(`${options.name} junction createMany + upsert identity (N3)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeClient(stateDriver);
      const run = makeRunner(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, run, dispose };
    };

    // ---------------------------------------------------------------- N3-U1

    test(
      "createMany under an update root writes the rows AND their join rows",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.post.create({
            data: { id: "p1", slug: "s1", title: "t" },
          });
          await run.update("post", junctionCreateManySchema.post, {
            where: { id: "p1" },
            data: {
              tags: {
                createMany: {
                  data: [
                    { id: "t1", name: "alpha", color: "red" },
                    { id: "t2", name: "beta", color: "blue" },
                  ],
                },
              },
            },
          });
          await expect(
            client.tag.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: "t1", name: "alpha", color: "red" },
            { id: "t2", name: "beta", color: "blue" },
          ]);
          expect(await tagsOf(client, "p1")).toEqual(["t1", "t2"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany under a CREATE root joins the fresh parent",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await run.create("post", junctionCreateManySchema.post, {
            data: {
              id: "p9",
              slug: "s9",
              title: "fresh",
              tags: {
                createMany: {
                  data: [
                    { id: "t7", name: "gamma", color: "green" },
                    { id: "t8", name: "delta", color: "grey" },
                  ],
                },
              },
            },
          });
          expect(await tagsOf(client, "p9")).toEqual(["t7", "t8"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany rides the located-parent Ref: an update located by a NON-PK unique",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          // A decoy seeded FIRST, so "the first post" or a re-consulted `where` lands
          // on it. The join rows must name the LOCATED post.
          await client.post.create({
            data: { id: "decoy", slug: "s-decoy", title: "decoy" },
          });
          await client.post.create({
            data: { id: "target", slug: "s-target", title: "target" },
          });
          await run.update("post", junctionCreateManySchema.post, {
            where: { slug: "s-target" },
            data: {
              tags: {
                createMany: { data: [{ id: "t5", name: "eps", color: "c" }] },
              },
            },
          });
          expect(await tagsOf(client, "target")).toEqual(["t5"]);
          expect(await tagsOf(client, "decoy")).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany with a DB-generated target key links each produced identity",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          // A pre-existing label the operation must NOT link: the join rows have to
          // carry the ids the two INSERTs produced, not "some label".
          await client.label.create({ data: { slug: "old", note: "n" } });
          const article = await client.article.create({ data: { title: "a" } });
          await run.update("article", junctionCreateManySchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                createMany: {
                  data: [
                    { slug: "one", note: "n1" },
                    { slug: "two", note: "n2" },
                  ],
                },
              },
            },
          });
          expect(await labelsOf(client, article.id)).toEqual(["one", "two"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany skipDuplicates leaves the existing row untouched and still links it",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.post.create({
            data: { id: "p1", slug: "s1", title: "t" },
          });
          // `t1` already exists with its own colour; the skip must not rewrite it.
          await client.tag.create({
            data: { id: "t1", name: "alpha", color: "ORIGINAL" },
          });
          const skip = () =>
            run.update("post", junctionCreateManySchema.post, {
              where: { id: "p1" },
              data: {
                tags: {
                  createMany: {
                    data: [
                      { id: "t1", name: "alpha", color: "OVERWRITTEN" },
                      { id: "t2", name: "beta", color: "fresh" },
                    ],
                    skipDuplicates: true,
                  },
                },
              },
            });
          if (options.skipDuplicatesInBatchIsInexpressible) {
            await expect(skip()).rejects.toThrow(NO_BATCH_SKIP_LOWERING);
            await expect(
              client.tag.findMany({ orderBy: { id: "asc" } })
            ).resolves.toEqual([
              { id: "t1", name: "alpha", color: "ORIGINAL" },
            ]);
            expect(await tagsOf(client, "p1")).toEqual([]);
            return;
          }
          await skip();
          // Half one: the duplicate row is NOT rewritten (the skip really skipped).
          await expect(
            client.tag.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: "t1", name: "alpha", color: "ORIGINAL" },
            { id: "t2", name: "beta", color: "fresh" },
          ]);
          // Half two: the join row is a different row, so BOTH targets are linked —
          // the pinned semantics, asserted rather than assumed.
          expect(await tagsOf(client, "p1")).toEqual(["t1", "t2"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany WITHOUT skipDuplicates fails closed on a duplicate",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.post.create({
            data: { id: "p1", slug: "s1", title: "t" },
          });
          await client.tag.create({
            data: { id: "t1", name: "alpha", color: "ORIGINAL" },
          });
          await expect(
            run.update("post", junctionCreateManySchema.post, {
              where: { id: "p1" },
              data: {
                tags: {
                  createMany: {
                    data: [
                      { id: "t1", name: "alpha", color: "x" },
                      { id: "t2", name: "beta", color: "y" },
                    ],
                  },
                },
              },
            })
          ).rejects.toThrow();
          // Atomic: neither the survivor row nor any join row landed.
          await expect(
            client.tag.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: "t1", name: "alpha", color: "ORIGINAL" }]);
          expect(await tagsOf(client, "p1")).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany with an empty data array writes nothing and does not fail",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.post.create({
            data: { id: "p1", slug: "s1", title: "t" },
          });
          await run.update("post", junctionCreateManySchema.post, {
            where: { id: "p1" },
            data: { tags: { createMany: { data: [] } } },
          });
          await expect(client.tag.findMany()).resolves.toEqual([]);
          expect(await tagsOf(client, "p1")).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "skipDuplicates with a DB-generated target key is a typed refusal, before any write",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          const article = await client.article.create({ data: { title: "a" } });
          await expect(
            run.update("article", junctionCreateManySchema.article, {
              where: { id: article.id },
              data: {
                labels: {
                  createMany: {
                    data: [{ slug: "one", note: "n" }],
                    skipDuplicates: true,
                  },
                },
              },
            })
          ).rejects.toThrow(SKIP_WITH_GENERATED_KEY);
          await expect(client.label.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    // ---------------------------------------------------------------- N3-U2

    test(
      "upsert through a junction creates a target whose key the database generates",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.label.create({ data: { slug: "other", note: "decoy" } });
          const article = await client.article.create({ data: { title: "a" } });
          await run.update("article", junctionCreateManySchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                upsert: [
                  {
                    where: { slug: "fresh" },
                    create: { slug: "fresh", note: "created" },
                    update: { note: "updated" },
                  },
                ],
              },
            },
          });
          expect(await labelsOf(client, article.id)).toEqual(["fresh"]);
          await expect(
            client.label.findUnique({ where: { slug: "fresh" } })
          ).resolves.toMatchObject({ slug: "fresh", note: "created" });
          // The decoy stays unjoined: the join row rode the produced id, not "a label".
          await expect(
            client.label.findUnique({ where: { slug: "other" } })
          ).resolves.toMatchObject({ note: "decoy" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "upsert through a junction updates a member whose key the database generated",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          const article = await client.article.create({ data: { title: "a" } });
          await run.update("article", junctionCreateManySchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                create: [{ slug: "member", note: "before" }],
              },
            },
          });
          await run.update("article", junctionCreateManySchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                upsert: [
                  {
                    where: { slug: "member" },
                    create: { slug: "member", note: "never" },
                    update: { note: "after" },
                  },
                ],
              },
            },
          });
          await expect(
            client.label.findUnique({ where: { slug: "member" } })
          ).resolves.toMatchObject({ note: "after" });
          expect(await labelsOf(client, article.id)).toEqual(["member"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "TWO upsert items on one M2M relation are the own-write preflight's, not the ledger's",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          const article = await client.article.create({ data: { title: "a" } });
          // MEASURED during N3-U2, and pinned here so the measurement cannot rot: the
          // own-write preflight rejects ANY second `upsert` item on one many-to-many
          // relation — even two with DISJOINT explicit primary keys — because a junction
          // upsert reads membership and an earlier item writes it (ATOM §4's own-write
          // doctrine, A14). So `compileUpsert`'s same-operation dedup ledger, whose
          // duplicate branch was the stated reason the old refusal demanded a literal
          // primary key, is not reachable from this surface at all. The refusal N3-U2
          // narrowed was therefore stricter than any reachable behavior required.
          //
          // The ledger is still keyed correctly (the create-data unique — see the file
          // header): the point of THIS test is that if the preflight ever relaxes, it
          // fails, and the ledger's keying gets re-examined instead of silently deciding
          // a case nobody measured.
          await expect(
            run.update("article", junctionCreateManySchema.article, {
              where: { id: article.id },
              data: {
                labels: {
                  upsert: [
                    {
                      where: { slug: "one" },
                      create: { slug: "one", note: "n1" },
                      update: { note: "u1" },
                    },
                    {
                      where: { slug: "two" },
                      create: { slug: "two", note: "n2" },
                      update: { note: "u2" },
                    },
                  ],
                },
              },
            })
          ).rejects.toThrow(SECOND_UPSERT_ITEM);
          await expect(client.label.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an upsert create arm with NO compile-time identity is a typed refusal",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.board.create({ data: { id: "b1" } });
          await expect(
            run.update("board", junctionCreateManySchema.board, {
              where: { id: "b1" },
              data: {
                marks: {
                  upsert: [
                    {
                      where: { id: 1 },
                      create: { text: "x" },
                      update: { text: "y" },
                    },
                  ],
                },
              },
            })
          ).rejects.toThrow(NO_CREATE_ARM_IDENTITY);
          await expect(client.mark.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
