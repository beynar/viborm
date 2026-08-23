import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

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
 * the junction arm took the same one.
 *
 * **N7-U-C — the ledger that justified all of it is GONE, and its "unreachable" was
 * wrong.** N3-U2 left an HONEST QUALIFICATION: the preflight rejects any second `upsert`
 * item, so the dedup ledger's duplicate branch is unreachable and the refusal it
 * justified was stricter than anything reachable. Re-measured at this head, that is
 * FALSE. The preflight decides by PROVABLE selector disjointness, and
 * `provesPortableDisjointness` proves it for int / bigint / boolean — the earlier
 * measurement had only string and generated keys to hand. Two integer-keyed items are
 * accepted, and the branch IS reachable: not through two items naming one target (the
 * preflight rejects exactly those) but through two items whose SELECTORS are provably
 * different and whose CREATE ARMS name one row. The branch then applied item 2's update
 * to the row item 1 created — a row item 2's `where` never named. Every reachable firing
 * was a wrong-row violation, so the branch is deleted; the second INSERT now meets the
 * target's own primary key, atomically, as it does in Prisma. With the branch went the
 * only consumer of the create-arm's compile-time `where`, and with THAT went the refusal
 * of a create arm carrying no unique — the join row never needed one (it rides the
 * produced `Ref`). All three are witnessed below.
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
      tags: s.toMany(() => tag),
    })
    .map("n3_posts");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      color: s.string(),
      posts: s.toMany(() => post),
      notes: s.toMany(() => tagNote),
    })
    .map("n3_tags");
  const tagNote = s
    .model({
      id: s.string().id(),
      body: s.string(),
      tagId: s.string(),
      tag: s
        .toOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .map("n3_tag_notes");
  // DB-generated keys on both sides, and a unique the create data can spell: the
  // produced-identity path (U1's generated leg, U2's identity source).
  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      labels: s.toMany(() => label),
    })
    .map("n3_articles");
  const label = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      note: s.string(),
      articles: s.toMany(() => article),
    })
    .map("n3_labels");
  // A generated key and NO other unique: the shape with no compile-time identity at all.
  const board = s
    .model({
      id: s.string().id(),
      marks: s.toMany(() => mark),
    })
    .map("n3_boards");
  const mark = s
    .model({
      id: s.int().id().increment(),
      text: s.string(),
      boards: s.toMany(() => board),
    })
    .map("n3_marks");
  // EXPLICIT INTEGER keys on both sides — N7-U-C. The own-write preflight decides a
  // second `upsert` item by PROVABLE disjointness of the two selectors, and
  // `provesPortableDisjointness` only proves it for int / bigint / boolean: two
  // different STRINGS are not portably unequal (collation), so `post`/`tag` above
  // cannot express an accepted pair and `article`/`label` cannot either. This pair can.
  const sheet = s
    .model({
      id: s.int().id(),
      cells: s.toMany(() => cell),
    })
    .map("n3_sheets");
  const cell = s
    .model({
      id: s.int().id(),
      code: s.int().unique(),
      text: s.string(),
      sheets: s.toMany(() => sheet),
    })
    .map("n3_cells");
  return { post, tag, tagNote, article, label, board, mark, sheet, cell };
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

