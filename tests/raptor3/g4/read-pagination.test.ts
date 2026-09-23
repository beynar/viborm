/**
 * G4 C01 fixed witnesses — inventory family B paging, Q-P01…Q-P03.
 *
 * Contract sources: `cursor-pagination-behavior.ts` and
 * `cursor-order-normalization-boundaries.core.test.ts` (Q-P01),
 * `distinct-skip-window-behavior.ts` (Q-P02),
 * `nested-pagination-behavior.ts` (Q-P03).
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "./read-schema";
import { createWitnessWorld, expectRead, type WitnessWorld } from "./witness-world";

describe("G4 C01 paging vocabulary (Q-P01…Q-P03)", () => {
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

  it("Q-P01 shares cursor, take and skip semantics at the root", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      { orderBy: { id: "asc" }, cursor: { id: 2 }, take: 3, select: { id: true } },
      [{ id: 2 }, { id: 3 }, { id: 4 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        orderBy: { id: "asc" },
        cursor: { id: 2 },
        skip: 1,
        take: 2,
        select: { id: true },
      },
      [{ id: 3 }, { id: 4 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      { orderBy: { id: "asc" }, skip: 3, select: { id: true } },
      [{ id: 4 }, { id: 5 }]
    );
  });

  it("Q-P01 restores the logical order of a negative take", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      { orderBy: { id: "asc" }, take: -2, select: { id: true } },
      [{ id: 4 }, { id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        orderBy: { id: "asc" },
        cursor: { id: 4 },
        take: -3,
        select: { id: true },
      },
      [{ id: 2 }, { id: 3 }, { id: 4 }]
    );
  });

  it("Q-P02 removes duplicates before take and skip", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      {
        distinct: ["authorTenant"],
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 4 }, { id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        distinct: ["authorTenant", "authorHandle"],
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }, { id: 3 }, { id: 4 }, { id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      {
        distinct: ["authorTenant"],
        orderBy: { id: "asc" },
        skip: 1,
        take: 1,
        select: { id: true },
      },
      [{ id: 4 }]
    );
  });

  it("Q-P03 scopes a nested window to each parent", async () => {
    await expectRead(
      world,
      "author",
      "findMany",
      {
        orderBy: [{ tenant: "asc" }, { handle: "asc" }],
        select: {
          handle: true,
          posts: { orderBy: { views: "desc" }, take: 1, select: { id: true } },
        },
      },
      [
        { handle: "ada", posts: [{ id: 2 }] },
        { handle: "bob", posts: [{ id: 3 }] },
        { handle: "cy", posts: [] },
        { handle: "ada", posts: [{ id: 4 }] },
        { handle: "dee", posts: [] },
      ]
    );
  });

  it("Q-P03 windows a junction collection shared by two parents", async () => {
    // Tag 2 belongs to BOTH `acme/ada` and `acme/bob`. A window computed once
    // over the joined rows would give one of them the other's page; the window
    // is per parent.
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme" },
        orderBy: { handle: "asc" },
        select: {
          handle: true,
          tags: { orderBy: { id: "asc" }, take: 1, select: { id: true } },
        },
      },
      [
        { handle: "ada", tags: [{ id: 1 }] },
        { handle: "bob", tags: [{ id: 2 }] },
        { handle: "cy", tags: [] },
      ]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme" },
        orderBy: { handle: "asc" },
        select: {
          handle: true,
          tags: {
            orderBy: { id: "asc" },
            skip: 1,
            take: 1,
            select: { id: true },
          },
        },
      },
      [
        { handle: "ada", tags: [{ id: 2 }] },
        { handle: "bob", tags: [] },
        { handle: "cy", tags: [] },
      ]
    );
  });

  it("Q-P03 gives each parent its own where, skip, cursor and omit", async () => {
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme" },
        orderBy: { handle: "asc" },
        select: {
          handle: true,
          posts: {
            where: { views: { gte: 5 } },
            orderBy: { id: "asc" },
            skip: 1,
            select: { id: true },
          },
        },
      },
      [
        { handle: "ada", posts: [{ id: 2 }] },
        { handle: "bob", posts: [] },
        { handle: "cy", posts: [] },
      ]
    );
    await expectRead(
      world,
      "author",
      "findMany",
      {
        where: { tenant: "acme", handle: "ada" },
        select: {
          handle: true,
          posts: {
            orderBy: { id: "asc" },
            cursor: { id: 2 },
            take: 1,
            omit: { rating: true, authorTenant: true, authorHandle: true },
          },
        },
      },
      [
        {
          handle: "ada",
          posts: [{ id: 2, slug: "p-two", title: "Two", views: 20 }],
        },
      ]
    );
  });
});
