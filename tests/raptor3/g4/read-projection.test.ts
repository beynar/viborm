/**
 * G4 C01 fixed witnesses — inventory family B shapes, Q-S01…Q-S03.
 *
 * Contract sources: `select-include-result.test.ts` and
 * `default-omit-extension.test.ts` (Q-S01),
 * `relation-read-aggregate-behavior.ts` / `select-builder-boundaries.core.test.ts`
 * (Q-S02), `polymorphic-result-parser.core.test.ts` and
 * `polymorphic-collection-read-behavior.ts` (Q-S03).
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  omitWorldSchema,
  relationWorldSchema,
  seedJunctions,
  seedLedgerWorld,
  seedRelationWorld,
} from "./read-schema";
import {
  createWitnessWorld,
  expectRead,
  expectRefusal,
  type WitnessWorld,
} from "./witness-world";

describe("G4 C01 projection shapes (Q-S01…Q-S03)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(relationWorldSchema(), {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  it("Q-S01 keeps select and include shapes distinct and mutually exclusive", async () => {
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "ada" } },
        select: { handle: true, posts: { orderBy: { id: "asc" }, select: { id: true } } },
      },
      { handle: "ada", posts: [{ id: 1 }, { id: 2 }] }
    );
    await expectRead(
      world,
      "post",
      "findUnique",
      {
        where: { id: 3 },
        include: { author: { select: { handle: true } } },
      },
      {
        id: 3,
        slug: "p-three",
        title: "Three",
        views: 5,
        rating: null,
        authorTenant: "acme",
        authorHandle: "bob",
        author: { handle: "bob" },
      }
    );
    await expectRefusal(
      world,
      "post",
      "findUnique",
      { where: { id: 3 }, select: { id: true }, include: { author: true } },
      { name: "ValidationError", message: /./ }
    );
  });

  it("Q-S01 projects both to-one orientations, a junction and a self-relation", async () => {
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "bob" } },
        select: {
          handle: true,
          // parent-held reference: the profile row carries the key
          profile: { select: { headline: true } },
          // junction membership
          tags: { orderBy: { id: "asc" }, select: { label: true } },
          // self-relation, both directions
          mentor: { select: { handle: true } },
          mentees: { select: { handle: true } },
        },
      },
      {
        handle: "bob",
        profile: { headline: "Bob builds" },
        tags: [{ label: "beta" }],
        mentor: { handle: "ada" },
        mentees: [],
      }
    );
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "ada" } },
        select: {
          handle: true,
          mentees: { orderBy: { handle: "asc" }, select: { handle: true } },
        },
      },
      { handle: "ada", mentees: [{ handle: "bob" }, { handle: "cy" }] }
    );
  });

  it("Q-S02 answers _count: true and per-collection filtered counts", async () => {
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "ada" } },
        select: { handle: true, _count: true },
      },
      // `_count: true` counts COLLECTIONS only; the to-one `profile` slot is
      // not a countable member.
      { handle: "ada", _count: { posts: 2, tags: 2, mentees: 2 } }
    );
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "ada" } },
        select: {
          handle: true,
          _count: { select: { posts: { where: { views: { gt: 15 } } } } },
        },
      },
      { handle: "ada", _count: { posts: 1 } }
    );
  });

  it("Q-S03 gives each variant arm its own node, order and cardinality", async () => {
    await expectRead(
      world,
      "board",
      "findUnique",
      {
        where: { id: 1 },
        select: {
          id: true,
          items: {
            variants: {
              post: { orderBy: { id: "desc" }, select: { id: true } },
              tag: { select: { label: true } },
            },
          },
        },
      },
      {
        id: 1,
        items: [
          { type: "post", data: { id: 2 } },
          { type: "post", data: { id: 1 } },
          { type: "tag", data: { label: "alpha" } },
        ],
      }
    );
    await expectRead(
      world,
      "board",
      "findUnique",
      {
        where: { id: 1 },
        select: { id: true, items: { only: ["tag"], variants: { tag: { select: { label: true } } } } },
      },
      { id: 1, items: [{ type: "tag", data: { label: "alpha" } }] }
    );
    await expectRead(
      world,
      "board",
      "findUnique",
      { where: { id: 1 }, select: { id: true, items: { only: [] } } },
      { id: 1, items: [] }
    );
  });

  it("Q-S01 stitches a collection while the mapped compound key is unselected", async () => {
    // The parent identity the stitch needs (`tenant`/`handle` → `tenant_key`/
    // `author_handle`) is not in the projection. It must still be prepared and
    // used, and it must not leak back into the published row.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme" },
        orderBy: { handle: "asc" },
        select: {
          name: true,
          posts: { orderBy: { id: "asc" }, select: { id: true } },
        },
      },
      [
        { name: "Ada", posts: [{ id: 1 }, { id: 2 }] },
        { name: "Bob", posts: [{ id: 3 }] },
        { name: "Cy", posts: [] },
      ]
    );
  });

  it("Q-S03 refuses an unknown variant arm", async () => {
    await expectRefusal(
      world,
      "board",
      "findUnique",
      {
        where: { id: 1 },
        select: { id: true, items: { variants: { absent: { select: { id: true } } } } },
      },
      { name: "ValidationError", message: /./ }
    );
  });
});

describe("G4 C01 schema default omit (Q-S01)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(omitWorldSchema(), {
      seed: seedLedgerWorld,
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  it("Q-S01 hides a schema-omitted field from every public projection", async () => {
    await expectRead(
      world,
      "ledger",
      "findUnique",
      { where: { id: 1 } },
      { id: 1, label: "first", note: "note one" }
    );
    await expectRead(
      world,
      "ledger",
      "findMany",
      { orderBy: { id: "asc" }, select: { id: true, note: true } },
      [
        { id: 1, note: "note one" },
        { id: 2, note: null },
      ]
    );
    await expectRead(
      world,
      "ledger",
      "findUnique",
      { where: { id: 1 }, omit: { note: true } },
      { id: 1, label: "first" }
    );
    // A schema omit is a projection default, not a selectable field: asking
    // for it by name is refused rather than silently honoured.
    await expectRefusal(
      world,
      "ledger",
      "findUnique",
      { where: { id: 1 }, select: { secret: true } },
      { name: "ValidationError", message: /Unknown key: secret/ }
    );
  });
});
