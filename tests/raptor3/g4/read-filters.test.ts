/**
 * G4 C01 fixed witnesses — inventory family B predicates, Q-W01…Q-W10.
 *
 * Contract sources: `nested-not-filter.test.ts` and `operand-callback-sql.core.test.ts`
 * (Q-W01), `extended-where-unique.test.ts` / `cursor-pagination-sql.core.test.ts`
 * (Q-W02), `query-builder-coverage-boundaries.core.test.ts` and
 * `field-reference-behavior.ts` (Q-W03, RF-04), `like-escape-behavior.ts`
 * (Q-W04), `list-json-filter-behavior.ts` (Q-W05/Q-W06),
 * `to-one-filter-shorthand.test.ts` (Q-W08),
 * `query-relation-coverage-boundaries.core.test.ts` (Q-W09) and
 * `polymorphic-read-sql.core.test.ts` (Q-W10).
 */
import { DbNull } from "@schema";
import { afterEach, beforeEach, describe, it } from "vitest";
import { codecWorldSchema, SPECIMENS } from "./codec-schema";
import {
  AUTHOR_TABLE,
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "./read-schema";
import {
  createWitnessWorld,
  expectRead,
  expectRefusal,
  type WitnessWorld,
} from "./witness-world";

interface FieldContext {
  readonly fields: Record<string, unknown>;
}

describe("G4 C01 predicate vocabulary (Q-W01…Q-W10)", () => {
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

  it("Q-W01 composes AND, OR and NOT recursively", async () => {
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: {
          AND: [
            { tenant: "acme" },
            { OR: [{ rank: 1 }, { rank: 3 }] },
            { NOT: { handle: "ada" } },
          ],
        },
        orderBy: { handle: "asc" },
        select: { handle: true },
      },
      [{ handle: "cy" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { NOT: { OR: [{ tenant: "beta" }, { rank: { gte: 3 } }] } },
        orderBy: { handle: "asc" },
        select: { handle: true },
      },
      [{ handle: "ada" }, { handle: "bob" }]
    );
  });

  it("Q-W01 rebinds the field-reference scope inside a nested relation predicate", async () => {
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { posts: { some: { views: { gt: 15 } } } },
        orderBy: [{ tenant: "asc" }, { handle: "asc" }],
        select: { tenant: true, handle: true },
      },
      [
        { tenant: "acme", handle: "ada" },
        { tenant: "beta", handle: "ada" },
      ]
    );
    // Inside `posts`, `ctx.fields` names POST's fields, not the author's.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: {
          posts: {
            some: { views: { gt: (ctx: FieldContext) => ctx.fields.id } },
          },
        },
        orderBy: [{ tenant: "asc" }, { handle: "asc" }],
        select: { tenant: true, handle: true },
      },
      [
        { tenant: "acme", handle: "ada" },
        { tenant: "acme", handle: "bob" },
        { tenant: "beta", handle: "ada" },
      ]
    );
  });

  it("Q-W02 keeps a cursor strictly unique while extended where stays filtered", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      {
        orderBy: { id: "asc" },
        cursor: { slug: "p-two" },
        take: 2,
        select: { id: true },
      },
      [{ id: 2 }, { id: 3 }]
    );
    await expectRefusal(
      world,
      "post",
      "findMany",
      { orderBy: { id: "asc" }, cursor: { views: 10 }, take: 1 },
      { name: "ValidationError", message: /./ }
    );
  });

  it("Q-W03 answers equals, in, notIn, ranges, nested not and field references", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      { where: { views: 10 }, select: { id: true } },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { views: { in: [10, 30] } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 4 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { views: { notIn: [10, 30] } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 2 }, { id: 3 }, { id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { views: { gte: 5, lt: 30 } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 2 }, { id: 3 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { views: { not: { in: [10, 30] } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 2 }, { id: 3 }, { id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { views: { gt: (ctx: FieldContext) => ctx.fields.id } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    );
    // `notIn` over a nullable column never admits the SQL NULL row.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { score: { notIn: [4.5] } },
        orderBy: [{ tenant: "asc" }, { handle: "asc" }],
        select: { tenant: true, handle: true },
      },
      [
        { tenant: "acme", handle: "cy" },
        { tenant: "beta", handle: "ada" },
        { tenant: "beta", handle: "dee" },
      ]
    );
  });

  it("Q-W04 escapes LIKE literals and honours the insensitive mode", async () => {
    world.database.exec(`
      INSERT INTO ${AUTHOR_TABLE}
        (tenant_key, author_handle, display_name, author_rank, author_score, author_bio, mentor_tenant_key, mentor_handle)
      VALUES
        ('mark','pct','100% Ada',9,NULL,NULL,NULL,NULL),
        ('mark','und','user_name',9,NULL,NULL,NULL,NULL),
        ('mark','esc','back\\slash',9,NULL,NULL,NULL,NULL),
        ('mark','up','ORGANIC Ada',9,NULL,NULL,NULL,NULL);
    `);
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "%" } },
        orderBy: { handle: "asc" },
        select: { handle: true },
      },
      [{ handle: "pct" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "_" } },
        orderBy: { handle: "asc" },
        select: { handle: true },
      },
      [{ handle: "und" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { startsWith: "100%" } },
        select: { handle: true },
      },
      [{ handle: "pct" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { endsWith: "_name" } },
        select: { handle: true },
      },
      [{ handle: "und" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "\\" } },
        select: { handle: true },
      },
      [{ handle: "esc" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "ORGANIC", mode: "insensitive" } },
        select: { handle: true },
      },
      [{ handle: "up" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "organic", mode: "default" } },
        select: { handle: true },
      },
      []
    );
  });

  it("Q-W04 folds only ASCII under the insensitive mode", async () => {
    world.database.exec(`
      INSERT INTO ${AUTHOR_TABLE}
        (tenant_key, author_handle, display_name, author_rank, author_score, author_bio, mentor_tenant_key, mentor_handle)
      VALUES ('mark','ecole','École Ada',9,NULL,NULL,NULL,NULL);
    `);
    // SQLite's LIKE folds ASCII and nothing else, so the lower-case non-ASCII
    // form of the very same word finds nothing. The boundary is pinned so a
    // candidate cannot move it in either direction unnoticed.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "école", mode: "insensitive" } },
        select: { handle: true },
      },
      []
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { name: { contains: "École", mode: "insensitive" } },
        select: { handle: true },
      },
      [{ handle: "ecole" }]
    );
    // The ASCII part of the same value still folds.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: {
          tenant: "mark",
          name: { contains: "ADA", mode: "insensitive" },
        },
        select: { handle: true },
      },
      [{ handle: "ecole" }]
    );
  });

  it("Q-W03 partitions a nullable column at the NULL itself", async () => {
    // `bio` carries two SQL NULLs beside three values. `null` selects exactly
    // the NULLs and `not: null` exactly the others: neither side may admit a
    // row from the other, and the two must cover the world.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { bio: null },
        orderBy: [{ tenant: "asc" }, { handle: "asc" }],
        select: { tenant: true, handle: true },
      },
      [
        { tenant: "acme", handle: "bob" },
        { tenant: "beta", handle: "ada" },
      ]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { bio: { not: null } },
        orderBy: [{ tenant: "asc" }, { handle: "asc" }],
        select: { tenant: true, handle: true },
      },
      [
        { tenant: "acme", handle: "ada" },
        { tenant: "acme", handle: "cy" },
        { tenant: "beta", handle: "dee" },
      ]
    );
  });

  it("Q-W08 answers to-one shorthand, is and isNot including real nullability", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { author: { tenant: "acme", handle: "ada" } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 2 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      { where: { author: { is: null } }, select: { id: true } },
      [{ id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { author: { isNot: null } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { author: { is: { tenant: "beta" } } },
        select: { id: true },
      },
      [{ id: 4 }]
    );
  });

  it("Q-W09 answers independent some, every and none quantifiers", async () => {
    const handles = (where: unknown) => ({
      where,
      orderBy: [{ tenant: "asc" }, { handle: "asc" }],
      select: { tenant: true, handle: true },
    });
    await expectRead(
      world,
      "author",
      "findMany",
      handles({ posts: { some: { views: { gt: 15 } } } }),
      [
        { tenant: "acme", handle: "ada" },
        { tenant: "beta", handle: "ada" },
      ]
    );
    // `every` is vacuously true for an author with no posts at all.
    await expectRead(
      world,
      "author",
      "findMany",
      handles({ posts: { every: { views: { gte: 10 } } } }),
      [
        { tenant: "acme", handle: "ada" },
        { tenant: "acme", handle: "cy" },
        { tenant: "beta", handle: "ada" },
        { tenant: "beta", handle: "dee" },
      ]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      handles({ posts: { none: { views: { gt: 15 } } } }),
      [
        { tenant: "acme", handle: "bob" },
        { tenant: "acme", handle: "cy" },
        { tenant: "beta", handle: "dee" },
      ]
    );
    // The junction collection answers the same three quantifiers.
    await expectRead(
      world,
      "author",
      "findMany",
      handles({ tags: { some: { label: "alpha" } } }),
      [{ tenant: "acme", handle: "ada" }]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      handles({ tags: { none: {} } }),
      [
        { tenant: "acme", handle: "cy" },
        { tenant: "beta", handle: "dee" },
      ]
    );
  });

  it("Q-W10 answers tagged variant collection quantifiers", async () => {
    await expectRead(
      world,
      "board",
      "findMany",
      {
        where: { items: { some: { type: "post", is: { views: { gt: 15 } } } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "board",
      "findMany",
      {
        where: { items: { some: { type: "post", is: { views: { gt: 99 } } } } },
        select: { id: true },
      },
      []
    );
    await expectRead(
      world,
      "board",
      "findMany",
      {
        where: { items: { none: { type: "tag" } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 2 }]
    );
    await expectRead(
      world,
      "board",
      "findMany",
      {
        where: { items: { every: { type: "post", is: { views: { gt: 5 } } } } },
        select: { id: true },
      },
      [{ id: 2 }]
    );
  });
});

describe("G4 C01 container predicate vocabulary (Q-W05, Q-W06)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(codecWorldSchema());
    for (const specimen of SPECIMENS) {
      await world.shipped.specimen?.create?.({
        data: { ...specimen, document: specimen.document ?? DbNull },
      });
    }
    world.reset();
  });

  afterEach(async () => {
    await world?.close();
  });

  it("Q-W05 keeps scalar membership and list containment distinct", async () => {
    // `in` asks about the SCALAR `count`; `has` asks about the LIST `counts`.
    await expectRead(
      world,
      "specimen",
      "findMany",
      { where: { count: { in: [7, 11] } }, orderBy: { id: "asc" }, select: { id: true } },
      [{ id: 1 }, { id: 2 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      { where: { counts: { has: 5 } }, select: { id: true } },
      [{ id: 2 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      { where: { counts: { hasEvery: [4, 5] } }, select: { id: true } },
      [{ id: 2 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { counts: { isEmpty: true } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 3 }]
    );
  });

  it("Q-W05 refuses a list container on a scalar column", async () => {
    // Its own cell: the containment rows above are red against the frozen
    // candidate, and a refusal witness parked behind them would never run.
    // Both engines are asked — the earlier one-sided version observed only the
    // shipped engine and would not have noticed the candidate changing.
    await expectRefusal(
      world,
      "specimen",
      "findMany",
      { where: { count: { has: 7 } } },
      { name: "ValidationError", message: /has/ }
    );
  });

  it("Q-W06 answers JSON path, comparison and nested not predicates", async () => {
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { path: ["level"], equals: 9 } },
        select: { id: true },
      },
      [{ id: 2 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { path: ["nested", "flag"], equals: null } },
        select: { id: true },
      },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { not: { equals: { theme: "light", level: 9 } } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { equals: { theme: "light", level: 9 } } },
        select: { id: true },
      },
      [{ id: 2 }]
    );
  });
});
