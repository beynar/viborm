import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { ValidationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { beforeAll, expect, test } from "vitest";

/**
 * M8(b) — **the two inverse scanners must answer the same question the same way.**
 *
 * Two independent scanners walk the target model looking for the to-one back-reference
 * that carries a child-held relation's foreign key:
 *
 *   · `getInverseRelationMap` (`schema/relation/types.ts`) decides which columns the
 *     PARSE omits from a nested `create` — the user must not spell a FK the engine owns;
 *   · `findInverseRelationState` (`query-engine/builders/correlation-utils.ts`) decides
 *     which columns the ENGINE resolves — the read path's correlation and the
 *     nested-write FK direction both go through it.
 *
 * They disagreed on ONE axis: what `.name()` means when the SOLE back-reference does not
 * echo it. The schema scanner treated a name mismatch as a REJECTION (returning
 * undefined, so the parse omitted nothing); the engine treated the name as a
 * DISAMBIGUATOR consulted only when several back-references compete, so it resolved the
 * edge anyway. Measured at 330d43c on the schema below: the parse ADMITTED a spelled
 * `authorId`, and `emitRecord`'s `{ ...scalarData, ...inject }` then OVERWROTE it — a
 * user-supplied identity discarded with no diagnostic.
 *
 * The scanners are aligned on the ENGINE's reading, because the engine's is the one two
 * live callers depend on for a schema the validator accepts (see the file's second half):
 * a sole back-reference IS the edge whatever either side spelled. So the parse now omits
 * `authorId` and refuses to be told it — a typed `ValidationError` where a silent
 * overwrite used to be.
 */

// =============================================================================
// THE DIVERGENT SCHEMA — source relation named, sole back-reference not
// =============================================================================

/**
 * `author.books` carries `.name("writer")`; `book.author`, the only relation on `book`
 * pointing back at `author`, carries no name. Nothing in `schema/validation` objects:
 * `relationHasInverse` (R003/R004) pairs relations by TYPE, and `relationNameUnique`
 * (R007) only asks for `.name()` when SEVERAL relations run between the same two models.
 * A one-sided `.name()` on a single pair is a legal, ordinary schema.
 */
const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    books: s.oneToMany(() => book).name("writer"),
  })
  .map("m8b_authors");

const book = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("m8b_books");

// =============================================================================
// THE CONTROL SCHEMAS — matched names, and a genuine multi-candidate ambiguity
// =============================================================================

/** Both sides spell `.name("penned")`: the axis that never diverged. */
const scribe = s
  .model({
    id: s.int().id(),
    name: s.string(),
    works: s.oneToMany(() => work).name("penned"),
  })
  .map("m8b_scribes");

const work = s
  .model({
    id: s.int().id(),
    title: s.string(),
    scribeId: s.int().nullable(),
    scribe: s
      .manyToOne(() => scribe)
      .fields("scribeId")
      .references("id")
      .optional()
      .name("penned"),
  })
  .map("m8b_works");

/**
 * TWO back-references compete, so `.name()` is doing the job it exists for. This is the
 * half of the rule the alignment must PRESERVE: the name still picks which foreign key
 * belongs to which relation, and picking the wrong one would omit the wrong column.
 */
const editor = s
  .model({
    id: s.int().id(),
    name: s.string(),
    drafted: s.oneToMany(() => draft).name("drafter"),
    reviewed: s.oneToMany(() => draft).name("reviewer"),
  })
  .map("m8b_editors");

const draft = s
  .model({
    id: s.int().id(),
    title: s.string(),
    drafterId: s.int().nullable(),
    reviewerId: s.int().nullable(),
    drafter: s
      .manyToOne(() => editor)
      .fields("drafterId")
      .references("id")
      .optional()
      .name("drafter"),
    reviewer: s
      .manyToOne(() => editor)
      .fields("reviewerId")
      .references("id")
      .optional()
      .name("reviewer"),
  })
  .map("m8b_drafts");

