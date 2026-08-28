import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";

import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { createSchemaRegistry } from "@validation";
import { afterAll, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * E6.8 — `skipDuplicates` on a junction `createMany` whose target primary key the
 * database generates.
 *
 * MEASURED FIRST, at HEAD e37c611, on PGlite: every shape below raised the SAME
 * `UnsupportedOperationError` (V8003)
 *
 *   query-engine-v2 createMany-through-junction for relation 'labels' cannot use
 *   'skipDuplicates' when the target primary key 'id' is database-generated: a skipped row
 *   produces no identity for its join row. Supply 'id' in the createMany data, or drop
 *   'skipDuplicates'.
 *
 * — the model with a spellable unique, the model with no unique at all, and the model with
 * two. One sentence for three different situations.
 *
 * The maintainer's decision (expressible-shapes-plan.md, Risks item 3): **adopt-equivalence
 * defines skip for generated-key rows.** The pinned semantics of a skip here, from
 * `junction-create-many-behavior.ts`, is "a skipped item still links its parent to the row
 * that was already there" — and that is `connectOrCreate`, which has an identity where the
 * skip leaf has none. E6.8 absorbed two sub-shapes and left the third refused.
 *
 * **RESIDUAL PACKAGE F (2026-08-13) LIFTED THAT THIRD SHAPE.** The refusal quoted above no
 * longer exists; `routeJunctionCreateManyRow` assigns each input row one of four
 * dispositions and preserves mixed inputs as maximal ordered runs:
 *
 *  - **vacuous** (`board`/`mark`): nothing to conflict on, so the flag is dropped.
 *  - **adopt** (`article`/`label`, and `plate`/`slice` when the compound unique is
 *    COMPLETE): each row spells exactly one nameable unique, so each row becomes a
 *    `connectOrCreate` item — probe, adopt or insert, join. UNCHANGED, byte-identical.
 *  - **suppress** (`shelf`/`book`, `stack`/`item`, `crate`/`parcel`, `plate`/`slice`
 *    with a NULL member): the skipped-on row has no unambiguous selector, so
 *    the whole target-and-join member goes behind one savepoint. A unique conflict on the
 *    target ROOT rolls that member back and the series continues; the target is absent, its
 *    join row is absent, and every sibling member lands. It NEVER adopts: the row that was
 *    already there is neither rewritten nor linked, because no probe could prove it is the
 *    row the constraint fired on.
 *  - **leaf**: every row spells its key, so the identity is a compile-time literal and the
 *    existing skip leaf answers exactly as before.
 *
 * A mixed list keeps those row-local meanings and its original order. Dynamic planning
 * uses the existing record-series barrier so a later adopter observes prior effects.
 *
 * ANY OTHER FAILURE STILL ABORTS EVERYTHING (`vault`/`gem`/`facet`): a unique conflict
 * INSIDE the target subtree is not the annotated root's, so it escapes the savepoint and
 * the complete operation rolls back. Suppression is "this member's root conflicted", never
 * "this member failed".
 *
 * A raw unique index has no `whereUnique` selector. Even beside one complete nameable
 * unique, `crate`/`parcel` therefore suppresses rather than adopting a row selected by a
 * different constraint. Partial-index predicates are provider SQL and are not re-evaluated
 * by the query engine.
 *
 * Every witness runs through the OPERATION, so a batch-only driver reaches the engine
 * instead of stopping at the client's atomic resolution; state is read back through a
 * client on the caller's state driver.
 */
export const junctionSkipAdoptSchema = (() => {
  // ADOPT: a DB-generated key and exactly one nameable unique the rows spell.
  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      labels: s.toMany(() => label).through("e68_article_label"),
    })
    .map("e68_articles");
  const label = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      note: s.string(),
      // One endpoint owns every junction override (R011).
      articles: s.toMany(() => article),
    })
    .map("e68_labels");
  // VACUOUS: a DB-generated key and NOTHING else to conflict on.
  const board = s
    .model({
      id: s.string().id(),
      marks: s.toMany(() => mark).through("e68_board_mark"),
    })
    .map("e68_boards");
  const mark = s
    .model({
      id: s.int().id().increment(),
      text: s.string(),
      // One endpoint owns every junction override (R011).
      boards: s.toMany(() => board),
    })
    .map("e68_marks");
  // SUPPRESSED: two nameable uniques, both spelled — no single probe names the skipped-on
  // row, so the member is savepoint-scoped instead of adopted.
  const shelf = s
    .model({
      id: s.string().id(),
      books: s.toMany(() => book).through("e68_book_shelf"),
    })
    .map("e68_shelves");
  const book = s
    .model({
      id: s.int().id().increment(),
      isbn: s.string().unique(),
      code: s.string().unique(),
      title: s.string(),
      // One endpoint owns every junction override (R011).
      shelves: s.toMany(() => shelf),
    })
    .map("e68_books");
  // SUPPRESSED: the only nameable unique is COMPOUND with a nullable member the rows leave
  // absent. NULL is distinct from NULL in a unique index, so the constraint fires nothing
  // where the probe would find nothing — the two only agree by accident. The member
  // therefore inserts unless the database itself refuses it.
  const plate = s
    .model({
      id: s.string().id(),
      slices: s.toMany(() => slice).through("e68_plate_slice"),
    })
    .map("e68_plates");
  const slice = s
    .model({
      id: s.int().id().increment(),
      family: s.string(),
      variant: s.string().nullable(),
      text: s.string(),
      // One endpoint owns every junction override (R011).
      plates: s.toMany(() => plate),
    })
    .unique(["family", "variant"])
    .map("e68_slices");
  // SUPPRESSED: one nameable unique plus a raw unique index. The index has no selector,
  // so the engine cannot prove that the nameable key owns a conflict.
  const crate = s
    .model({
      id: s.string().id(),
      parcels: s.toMany(() => parcel).through("e68_crate_parcel"),
    })
    .map("e68_crates");
  const parcel = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      code: s.string(),
      note: s.string(),
      // One endpoint owns every junction override (R011).
      crates: s.toMany(() => crate),
    })
    .index(["code"], { unique: true, name: "e68_parcels_code_uq" })
    .map("e68_parcels");
  // SUPPRESSED, and NOT vacuous: the only unique besides the generated key is an INDEX no
  // selector can name. There is something to conflict on and no probe that can find it.
  const stack = s
    .model({
      id: s.string().id(),
      items: s.toMany(() => item).through("e68_stack_item"),
    })
    .map("e68_stacks");
  const item = s
    .model({
      id: s.int().id().increment(),
      tag: s.string(),
      text: s.string(),
      // One endpoint owns every junction override (R011).
      stacks: s.toMany(() => stack),
    })
    .index(["tag"], { unique: true, name: "e68_items_tag_uq" })
    .map("e68_items");
  // THE FATAL SIDE OF THE SAME MEMBER (residual Package F). Same unnameable index as
  // `stack`/`item`, plus a child the target subtree creates. A conflict on the target ROOT
  // suppresses; a conflict on the CHILD is not the annotated root's and aborts everything.
  const vault = s
    .model({
      id: s.string().id(),
      gems: s.toMany(() => gem).through("e68_vault_gem"),
    })
    .map("e68_vaults");
  // The NON-UNIQUE side of the same member root (review L3). `holderId` is a nullable
  // foreign key on the SUPPRESSIBLE target itself, so a row spelling a holder that does
  // not exist fails its own ROOT INSERT with a FOREIGN KEY violation — the one class of
  // root failure the savepoint must NOT absorb. It is a candidate inverse for nothing:
  // `collectInverseCandidates` keeps only back-references whose getter is the SOURCE
  // model, and this one points at `holder`, so `vault.gems`' omitted-FK projection is
  // unchanged and every existing gem witness (which omits it) still writes NULL.
  const holder = s
    .model({
      id: s.string().id(),
      gems: s.toMany(() => gem),
    })
    .map("e68_holders");
  const gem = s
    .model({
      id: s.int().id().increment(),
      tag: s.string(),
      text: s.string(),
      holderId: s.string().nullable(),
      holder: s
        .toOne(() => holder)
        .fields("holderId")
        .references("id"),
      facets: s.toMany(() => facet),
      // One endpoint owns every junction override (R011).
      vaults: s.toMany(() => vault),
    })
    .index(["tag"], { unique: true, name: "e68_gems_tag_uq" })
    .map("e68_gems");
  const facet = s
    .model({
      id: s.string().id().ulid(),
      slug: s.string().unique(),
      gemId: s.int(),
      gem: s
        .toOne(() => gem)
        .fields("gemId")
        .references("id"),
    })
    .map("e68_facets");
  return {
    article,
    label,
    board,
    mark,
    shelf,
    book,
    plate,
    slice,
    crate,
    parcel,
    stack,
    item,
    vault,
    holder,
    gem,
    facet,
  };
})();

