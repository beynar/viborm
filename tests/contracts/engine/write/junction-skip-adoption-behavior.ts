import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { afterAll, describe, expect, test } from "vitest";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";

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
 * skip leaf has none. Two sub-shapes are absorbed and the third stays refused:
 *
 *  - **vacuous** (`board`/`mark`): nothing to conflict on, so the flag is dropped.
 *  - **adopt** (`article`/`label`): each row spells exactly one nameable unique, so each
 *    row becomes a `connectOrCreate` item — probe, adopt or insert, join.
 *  - **refused** (`shelf`/`book`, `plate`/`slice`): a row spelling two nameable uniques, or
 *    a compound unique with a NULL member. No single probe names the row a conflict would
 *    fire on.
 *
 * The DIVERGENCE (`crate`/`parcel`) is deliberate and pinned: a conflict on a constraint no
 * selector can name — a `.index([…], { unique: true })` — now raises the typed unique
 * violation instead of skipping in silence. Never a wrong row; the thing it replaces was
 * silence, not correctness.
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
      labels: s.manyToMany(() => label).through("e68_article_label"),
    })
    .map("e68_articles");
  const label = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      note: s.string(),
      articles: s.manyToMany(() => article).through("e68_article_label"),
    })
    .map("e68_labels");
  // VACUOUS: a DB-generated key and NOTHING else to conflict on.
  const board = s
    .model({
      id: s.string().id(),
      marks: s.manyToMany(() => mark).through("e68_board_mark"),
    })
    .map("e68_boards");
  const mark = s
    .model({
      id: s.int().id().increment(),
      text: s.string(),
      boards: s.manyToMany(() => board).through("e68_board_mark"),
    })
    .map("e68_marks");
  // REFUSED: two nameable uniques, both spelled — no single probe names the skipped-on row.
  const shelf = s
    .model({
      id: s.string().id(),
      books: s.manyToMany(() => book).through("e68_book_shelf"),
    })
    .map("e68_shelves");
  const book = s
    .model({
      id: s.int().id().increment(),
      isbn: s.string().unique(),
      code: s.string().unique(),
      title: s.string(),
      shelves: s.manyToMany(() => shelf).through("e68_book_shelf"),
    })
    .map("e68_books");
  // REFUSED: the only nameable unique is COMPOUND with a nullable member the rows leave
  // absent. NULL is distinct from NULL in a unique index, so the constraint fires nothing
  // where the probe would find nothing — the two only agree by accident.
  const plate = s
    .model({
      id: s.string().id(),
      slices: s.manyToMany(() => slice).through("e68_plate_slice"),
    })
    .map("e68_plates");
  const slice = s
    .model({
      id: s.int().id().increment(),
      family: s.string(),
      variant: s.string().nullable(),
      text: s.string(),
      plates: s.manyToMany(() => plate).through("e68_plate_slice"),
    })
    .unique(["family", "variant"])
    .map("e68_slices");
  // DIVERGENCE: one nameable unique (`slug`, the probe) plus a unique INDEX on `code`,
  // which the database enforces and no `whereUnique` can spell.
  const crate = s
    .model({
      id: s.string().id(),
      parcels: s.manyToMany(() => parcel).through("e68_crate_parcel"),
    })
    .map("e68_crates");
  const parcel = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      code: s.string(),
      note: s.string(),
      crates: s.manyToMany(() => crate).through("e68_crate_parcel"),
    })
    .index(["code"], { unique: true, name: "e68_parcels_code_uq" })
    .map("e68_parcels");
  // REFUSED, and NOT vacuous: the only unique besides the generated key is an INDEX no
  // selector can name. There is something to conflict on and no probe that can find it.
  const stack = s
    .model({
      id: s.string().id(),
      items: s.manyToMany(() => item).through("e68_stack_item"),
    })
    .map("e68_stacks");
  const item = s
    .model({
      id: s.int().id().increment(),
      tag: s.string(),
      text: s.string(),
      stacks: s.manyToMany(() => stack).through("e68_stack_item"),
    })
    .index(["tag"], { unique: true, name: "e68_items_tag_uq" })
    .map("e68_items");
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

/** The measured refusal, verbatim (the part that names the reason). */
const SKIP_WITH_GENERATED_KEY =
  /a skipped row produces no identity for its join row/;
const UNIQUE_VIOLATION = /Unique constraint/;

/** The tables this schema owns, children first — dropped once on a shared live server so a
 *  re-run never asks `push(force)` to re-shape an index a live foreign key still needs. */
export const junctionSkipAdoptTables = [
  "e68_article_label",
  "e68_board_mark",
  "e68_book_shelf",
  "e68_plate_slice",
  "e68_crate_parcel",
  "e68_stack_item",
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
}

