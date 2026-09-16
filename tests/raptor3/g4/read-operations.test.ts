/**
 * G4 C01 fixed witnesses — inventory family A, root read envelopes
 * OP-R01…OP-R09.
 *
 * Contract sources per row are named in `g3-prep-inventory.md` §A. Every
 * expected value below is hand-computed from the rows seeded with raw SQL in
 * `seedRelationWorld`; the shipped client is the differential oracle and the
 * candidate is the subject (see `witness-world.ts`).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  AUTHOR_TABLE,
  AUTHOR_TAG_TABLE,
  BOARD_POST_TABLE,
  BOARD_TABLE,
  BOARD_TAG_TABLE,
  POST_TABLE,
  PROFILE_TABLE,
  TAG_TABLE,
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
  tableColumns,
} from "./read-schema";
import {
  createWitnessWorld,
  expectRead,
  expectRefusal,
  rowsOf,
  type WitnessWorld,
} from "./witness-world";

describe("G4 C01 root read envelopes (OP-R01…OP-R09)", () => {
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

  it("pins the physical layout every witness in this family assumes", () => {
    assert.deepEqual(tableColumns(world.database), {
      [AUTHOR_TABLE]: [
        "tenant_key",
        "author_handle",
        "display_name",
        "author_rank",
        "author_score",
        "author_bio",
        "mentor_tenant_key",
        "mentor_handle",
      ],
      [POST_TABLE]: [
        "id",
        "post_slug",
        "post_title",
        "view_count",
        "post_rating",
        "author_tenant_key",
        "author_handle_key",
      ],
      [PROFILE_TABLE]: [
        "id",
        "headline_text",
        "owner_tenant_key",
        "owner_handle_key",
      ],
      [TAG_TABLE]: ["id", "tag_label", "tag_weight"],
      [AUTHOR_TAG_TABLE]: ["author_1", "author_2", "tagId"],
      [BOARD_TABLE]: ["id", "board_title"],
      [BOARD_POST_TABLE]: ["board", "item"],
      [BOARD_TAG_TABLE]: ["board", "item"],
    });
  });

  it("OP-R01 findUnique answers one row or null on a mapped compound key", async () => {
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "ada" } },
        select: { tenant: true, handle: true, name: true, rank: true },
      },
      { tenant: "acme", handle: "ada", name: "Ada", rank: 1 }
    );
    // The competing row shares the handle and must not be reachable.
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "beta", handle: "ada" } },
        select: { name: true },
      },
      { name: "Ada Beta" }
    );
    await expectRead(
      world,
      "author",
      "findUnique",
      {
        where: { tenant_handle: { tenant: "acme", handle: "absent" } },
        select: { name: true },
      },
      null
    );
  });

  it("OP-R01 extended unique where still requires a discriminator", async () => {
    await expectRead(
      world,
      "post",
      "findUnique",
      { where: { slug: "p-two", views: { gt: 5 } }, select: { title: true } },
      { title: "Two" }
    );
    await expectRead(
      world,
      "post",
      "findUnique",
      { where: { slug: "p-two", views: { gt: 100 } }, select: { title: true } },
      null
    );
    await expectRefusal(
      world,
      "post",
      "findUnique",
      { where: { views: { gt: 5 } }, select: { title: true } },
      { name: "ValidationError", message: /./ }
    );
  });

  it("OP-R02 findUniqueOrThrow turns absence into the established not-found error", async () => {
    await expectRead(
      world,
      "author",
      "findUniqueOrThrow",
      {
        where: { tenant_handle: { tenant: "acme", handle: "bob" } },
        select: { name: true },
      },
      { name: "Bob" }
    );
    const failure = await expectRefusal(
      world,
      "author",
      "findUniqueOrThrow",
      {
        where: { tenant_handle: { tenant: "acme", handle: "absent" } },
        select: { name: true },
      },
      {
        name: "NotFoundError",
        message: /^No author record found for findUniqueOrThrow$/,
      }
    );
    assert.equal(failure.constructorName, "NotFoundError");
  });

  it("OP-R03 findFirst returns the first ordered row or null", async () => {
    await expectRead(
      world,
      "author",
      "findFirst",
      {
        where: { tenant: "acme" },
        orderBy: { rank: "desc" },
        select: { handle: true, rank: true },
      },
      { handle: "cy", rank: 3 }
    );
    await expectRead(
      world,
      "author",
      "findFirst",
      {
        where: { tenant: "acme" },
        orderBy: { rank: "asc" },
        skip: 2,
        select: { handle: true },
      },
      { handle: "cy" }
    );
    await expectRead(
      world,
      "author",
      "findFirst",
      { where: { tenant: "absent" }, select: { handle: true } },
      null
    );
  });

  it("OP-R04 findFirstOrThrow refuses absence with the same identity", async () => {
    await expectRead(
      world,
      "author",
      "findFirstOrThrow",
      {
        where: { tenant: "beta" },
        orderBy: { rank: "asc" },
        select: { handle: true },
      },
      { handle: "ada" }
    );
    await expectRefusal(
      world,
      "author",
      "findFirstOrThrow",
      { where: { tenant: "absent" }, select: { handle: true } },
      {
        name: "NotFoundError",
        message: /^No author record found for findFirstOrThrow$/,
      }
    );
  });

  it("OP-R05 findMany filters, orders and windows before projection", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { views: { gte: 5 } },
        orderBy: [{ views: "desc" }, { id: "asc" }],
        skip: 1,
        take: 2,
        select: { slug: true, views: true },
      },
      [
        { slug: "p-two", views: 20 },
        { slug: "p-one", views: 10 },
      ]
    );
    const first = rowsOf(
      await world.candidate.execute("post", "findMany", {
        where: { views: { gte: 5 } },
        select: { slug: true },
      })
    );
    const second = rowsOf(
      await world.candidate.execute("post", "findMany", {
        where: { views: { gte: 5 } },
        select: { slug: true },
      })
    );
    assert.notEqual(first, second, "findMany must return a fresh array");
    assert.notEqual(first[0], second[0], "findMany must return fresh rows");
    assert.deepStrictEqual(first, second);
  });

  it("OP-R06 count returns a number and the selected scalar-count object", async () => {
    await expectRead(
      world,
      "post",
      "count",
      { where: { views: { gte: 5 } } },
      4
    );
    await expectRead(
      world,
      "post",
      "count",
      { where: { views: { gte: 5 } }, select: { _all: true, rating: true } },
      { _all: 4, rating: 3 }
    );
    await expectRead(
      world,
      "post",
      "count",
      { where: { views: { gte: 5 } }, orderBy: { id: "asc" }, skip: 1, take: 2 },
      2
    );
  });

  it("OP-R07 exist returns a boolean without publishing a row shape", async () => {
    await expectRead(world, "post", "exist", { where: { views: { gt: 25 } } }, true);
    await expectRead(
      world,
      "post",
      "exist",
      { where: { views: { gt: 1000 } } },
      false
    );
  });

  it("OP-R08 aggregate shapes _count, _avg, _sum, _min and _max", async () => {
    await expectRead(
      world,
      "post",
      "aggregate",
      {
        where: { views: { gte: 5 } },
        _count: true,
        _sum: { views: true },
        _min: { views: true },
        _max: { views: true },
        _avg: { views: true },
      },
      {
        _count: 4,
        _sum: { views: 65 },
        _min: { views: 5 },
        _max: { views: 30 },
        _avg: { views: 16.25 },
      }
    );
  });

  it("OP-R09 groupBy publishes grouped values with having and group order", async () => {
    await expectRead(
      world,
      "post",
      "groupBy",
      {
        by: ["authorTenant"],
        where: { views: { gte: 0 } },
        _count: { _all: true },
        _sum: { views: true },
        having: { views: { _sum: { gt: 25 } } },
        orderBy: { authorTenant: "asc" },
      },
      [
        { authorTenant: "acme", _count: { _all: 3 }, _sum: { views: 35 } },
        { authorTenant: "beta", _count: { _all: 1 }, _sum: { views: 30 } },
      ]
    );
  });
});