/** The cell ids joined to a sheet, sorted (N7-U-C's integer-keyed junction). */
async function cellsOf(
  client: JunctionClient,
  sheetId: number
): Promise<number[]> {
  const rows = await client.cell.findMany({
    where: { sheets: { some: { id: sheetId } } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

/** The mark ids joined to a board, sorted. */
async function marksOf(
  client: JunctionClient,
  boardId: string
): Promise<number[]> {
  const rows = await client.mark.findMany({
    where: { boards: { some: { id: boardId } } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

const NO_BATCH_SKIP_LOWERING = /no atomic-batch lowering/;
/** The own-write preflight's rejection of a second `upsert` item on one M2M relation. */
const SECOND_UPSERT_ITEM =
  /depends on an earlier 'upsert' target write in the same nested write/;
/** The target's own unique constraint, the only thing that can catch two create arms
 *  naming one row (N7-U-C — the deleted ledger used to swallow this shape). */
const UNIQUE_VIOLATION = /Unique constraint/;

export function runJunctionCreateManyBehavior(
  options: {
    readonly name: string;
    /**
     * Declared by the caller, never sniffed (the convention `located-parent-ref-behavior`
     * established): on a dialect whose `skipDuplicates` is NOT a SQL leaf
     * (`recoverableUniqueError` — MySQL) the skip is a savepoint-wrapped executor effect,
     * which a single atomic batch cannot carry. Such a leg must see the typed refusal with
     * NOTHING written. Requiring the leg to say so keeps it falsifiable both ways.
     */
    readonly skipDuplicatesInBatchIsInexpressible?: boolean;
  } & BehaviorDatabaseSource
): void {
  describe(`${options.name} junction createMany + upsert identity (N3)`, () => {
    const openDatabase = useBehaviorDatabase(junctionCreateManySchema, options);

    const setup = async () => {
      const { driver, client, dispose } = await openDatabase();
      const run = makeRunner(driver);
      return { client, driver, run, dispose };
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
          await client.label.create({
            data: { id: -1, slug: "old", note: "n" },
          });
          const article = await client.article.create({
            data: { id: -1, title: "a" },
          });
          const operation = run.update(
            "article",
            junctionCreateManySchema.article,
            {
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
            }
          );
          await operation;
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
      "relation-bearing createMany skips the target subtree and its join together",
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

          const mutation = run.update("post", junctionCreateManySchema.post, {
            where: { id: "p1" },
            data: {
              tags: {
                createMany: {
                  data: [
                    {
                      id: "t1",
                      name: "alpha",
                      color: "IGNORED",
                      notes: {
                        create: { id: "note-skipped", body: "skipped" },
                      },
                    },
                    {
                      id: "t2",
                      name: "beta",
                      color: "fresh",
                      notes: {
                        create: { id: "note-kept", body: "kept" },
                      },
                    },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });

          await mutation;

          expect(await tagsOf(client, "p1")).toEqual(["t2"]);
          await expect(
            client.tag.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: "t1", name: "alpha", color: "ORIGINAL" },
            { id: "t2", name: "beta", color: "fresh" },
          ]);
          await expect(
            client.tagNote.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: "note-kept", body: "kept", tagId: "t2" }]);
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
      "skipDuplicates with a DB-generated target key ADOPTS the row already there",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          // RETARGETED from a refusal to an accept-and-execute assertion on the SAME
          // payload (E6.8, maintainer-authorized — expressible-shapes-plan.md Risks item 3).
          // N3-U1's refusal was right about the SKIP LEAF: a skipped INSERT produces no
          // identity for its join row. It was too wide about the SHAPE. `label` spells
          // exactly one unique a `whereUnique` can name, so the row is rewritten as a
          // `connectOrCreate` adopt, which HAS an identity — and delivers the semantics the
          // skip was pinned to: the row already there is untouched, and still linked.
          //
          // The refusal itself is not gone. What still reaches it is a row no single probe
          // can name — two spelled uniques, a NULL-membered compound, a unique index no
          // selector spells — witnessed in `junction-skip-adoption-behavior.ts`, which also
          // carries the state-equivalence and divergence witnesses for the absorbed halves.
          const existing = await client.label.create({
            data: { id: 1, slug: "one", note: "ORIGINAL" },
          });
          const article = await client.article.create({
            data: { id: 1, title: "a" },
          });
          await run.update("article", junctionCreateManySchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                createMany: {
                  data: [{ slug: "one", note: "IGNORED" }],
                  skipDuplicates: true,
                },
              },
            },
          });
          await expect(
            client.label.findUnique({ where: { slug: "one" } })
          ).resolves.toMatchObject({ id: existing.id, note: "ORIGINAL" });
          expect(await labelsOf(client, article.id)).toEqual(["one"]);
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
          await client.label.create({
            data: { id: -1, slug: "other", note: "decoy" },
          });
          const article = await client.article.create({
            data: { id: -1, title: "a" },
          });
          const operation = run.update(
            "article",
            junctionCreateManySchema.article,
            {
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
            }
          );
          await operation;
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
          const article = await client.article.create({
            data: { id: 1, title: "a" },
          });
          await run.update("article", junctionCreateManySchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                create: [{ id: 1, slug: "member", note: "before" }],
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

    // ---------------------------------------------------------------- N7-U-C

    test(
      "a second upsert item on one M2M relation turns on PROVABLE selector disjointness",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          const article = await client.article.create({
            data: { id: 1, title: "a" },
          });
          // The STRING-keyed half. Two items whose selectors name different slugs are
          // still rejected — not because "two items" is illegal, but because
          // `provesPortableDisjointness` refuses to declare two STRINGS unequal (a
          // case-insensitive or padding-insensitive collation can equate them), so the
          // preflight cannot prove item 2's selector misses the row item 1 writes and
          // fails closed (ATOM §4, A14).
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

          // The INTEGER-keyed half — the measurement that FALSIFIED N3-U2's "the
          // preflight rejects ANY second upsert item" and made this lane's premise
          // wrong. Two integer primary keys ARE portably unequal, so the same two-item
          // shape is ACCEPTED and both arms execute.
          await client.sheet.create({ data: { id: 1 } });
          await run.update("sheet", junctionCreateManySchema.sheet, {
            where: { id: 1 },
            data: {
              cells: {
                upsert: [
                  {
                    where: { id: 10 },
                    create: { id: 10, code: 100, text: "n1" },
                    update: { text: "u1" },
                  },
                  {
                    where: { id: 20 },
                    create: { id: 20, code: 200, text: "n2" },
                    update: { text: "u2" },
                  },
                ],
              },
            },
          });
          await expect(
            client.cell.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 10, code: 100, text: "n1" },
            { id: 20, code: 200, text: "n2" },
          ]);
          expect(await cellsOf(client, 1)).toEqual([10, 20]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "two upsert create arms naming ONE row fail on the target's unique constraint",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.sheet.create({ data: { id: 1 } });
          // The exact payload that used to reach `compileUpsert`'s same-operation dedup
          // ledger, and the reason the ledger is gone (N7-U-C). Item 2 SELECTS cell 20 —
          // provably a different row from the cell 10 item 1 writes, which is why the
          // preflight admits the pair — but its create arm names cell 10. The ledger saw
          // the colliding create identity and silently turned item 2 into an UPDATE of
          // cell 10, a row item 2's `where` never named: the wrong-row doctrine's exact
          // failure, and the ONLY shape that could ever reach that branch. With the
          // branch deleted the second INSERT runs and the target's own primary key
          // refuses it, atomically, leaving nothing behind — Prisma's behavior too.
          await expect(
            run.update("sheet", junctionCreateManySchema.sheet, {
              where: { id: 1 },
              data: {
                cells: {
                  upsert: [
                    {
                      where: { id: 10 },
                      create: { id: 10, code: 100, text: "n1" },
                      update: { text: "u1" },
                    },
                    {
                      where: { id: 20 },
                      create: { id: 10, code: 999, text: "n2" },
                      update: { text: "WRONG-ROW" },
                    },
                  ],
                },
              },
            })
          ).rejects.toThrow(UNIQUE_VIOLATION);
          await expect(client.cell.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an upsert create arm with no unique in its data rides the produced identity",
      { timeout: 30_000 },
      async () => {
        const { client, run, dispose } = await setup();
        try {
          // RETARGETED from a decline to an accept-and-execute assertion on the SAME
          // payload (N7-U-C). `mark` has a generated key and NO other unique, so the
          // create data spells no compile-time identity at all — which used to be a
          // typed refusal, because the deleted dedup ledger needed a compile-time
          // `where` for the just-created row. The JOIN row never needed one: it rides
          // the backward `Ref` into this INSERT's own capture. With the ledger gone the
          // refusal has no invariant left to cover, and the shape executes.
          //
          // A decoy mark is seeded FIRST so "some mark" or a stale insertId lands on it:
          // the join row has to carry the id THIS insert produced.
          await client.board.create({ data: { id: "decoy-owner" } });
          await run.update("board", junctionCreateManySchema.board, {
            where: { id: "decoy-owner" },
            data: { marks: { create: [{ id: -1, text: "decoy" }] } },
          });
          await client.board.create({ data: { id: "b1" } });
          const operation = run.update(
            "board",
            junctionCreateManySchema.board,
            {
              where: { id: "b1" },
              data: {
                marks: {
                  upsert: [
                    {
                      // Absent globally, so the create arm runs (the decoy's own id must
                      // not be the one the join row carries).
                      where: { id: 999 },
                      create: { text: "x" },
                      update: { text: "y" },
                    },
                  ],
                },
              },
            }
          );
          await operation;
          const marks = await client.mark.findMany({ orderBy: { id: "asc" } });
          expect(marks.map((mark) => mark.text)).toEqual(["decoy", "x"]);
          expect(await marksOf(client, "b1")).toEqual([marks[1]?.id]);
          expect(await marksOf(client, "decoy-owner")).toEqual([marks[0]?.id]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