function makeClient(driver: AnyDriver) {
  return createClient({ schema: junctionSkipAdoptSchema, driver });
}
type SkipAdoptClient = ReturnType<typeof makeClient>;

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
  const schemas = createSchemaRegistry(junctionSkipAdoptSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(junctionSkipAdoptSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  // `async` deliberately: an operation's CONSTRUCTION raises every typed refusal, and a
  // synchronous throw would escape `expect(...).rejects`.
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

/** The label slugs joined to an article, sorted — the membership actually written. */
async function labelsOf(
  client: SkipAdoptClient,
  articleId: number
): Promise<string[]> {
  const rows = await client.label.findMany({
    where: { articles: { some: { id: articleId } } },
    orderBy: { slug: "asc" },
  });
  return rows.map((row) => row.slug);
}

/** The mark texts joined to a board, sorted. */
async function marksOf(
  client: SkipAdoptClient,
  boardId: string
): Promise<string[]> {
  const rows = await client.mark.findMany({
    where: { boards: { some: { id: boardId } } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.text);
}

const UNIQUE_VIOLATION = /Unique constraint/;
/** The other class a member ROOT can fail with — never absorbed by the savepoint. */
const FOREIGN_KEY_VIOLATION = /Foreign key constraint/;
/** The tables this schema owns, children first — dropped once on a shared live server so a
 *  re-run never asks `syncLiveSchema(force)` to re-shape an index a live foreign key still needs. */
export const junctionSkipAdoptTables = [
  "e68_article_label",
  "e68_board_mark",
  "e68_book_shelf",
  "e68_plate_slice",
  "e68_crate_parcel",
  "e68_stack_item",
  "e68_vault_gem",
  "e68_facets",
  "e68_labels",
  "e68_articles",
  "e68_marks",
  "e68_boards",
  "e68_books",
  "e68_shelves",
  "e68_slices",
  "e68_plates",
  "e68_parcels",
  "e68_crates",
  "e68_items",
  "e68_stacks",
  "e68_gems",
  "e68_vaults",
  "e68_holders",
] as const;

/** Between tests: every row of every model (the join rows go with their targets). */
async function reset(client: SkipAdoptClient): Promise<void> {
  await client.label.deleteMany({});
  await client.article.deleteMany({});
  await client.mark.deleteMany({});
  await client.board.deleteMany({});
  await client.book.deleteMany({});
  await client.shelf.deleteMany({});
  await client.slice.deleteMany({});
  await client.plate.deleteMany({});
  await client.parcel.deleteMany({});
  await client.crate.deleteMany({});
  await client.item.deleteMany({});
  await client.stack.deleteMany({});
  await client.facet.deleteMany({});
  await client.gem.deleteMany({});
  await client.holder.deleteMany({});
  await client.vault.deleteMany({});
}

export function runJunctionSkipAdoptBehavior(options: {
  readonly name: string;
  /** Called ONCE per suite: the driver every test in it runs on. */
  readonly createDriver: () => AnyDriver;
  /** Live-server legs share a database — drop the tables before the single `push`. */
  readonly dropTablesFirst?: boolean;
  /** The batch leg keeps a compact pair of witnesses for generated-output adoption and
   * root-first suppression. The full rollback-sensitive matrix remains on interactive
   * PGlite, MySQL, and PostgreSQL. */
  readonly substrate?: "interactive" | "batch";
  readonly register?: (label: string, body: () => void) => void;
}): void {
  const register = options.register ?? describe;
  const interactive = (options.substrate ?? "interactive") === "interactive";
  register(
    `${options.name} junction createMany skipDuplicates + generated key (E6.8)`,
    () => {
      let shared:
        | { client: SkipAdoptClient; run: Runner; driver: AnyDriver }
        | undefined;
      const setup = async () => {
        if (!shared) {
          const driver = options.createDriver();
          const client = makeClient(driver);
          if (options.dropTablesFirst) {
            for (const table of junctionSkipAdoptTables) {
              await (client as any).$executeRawUnsafe(
                `DROP TABLE IF EXISTS ${table}`
              );
            }
          }
          await syncLiveSchema(client);
          shared = { client, run: makeRunner(driver), driver };
        }
        await reset(shared.client);
        // Disposal is the SUITE's, not the test's: one connection per suite, closed by the
        // caller's `afterAll`. A per-test dispose would reconnect on every case.
        return {
          client: shared.client,
          run: shared.run,
          // The shared live-server leg owns its own disconnect; a member must not
          // close the connection the next one reuses.
          dispose: async () => {
            /* shared connection: closed once by the suite that opened it */
          },
        };
      };
      afterAll(async () => {
        await shared?.client.$disconnect();
        shared = undefined;
      });

      // ------------------------------------------- what a BATCH-ONLY leg can express
      //
      // A nameable row takes the adopt route and can spend a freshly produced key through
      // exact generated-output segments. An unnameable row takes the root-isolated
      // suppression route; both execute on a native atomic-batch substrate.
      if (!interactive) {
        test("the adopt route publishes a fresh generated identity and links both rows", {
          timeout: 30_000,
        }, async () => {
          const { client, run, dispose } = await setup();
          try {
            // Raw setup keeps this case focused on update-root adopt-and-link. PostgreSQL
            // spelling is safe: the only batch leg is PGlite (the docker legs are
            // interactive).
            await (client as any).$executeRawUnsafe(
              `INSERT INTO "e68_labels" ("slug", "note") VALUES ('one', 'ORIGINAL')`
            );
            await (client as any).$executeRawUnsafe(
              `INSERT INTO "e68_articles" ("title") VALUES ('a')`
            );
            const [article] = await client.article.findMany({});
            await run.update("article", junctionSkipAdoptSchema.article, {
              where: { id: article?.id },
              data: {
                labels: {
                  createMany: {
                    data: [
                      { slug: "one", note: "OVERWRITTEN" },
                      { slug: "two", note: "fresh" },
                    ],
                    skipDuplicates: true,
                  },
                },
              },
            });
            await expect(
              client.label.findUnique({ where: { slug: "one" } })
            ).resolves.toMatchObject({ note: "ORIGINAL" });
            await expect(
              client.label.findUnique({ where: { slug: "two" } })
            ).resolves.toMatchObject({ note: "fresh" });
            expect(await labelsOf(client, article?.id as number)).toEqual([
              "one",
              "two",
            ]);
          } finally {
            await dispose();
          }
        });

        test("a batch-only substrate suppresses the duplicate root and dispatches no dependent join", {
          timeout: 30_000,
        }, async () => {
          const { client, run, dispose } = await setup();
          try {
            await client.stack.create({ data: { id: "k1" } });
            await run.update("stack", junctionSkipAdoptSchema.stack, {
              where: { id: "k1" },
              data: {
                items: {
                  createMany: {
                    data: [
                      { tag: "t", text: "one" },
                      { tag: "t", text: "two" },
                    ],
                    skipDuplicates: true,
                  },
                },
              },
            });
            await expect(
              client.item.findMany({ orderBy: { id: "asc" } })
            ).resolves.toMatchObject([{ tag: "t", text: "one" }]);
            await expect(
              client.item.findMany({
                where: { stacks: { some: { id: "k1" } } },
              })
            ).resolves.toMatchObject([{ tag: "t", text: "one" }]);
          } finally {
            await dispose();
          }
        });
        return;
      }

      // ------------------------------------------------- the adopt sub-shape (b)

      test("a PRE-EXISTING row is left untouched and still linked — the pinned skip semantics", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          // A decoy label seeded FIRST so "some label" or a stale insertId lands on it.
          await client.label.create({
            data: { slug: "decoy", note: "DECOY" },
          });
          const existing = await client.label.create({
            data: { slug: "one", note: "ORIGINAL" },
          });
          const article = await client.article.create({
            data: { title: "a" },
          });
          await run.update("article", junctionSkipAdoptSchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                createMany: {
                  data: [
                    { slug: "one", note: "OVERWRITTEN" },
                    { slug: "two", note: "fresh" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          // Half one: the row that was already there is NOT rewritten.
          await expect(
            client.label.findUnique({ where: { slug: "one" } })
          ).resolves.toMatchObject({ id: existing.id, note: "ORIGINAL" });
          // Half two: it is still linked to this parent, together with the fresh row.
          expect(await labelsOf(client, article.id)).toEqual(["one", "two"]);
          // The decoy is not linked: the join rows carry the probed key and the produced
          // Ref, never "a label".
          const decoy = await client.label.findUnique({
            where: { slug: "decoy" },
          });
          expect(decoy?.note).toBe("DECOY");
          expect(await labelsOf(client, article.id)).not.toContain("decoy");
        } finally {
          await dispose();
        }
      });

      test("a duplicate WITHIN the payload creates one row and links it once", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          const article = await client.article.create({
            data: { title: "a" },
          });
          await run.update("article", junctionSkipAdoptSchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                createMany: {
                  data: [
                    { slug: "dup", note: "first" },
                    { slug: "dup", note: "second" },
                    { slug: "other", note: "n" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          // First create wins, whole: one row, carrying the FIRST item's payload.
          const rows = await client.label.findMany({
            orderBy: { slug: "asc" },
          });
          expect(rows.map((row) => [row.slug, row.note])).toEqual([
            ["dup", "first"],
            ["other", "n"],
          ]);
          expect(await labelsOf(client, article.id)).toEqual(["dup", "other"]);
        } finally {
          await dispose();
        }
      });

      test("under a CREATE root the fresh parent adopts and creates the same way", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.label.create({ data: { slug: "old", note: "KEEP" } });
          await run.create("article", junctionSkipAdoptSchema.article, {
            data: {
              title: "fresh",
              labels: {
                createMany: {
                  data: [
                    { slug: "old", note: "IGNORED" },
                    { slug: "new", note: "made" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          const article = await client.article.findFirst({
            where: { title: "fresh" },
          });
          expect(article).not.toBeNull();
          await expect(
            client.label.findUnique({ where: { slug: "old" } })
          ).resolves.toMatchObject({ note: "KEEP" });
          expect(await labelsOf(client, article?.id as number)).toEqual([
            "new",
            "old",
          ]);
        } finally {
          await dispose();
        }
      });

      test("with nothing pre-existing every row is inserted and linked to its own new id", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          // A decoy ARTICLE too: the join rows must name the located parent.
          const decoyArticle = await client.article.create({
            data: { title: "decoy" },
          });
          const article = await client.article.create({
            data: { title: "a" },
          });
          await run.update("article", junctionSkipAdoptSchema.article, {
            where: { id: article.id },
            data: {
              labels: {
                createMany: {
                  data: [
                    { slug: "one", note: "n1" },
                    { slug: "two", note: "n2" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          expect(await labelsOf(client, article.id)).toEqual(["one", "two"]);
          expect(await labelsOf(client, decoyArticle.id)).toEqual([]);
        } finally {
          await dispose();
        }
      });

      // ----------------------------------------------- the vacuous sub-shape (a)

      test("a target with nothing to conflict on ignores the flag and writes every row", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.board.create({ data: { id: "decoy-owner" } });
          await run.update("board", junctionSkipAdoptSchema.board, {
            where: { id: "decoy-owner" },
            data: { marks: { create: [{ text: "decoy" }] } },
          });
          await client.board.create({ data: { id: "b1" } });
          await run.update("board", junctionSkipAdoptSchema.board, {
            where: { id: "b1" },
            data: {
              marks: {
                createMany: {
                  // Two IDENTICAL payloads: with no unique to conflict on they are two
                  // different rows, and `skipDuplicates` cannot mean anything about them.
                  data: [{ text: "same" }, { text: "same" }],
                  skipDuplicates: true,
                },
              },
            },
          });
          expect(await marksOf(client, "b1")).toEqual(["same", "same"]);
          expect(await marksOf(client, "decoy-owner")).toEqual(["decoy"]);
        } finally {
          await dispose();
        }
      });

      // ------------------------------------------ raw unique index beside a selector

      test("a unique INDEX no selector can name suppresses without adopting", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.parcel.create({
            data: { slug: "sitting", code: "SHARED", note: "ORIGINAL" },
          });
          await client.crate.create({ data: { id: "c1" } });
          await run.update("crate", junctionSkipAdoptSchema.crate, {
            where: { id: "c1" },
            data: {
              parcels: {
                createMany: {
                  data: [{ slug: "arriving", code: "SHARED", note: "new" }],
                  skipDuplicates: true,
                },
              },
            },
          });
          // The pre-existing index owner is untouched and, because no selector can
          // prove it is the requested row, it is not linked.
          await expect(
            client.parcel.findMany({ orderBy: { slug: "asc" } })
          ).resolves.toMatchObject([
            { slug: "sitting", code: "SHARED", note: "ORIGINAL" },
          ]);
          const joined = await client.parcel.findMany({
            where: { crates: { some: { id: "c1" } } },
          });
          expect(joined).toEqual([]);
        } finally {
          await dispose();
        }
      });

      // ----------------------------------- the suppress sub-shape (residual Package F)
      //
      // The full suppression matrix stays on the interactive legs; the compact batch
      // branch above pins root isolation without repeating every rollback-sensitive case.
      test("two nameable uniques: the conflicting member is suppressed and its siblings land", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          // THE WRONG-ROW DECOY, unchanged from the refusal this replaces. Two
          // pre-existing rows, one per constraint: A owns the isbn the payload spells, B
          // owns the code. A probe by EITHER unique names one of them, and the constraint
          // that would actually fire may name the other — which is why suppression NEVER
          // adopts. If the disposition is widened to "take the first spelled unique", the
          // operation joins the shelf to whichever row that probe found and the last two
          // assertions fail.
          const rowA = await client.book.create({
            data: { isbn: "i1", code: "cA", title: "A" },
          });
          const rowB = await client.book.create({
            data: { isbn: "iB", code: "c1", title: "B" },
          });
          await client.shelf.create({ data: { id: "s1" } });
          await run.update("shelf", junctionSkipAdoptSchema.shelf, {
            where: { id: "s1" },
            data: {
              books: {
                createMany: {
                  data: [
                    // Conflicts on `isbn` (row A) — suppressed, member and join both.
                    { isbn: "i1", code: "c1", title: "t" },
                    // Conflicts on nothing — lands, and is the sibling that proves the
                    // series continued past the suppressed member.
                    { isbn: "i9", code: "c9", title: "kept" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          // The suppressed target is ABSENT: the decoys are untouched and no third row
          // carries the payload's title.
          await expect(
            client.book.findMany({ orderBy: { isbn: "asc" } })
          ).resolves.toMatchObject([
            { id: rowA.id, isbn: "i1", code: "cA", title: "A" },
            { isbn: "i9", code: "c9", title: "kept" },
            { id: rowB.id, isbn: "iB", code: "c1", title: "B" },
          ]);
          // The suppressed member's JOIN row is absent and NEITHER decoy was adopted:
          // the only membership is the sibling that actually inserted.
          const linked = await client.book.findMany({
            where: { shelves: { some: { id: "s1" } } },
            orderBy: { isbn: "asc" },
          });
          expect(linked.map((row) => row.isbn)).toEqual(["i9"]);
        } finally {
          await dispose();
        }
      });

      test("an unnameable unique INDEX suppresses the duplicate and keeps the first row", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.stack.create({ data: { id: "k1" } });
          // NOT vacuous: `.index(["tag"], { unique: true })` is something an INSERT can
          // violate, and no `whereUnique` names it — so there is nothing to probe by and
          // nothing to drop the flag for either. The savepoint is what answers instead.
          await run.update("stack", junctionSkipAdoptSchema.stack, {
            where: { id: "k1" },
            data: {
              items: {
                createMany: {
                  data: [
                    { tag: "t", text: "one" },
                    { tag: "t", text: "two" },
                    { tag: "u", text: "three" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          const rows = await client.item.findMany({
            orderBy: { tag: "asc" },
          });
          expect(rows.map((row) => [row.tag, row.text])).toEqual([
            ["t", "one"],
            ["u", "three"],
          ]);
          const linked = await client.item.findMany({
            where: { stacks: { some: { id: "k1" } } },
            orderBy: { tag: "asc" },
          });
          expect(linked.map((row) => row.text)).toEqual(["one", "three"]);
        } finally {
          await dispose();
        }
      });

      test("a PRE-EXISTING unnameable row is neither rewritten nor linked", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          // THE WHOLE DIFFERENCE between suppress and adopt, in one case. On the adopt
          // route the pre-existing row is linked; here no probe can prove it is the row
          // the constraint fired on, so it is left alone AND left unlinked.
          const existing = await client.item.create({
            data: { tag: "t", text: "ORIGINAL" },
          });
          await client.stack.create({ data: { id: "k1" } });
          await run.update("stack", junctionSkipAdoptSchema.stack, {
            where: { id: "k1" },
            data: {
              items: {
                createMany: {
                  data: [{ tag: "t", text: "OVERWRITTEN" }],
                  skipDuplicates: true,
                },
              },
            },
          });
          await expect(
            client.item.findMany({ orderBy: { id: "asc" } })
          ).resolves.toMatchObject([{ id: existing.id, text: "ORIGINAL" }]);
          await expect(
            client.item.findMany({
              where: { stacks: { some: { id: "k1" } } },
            })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      });

      test("a compound unique with a NULL member has nothing to conflict on, so it writes", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          // NULL is distinct from NULL in a unique index, so the pre-existing row's
          // constraint does not fire and neither member is suppressed. The refusal this
          // replaces asserted `slice.findMany()` was EMPTY; the honest answer is that
          // both rows land and the original is untouched.
          const original = await client.slice.create({
            data: { family: "f", text: "ORIGINAL" },
          });
          await client.plate.create({ data: { id: "p1" } });
          await run.update("plate", junctionSkipAdoptSchema.plate, {
            where: { id: "p1" },
            data: {
              slices: {
                createMany: {
                  // `variant` absent → NULL: the compound constraint is not complete,
                  // so no probe names the row it would fire on.
                  data: [
                    { family: "f", text: "t" },
                    { family: "f", text: "u" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          await expect(
            client.slice.findUnique({ where: { id: original.id } })
          ).resolves.toMatchObject({ text: "ORIGINAL" });
          const linked = await client.slice.findMany({
            where: { plates: { some: { id: "p1" } } },
            orderBy: { text: "asc" },
          });
          expect(linked.map((row) => row.text)).toEqual(["t", "u"]);
        } finally {
          await dispose();
        }
      });

      test("a MIXED spelled/generated list is PARTITIONED: the spelled row keeps the leaf's skip-and-link contract", {
        timeout: 30_000,
      }, async () => {
        // Review M1: a spelled-key row's skip semantics must not depend on an
        // unrelated sibling. The spelled conflicting row is skipped AND STILL
        // LINKED (the leaf's pinned contract, junction-create-many-behavior);
        // only the generated row consults its own disposition (here: nothing
        // to conflict on, so it simply lands).
        const { client, run, dispose } = await setup();
        try {
          await client.item.create({
            data: { id: 100, tag: "taken", text: "ORIGINAL" },
          });
          await client.stack.create({ data: { id: "k1" } });
          await run.update("stack", junctionSkipAdoptSchema.stack, {
            where: { id: "k1" },
            data: {
              items: {
                createMany: {
                  data: [
                    // Spelled key, already taken — skipped, row untouched, LINKED.
                    { id: 100, tag: "x", text: "OVERWRITTEN" },
                    // Generated key, nothing to conflict on — lands.
                    { tag: "y", text: "fresh" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          await expect(
            client.item.findUnique({ where: { id: 100 } })
          ).resolves.toMatchObject({ tag: "taken", text: "ORIGINAL" });
          const linked = await client.item.findMany({
            where: { stacks: { some: { id: "k1" } } },
            orderBy: { tag: "asc" },
          });
          expect(linked.map((row) => row.text)).toEqual(["ORIGINAL", "fresh"]);
        } finally {
          await dispose();
        }
      });

      // ------------------------------------- the fatal side of the same member savepoint

      test("a conflict INSIDE the target subtree aborts the complete operation", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.gem.create({
            data: {
              tag: "seed",
              text: "SEED",
              facets: { create: [{ slug: "dup" }] },
            },
          });
          await client.vault.create({ data: { id: "v1" } });
          // The gem root INSERT does not conflict (`tag: "fresh"` is free); the FACET it
          // creates does. That conflict is not the annotated root's, so it escapes the
          // member savepoint and the whole operation rolls back — including the sibling
          // member that had already landed.
          await expect(
            run.update("vault", junctionSkipAdoptSchema.vault, {
              where: { id: "v1" },
              data: {
                gems: {
                  createMany: {
                    data: [
                      { tag: "sibling", text: "landed first" },
                      {
                        tag: "fresh",
                        text: "doomed",
                        facets: { create: [{ slug: "dup" }] },
                      },
                    ],
                    skipDuplicates: true,
                  },
                },
              },
            })
          ).rejects.toThrow(UNIQUE_VIOLATION);
          await expect(
            client.gem.findMany({ orderBy: { tag: "asc" } })
          ).resolves.toMatchObject([{ tag: "seed", text: "SEED" }]);
          await expect(
            client.gem.findMany({
              where: { vaults: { some: { id: "v1" } } },
            })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      });

      test("the same member's ROOT conflict is suppressed while its subtree stays intact", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.gem.create({
            data: { tag: "taken", text: "ORIGINAL" },
          });
          await client.vault.create({ data: { id: "v1" } });
          await run.update("vault", junctionSkipAdoptSchema.vault, {
            where: { id: "v1" },
            data: {
              gems: {
                createMany: {
                  data: [
                    // Root conflicts on the unnameable tag index: the gem, its facet and
                    // its join row all roll back together.
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
          await expect(
            client.gem.findMany({ orderBy: { tag: "asc" } })
          ).resolves.toMatchObject([
            { tag: "kept", text: "fresh" },
            { tag: "taken", text: "ORIGINAL" },
          ]);
          // The suppressed member's DESCENDANT is gone with it.
          await expect(
            client.facet.findMany({ orderBy: { slug: "asc" } })
          ).resolves.toMatchObject([{ slug: "real" }]);
          const linked = await client.gem.findMany({
            where: { vaults: { some: { id: "v1" } } },
          });
          expect(linked.map((row) => row.tag)).toEqual(["kept"]);
        } finally {
          await dispose();
        }
      });

      test("a NON-UNIQUE failure on the same member ROOT aborts the complete operation", {
        timeout: 30_000,
      }, async () => {
        // Review L3. The two witnesses above vary WHERE the failure happens (root vs
        // descendant) while holding its CLASS fixed at "unique". This one varies the
        // CLASS and holds the position at the ROOT — the position the savepoint
        // absorbs — so that "suppression means a root UNIQUE conflict" is measured
        // rather than inferred from the root/descendant split alone.
        //
        // `holderId` names a holder that does not exist, so the gem's own root INSERT
        // raises a FOREIGN KEY violation. `executeSkippableWrite` absorbs
        // `UNIQUE_CONSTRAINT` and nothing else, so the member savepoint re-raises,
        // the enclosing scope rolls back, and the SIBLING that already landed goes
        // with it.
        const { client, run, dispose } = await setup();
        try {
          await client.vault.create({ data: { id: "v1" } });
          await expect(
            run.update("vault", junctionSkipAdoptSchema.vault, {
              where: { id: "v1" },
              data: {
                gems: {
                  createMany: {
                    data: [
                      { tag: "sibling", text: "landed first" },
                      {
                        tag: "fresh",
                        text: "doomed",
                        holderId: "ghost",
                      },
                    ],
                    skipDuplicates: true,
                  },
                },
              },
            })
          ).rejects.toThrow(FOREIGN_KEY_VIOLATION);
          // Not absorbed as a skip: neither the failing member NOR the sibling that
          // preceded it survives, and no join row was written.
          await expect(client.gem.findMany({})).resolves.toEqual([]);
          await expect(
            client.gem.findMany({
              where: { vaults: { some: { id: "v1" } } },
            })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      });

      test("the same compound unique COMPLETELY spelled is absorbed", {
        timeout: 30_000,
      }, async () => {
        const { client, run, dispose } = await setup();
        try {
          await client.slice.create({
            data: { family: "f", variant: "v", text: "ORIGINAL" },
          });
          await client.plate.create({ data: { id: "p1" } });
          await run.update("plate", junctionSkipAdoptSchema.plate, {
            where: { id: "p1" },
            data: {
              slices: {
                createMany: {
                  data: [
                    { family: "f", variant: "v", text: "OVERWRITTEN" },
                    { family: "f", variant: "w", text: "fresh" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          });
          const rows = await client.slice.findMany({
            where: { plates: { some: { id: "p1" } } },
            orderBy: { variant: "asc" },
          });
          expect(rows.map((row) => [row.variant, row.text])).toEqual([
            ["v", "ORIGINAL"],
            ["w", "fresh"],
          ]);
        } finally {
          await dispose();
        }
      });
    }
  );
}