export function runJunctionSkipAdoptBehavior(options: {
  readonly name: string;
  /** Called ONCE per suite: the driver every test in it runs on. */
  readonly createDriver: () => AnyDriver;
  /** Live-server legs share a database — drop the tables before the single `push`. */
  readonly dropTablesFirst?: boolean;
  readonly register?: (label: string, body: () => void) => void;
}): void {
  const register = options.register ?? describe;
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
          await push(client, { force: true });
          shared = { client, run: makeRunner(driver), driver };
        }
        await reset(shared.client);
        // Disposal is the SUITE's, not the test's: one connection per suite, closed by the
        // caller's `afterAll`. A per-test dispose would reconnect on every case.
        return {
          client: shared.client,
          run: shared.run,
          dispose: async () => {},
        };
      };
      afterAll(async () => {
        await shared?.client.$disconnect();
        shared = undefined;
      });

      // ------------------------------------------------- the adopt sub-shape (b)

      test(
        "a PRE-EXISTING row is left untouched and still linked — the pinned skip semantics",
        { timeout: 30_000 },
        async () => {
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
        }
      );

      test(
        "a duplicate WITHIN the payload creates one row and links it once",
        { timeout: 30_000 },
        async () => {
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
            expect(await labelsOf(client, article.id)).toEqual([
              "dup",
              "other",
            ]);
          } finally {
            await dispose();
          }
        }
      );

      test(
        "under a CREATE root the fresh parent adopts and creates the same way",
        { timeout: 30_000 },
        async () => {
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
        }
      );

      test(
        "with nothing pre-existing every row is inserted and linked to its own new id",
        { timeout: 30_000 },
        async () => {
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
        }
      );

      // ----------------------------------------------- the vacuous sub-shape (a)

      test(
        "a target with nothing to conflict on ignores the flag and writes every row",
        { timeout: 30_000 },
        async () => {
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
        }
      );

      // --------------------------------------------------- the authorized divergence

      test(
        "a conflict on a unique INDEX no selector can name raises, and writes nothing",
        { timeout: 30_000 },
        async () => {
          const { client, run, dispose } = await setup();
          try {
            await client.parcel.create({
              data: { slug: "sitting", code: "SHARED", note: "ORIGINAL" },
            });
            await client.crate.create({ data: { id: "c1" } });
            // The probe is by `slug`, which finds nothing — so the arm INSERTs, and the
            // INSERT meets the unique index on `code`. Under the skip leaf this row would
            // have vanished silently and its join row would still have been written.
            await expect(
              run.update("crate", junctionSkipAdoptSchema.crate, {
                where: { id: "c1" },
                data: {
                  parcels: {
                    createMany: {
                      data: [{ slug: "arriving", code: "SHARED", note: "new" }],
                      skipDuplicates: true,
                    },
                  },
                },
              })
            ).rejects.toThrow(UNIQUE_VIOLATION);
            // Atomic: the pre-existing row is untouched and nothing new landed.
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
        }
      );

      // ------------------------------------------------------ what stays refused

      test(
        "two nameable uniques in one row stay refused, before any write",
        { timeout: 30_000 },
        async () => {
          const { client, run, dispose } = await setup();
          try {
            // THE WRONG-ROW DECOY. Two pre-existing rows, one per constraint: A owns the
            // isbn the payload spells, B owns the code. A probe by EITHER unique names one
            // of them, and the constraint that would actually fire may name the other —
            // that is the impossibility, and it is why no probe is chosen. If the guard is
            // widened to "take the first spelled unique", the operation joins the parent to
            // whichever row that probe found, and both assertions below fail.
            const rowA = await client.book.create({
              data: { isbn: "i1", code: "cA", title: "A" },
            });
            const rowB = await client.book.create({
              data: { isbn: "iB", code: "c1", title: "B" },
            });
            await client.shelf.create({ data: { id: "s1" } });
            await expect(
              run.update("shelf", junctionSkipAdoptSchema.shelf, {
                where: { id: "s1" },
                data: {
                  books: {
                    createMany: {
                      data: [{ isbn: "i1", code: "c1", title: "t" }],
                      skipDuplicates: true,
                    },
                  },
                },
              })
            ).rejects.toThrow(SKIP_WITH_GENERATED_KEY);
            // Nothing was written and NEITHER decoy was linked.
            await expect(
              client.book.findMany({ orderBy: { isbn: "asc" } })
            ).resolves.toMatchObject([
              { id: rowA.id, title: "A" },
              { id: rowB.id, title: "B" },
            ]);
            await expect(
              client.book.findMany({
                where: { shelves: { some: { id: "s1" } } },
              })
            ).resolves.toEqual([]);
          } finally {
            await dispose();
          }
        }
      );

      test(
        "a target whose only unique is an unnameable INDEX stays refused",
        { timeout: 30_000 },
        async () => {
          const { client, run, dispose } = await setup();
          try {
            await client.stack.create({ data: { id: "k1" } });
            // NOT vacuous: `.index(["tag"], { unique: true })` is something an INSERT can
            // violate, and no `whereUnique` names it — so there is nothing to probe by and
            // nothing to drop the flag for either.
            await expect(
              run.update("stack", junctionSkipAdoptSchema.stack, {
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
              })
            ).rejects.toThrow(SKIP_WITH_GENERATED_KEY);
            await expect(client.item.findMany()).resolves.toEqual([]);
          } finally {
            await dispose();
          }
        }
      );

      test(
        "a compound unique with a NULL member stays refused, before any write",
        { timeout: 30_000 },
        async () => {
          const { client, run, dispose } = await setup();
          try {
            await client.plate.create({ data: { id: "p1" } });
            await expect(
              run.update("plate", junctionSkipAdoptSchema.plate, {
                where: { id: "p1" },
                data: {
                  slices: {
                    createMany: {
                      // `variant` absent → NULL: the compound constraint is not complete,
                      // so no probe names the row it would fire on.
                      data: [{ family: "f", text: "t" }],
                      skipDuplicates: true,
                    },
                  },
                },
              })
            ).rejects.toThrow(SKIP_WITH_GENERATED_KEY);
            await expect(client.slice.findMany()).resolves.toEqual([]);
          } finally {
            await dispose();
          }
        }
      );

      test(
        "the same compound unique COMPLETELY spelled is absorbed",
        { timeout: 30_000 },
        async () => {
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
        }
      );
    }
  );
}