const schema = {
  author,
  book,
  scribe,
  work,
  editor,
  draft,
};

const client = createClient({
  schema,
  driver: new PGliteDriver({ client: new PGlite() }),
});

beforeAll(async () => {
  await push(client, { force: true });
});

// =============================================================================
// THE ALIGNMENT
// =============================================================================

test("the parse refuses a spelled child FK on the name-mismatched edge", async () => {
  // Measured at 330d43c: this call SUCCEEDED, wrote `authorId = 1`, and dropped the 999
  // the caller wrote. The value never reached a statement and nothing said so.
  const rejected = client.author.create({
    data: {
      id: 1,
      name: "a",
      books: { create: { id: 10, title: "t", authorId: 999 } },
    },
  });
  await expect(rejected).rejects.toBeInstanceOf(ValidationError);
  await expect(rejected).rejects.toThrow("Unknown key: authorId");

  // The b2 state witness: refused at the parse boundary means refused whole. Neither
  // row exists, so there is no row carrying a silently-substituted identity.
  await expect(
    client.author.findUnique({ where: { id: 1 } })
  ).resolves.toBeNull();
  await expect(client.book.findMany()).resolves.toEqual([]);
});

test("the engine still resolves the name-mismatched edge it always resolved", async () => {
  // The other half of the alignment, and the reason it went in THIS direction: the
  // engine's scanner was never wrong about which edge this is. The accepted spelling
  // (FK omitted, engine-owned) writes the child against the fresh parent's id.
  await client.author.create({
    data: { id: 2, name: "b", books: { create: { id: 20, title: "t" } } },
  });
  await expect(
    client.book.findUnique({ where: { id: 20 } })
  ).resolves.toMatchObject({ authorId: 2 });

  // And the READ caller of the same scanner — `buildCorrelation`, which has no parse
  // boundary in front of it — still correlates the relation on this schema.
  await expect(
    client.author.findUnique({ where: { id: 2 }, include: { books: true } })
  ).resolves.toMatchObject({ books: [{ id: 20, authorId: 2 }] });
});

test("a matched-name edge is unchanged by the alignment", async () => {
  await expect(
    client.scribe.create({
      data: {
        id: 3,
        name: "c",
        works: { create: { id: 30, title: "t", scribeId: 999 } },
      },
    })
  ).rejects.toThrow("Unknown key: scribeId");

  await client.scribe.create({
    data: { id: 4, name: "d", works: { create: { id: 40, title: "t" } } },
  });
  await expect(
    client.work.findUnique({ where: { id: 40 } })
  ).resolves.toMatchObject({ scribeId: 4 });
});

test("with several back-references the name still picks the foreign key", async () => {
  // `drafted` owns `drafterId` and `reviewed` owns `reviewerId`. If the alignment had
  // dropped the name check outright (rather than demoting it to a disambiguator), the
  // scanner would answer with whichever candidate it met first and each relation would
  // omit — and inject — the wrong column.
  await client.editor.create({
    data: {
      id: 5,
      name: "e",
      drafted: { create: { id: 50, title: "d" } },
      reviewed: { create: { id: 51, title: "r" } },
    },
  });
  await expect(
    client.draft.findUnique({ where: { id: 50 } })
  ).resolves.toMatchObject({ drafterId: 5, reviewerId: null });
  await expect(
    client.draft.findUnique({ where: { id: 51 } })
  ).resolves.toMatchObject({ drafterId: null, reviewerId: 5 });

  // Each relation still refuses only ITS own foreign key — the disambiguation is
  // per-relation, not a blanket omission of every back-reference column.
  await expect(
    client.editor.create({
      data: {
        id: 6,
        name: "f",
        drafted: { create: { id: 60, title: "d", drafterId: 999 } },
      },
    })
  ).rejects.toThrow("Unknown key: drafterId");
});
