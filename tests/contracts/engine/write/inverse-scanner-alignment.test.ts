import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { ValidationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { getInverseRelationMap } from "@schema/relation/types";
import { beforeAll, expect, expectTypeOf, test } from "vitest";

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

// =============================================================================
// THE TYPE TWINS (TH) — the same divergence, on the axis where it is OBSERVABLE
// =============================================================================

/**
 * TH — D5 aligned the two RUNTIME scanners and recorded a residual: the two TYPE
 * twins (`ExtractInverseFieldsRaw` in `schema/relation/types.ts` and
 * `ScannedInverseRelationMap` in `validation/relations/create.ts`) still applied the
 * name check as a REJECTION. The residual was recorded as harmless. It was not.
 *
 * The pair below is the divergent schema with the one property that makes the twins
 * observable through the public client: a **NON-NULLABLE** foreign key. `author.books`
 * above carries a nullable `authorId`, so nothing demands it either way; here `orgId` is
 * required, so whether the scan resolves the edge decides whether the CALLER must spell a
 * column the ENGINE owns.
 *
 * Measured at 620a171, before the alignment:
 * `Property 'orgId' is missing in type '{ id: number; handle: string; }' but required` —
 * a compile error on a call the runtime accepts and executes. The type demanded what the
 * parse had already made optional. The gap was in the UNSAFE direction for a caller: a
 * legal shape was unwritable.
 *
 * The `data` clause itself is unguarded against EXTRA keys (a measured estate-wide limit,
 * TS2589 — see `tests/client/contextual-typing-gate.test.ts`), so the twins can only ever
 * be seen through REQUIRED-ness. That is the axis these probes use.
 */
const org = s
  .model({
    id: s.int().id(),
    members: s.oneToMany(() => member).name("staff"),
  })
  .map("m8b_orgs");

const member = s
  .model({
    id: s.int().id(),
    handle: s.string(),
    orgId: s.int(),
    org: s
      .manyToOne(() => org)
      .fields("orgId")
      .references("id"),
  })
  .map("m8b_members");

/**
 * The multi-candidate control on the SAME observable axis: two competing
 * back-references, both names matched, and both foreign keys REQUIRED. This is
 * what the alignment must not break — the name still picks, so each relation omits
 * only its own column and leaves the sibling's demanded. (`editor`/`draft` above
 * cannot show it: both of its foreign keys are nullable, so nothing is demanded
 * either way.)
 */
const hub = s
  .model({
    id: s.int().id(),
    primaries: s.oneToMany(() => spoke).name("primary"),
    secondaries: s.oneToMany(() => spoke).name("secondary"),
  })
  .map("m8b_hubs");

const spoke = s
  .model({
    id: s.int().id(),
    primaryId: s.int(),
    secondaryId: s.int(),
    primary: s
      .manyToOne(() => hub)
      .fields("primaryId")
      .references("id")
      .name("primary"),
    secondary: s
      .manyToOne(() => hub)
      .fields("secondaryId")
      .references("id")
      .name("secondary"),
  })
  .map("m8b_spokes");

const schema = {
  author,
  book,
  scribe,
  work,
  editor,
  draft,
  org,
  member,
  hub,
  spoke,
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

// =============================================================================
// TH — THE TYPE TWINS NOW READ THE EDGE THE WAY THE RUNTIME DOES
// =============================================================================
//
// Contextual probes through the PUBLIC client, spelled exactly as a caller spells
// them. Nothing here is executed; the assertions live in the presence or absence
// of `@ts-expect-error`, and `pnpm test:types` is what enforces them (a directive
// that stops being an error is itself an error, TS2578 — so re-introducing the
// rejecting name check turns the type-check red on the two probes below that
// carry no directive).

/** The gap that was measured open: a nested `createMany` row on the divergent edge
 *  no longer demands the foreign key the engine derives. */
const _divergentCreateManyOmitsFk = () =>
  client.org.create({
    data: {
      id: 100,
      members: { createMany: { data: [{ id: 1000, handle: "h" }] } },
    },
  });

/** Its `create` sibling, through the other twin (`GetInverseRelationMap`). */
const _divergentCreateOmitsFk = () =>
  client.org.create({
    data: { id: 101, members: { create: { id: 1001, handle: "h" } } },
  });

/** The omission is PER KEY, not a collapse of the nested input: a required
 *  NON-foreign-key scalar is still demanded. Without this the two probes above
 *  would pass on a surface that had simply stopped requiring anything. */
const _divergentStillDemandsNonFk = () =>
  client.org.create({
    data: {
      id: 102,
      // @ts-expect-error - `handle` is a required scalar of `member`
      members: { createMany: { data: [{ id: 1002 }] } },
    },
  });

/** The half the alignment must PRESERVE: with two back-references competing, the
 *  name still picks, so each relation omits only ITS OWN foreign key. */
const _multiCandidateOmitsItsOwnFk = () =>
  client.hub.create({
    data: {
      id: 103,
      primaries: { createMany: { data: [{ id: 1003, secondaryId: 9 }] } },
    },
  });

/** …and leaves the SIBLING's demanded. A name check dropped outright (rather than
 *  demoted to a disambiguator) would omit both columns and this directive would go
 *  unused — which is how this file catches the over-correction. */
const _multiCandidateStillDemandsSibling = () =>
  client.hub.create({
    data: {
      id: 104,
      // @ts-expect-error - `secondaryId` belongs to the OTHER relation
      primaries: { createMany: { data: [{ id: 1004 }] } },
    },
  });

test("the type twins resolve the name-mismatched sole back-reference (probes compile)", () => {
  expectTypeOf(_divergentCreateManyOmitsFk).toBeFunction();
  expectTypeOf(_divergentCreateOmitsFk).toBeFunction();
  expectTypeOf(_divergentStillDemandsNonFk).toBeFunction();
  expectTypeOf(_multiCandidateOmitsItsOwnFk).toBeFunction();
  expectTypeOf(_multiCandidateStillDemandsSibling).toBeFunction();
});

test("the scan's DECLARED return type is what the scan returns", () => {
  // The second twin's own witness, and the honest scope of it. Measured: only
  // `ScannedInverseRelationMap` (the `createMany` path above) is visible through
  // the client — reverting THIS twin alone leaves every probe above green, because
  // `V.Omit<create, never>` and `V.Omit<create, ["orgId"]>` produce the same
  // required-key set. What it was still doing was lying about a shipped function:
  // `GetInverseRelationMap` annotates `getInverseRelationMap`'s return, the runtime
  // answered `["orgId"]` on this edge, and the type said `undefined` — which is why
  // the function ends in a cast. This pins the two together.
  const state = org["~"].state.relations.members["~"].state;
  const resolved = getInverseRelationMap(state, org);
  expect(resolved).toEqual(["orgId"]);
  expectTypeOf(resolved).not.toBeUndefined();
  expectTypeOf(resolved).toEqualTypeOf<["orgId"]>();

  // The multi-candidate half, same two levels: the name picks, and the type agrees.
  const primaries = hub["~"].state.relations.primaries["~"].state;
  const picked = getInverseRelationMap(primaries, hub);
  expect(picked).toEqual(["primaryId"]);
  expectTypeOf(picked).toEqualTypeOf<["primaryId"]>();
});

test("the engine still owns the foreign key an untyped caller cannot see", async () => {
  // The runtime witness the type probes cannot give: with the key omitted (the
  // spelling the aligned type now permits), the engine derives it from the row its
  // own INSERT made — through `create` and through `createMany` alike.
  await client.org.create({
    data: {
      id: 7,
      members: {
        create: { id: 70, handle: "a" },
        createMany: { data: [{ id: 71, handle: "b" }] },
      },
    },
  });
  await expect(
    client.member.findMany({ where: { orgId: 7 }, orderBy: { id: "asc" } })
  ).resolves.toMatchObject([
    { id: 70, orgId: 7 },
    { id: 71, orgId: 7 },
  ]);

  // And the refusal an UNTYPED caller still meets on the `create` arm: the parse
  // omits the column, so spelling it is an unknown key — unchanged by the type
  // work, which is what makes this alignment a type change and not a route change.
  const rejected = client.org.create({
    data: { id: 8, members: { create: { id: 80, handle: "c", orgId: 999 } } },
  });
  await expect(rejected).rejects.toBeInstanceOf(ValidationError);
  await expect(rejected).rejects.toThrow("Unknown key: orgId");
  await expect(client.org.findUnique({ where: { id: 8 } })).resolves.toBeNull();
});
