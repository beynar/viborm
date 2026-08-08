import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * E5-U4 — **the `deferArmLegality` contract, after the envelope moved (E5-U3).**
 *
 * The move's whole safety argument is that the envelope schema reads the ARMS' object-
 * ness and NOTHING INSIDE THEM. This file is the check on that argument, and it starts
 * by naming what the contract actually is — measured, not assumed:
 *
 *  · The deferral is **one-directional**. `UpsertOperation` builds its UPDATE arm with
 *    `deferArmLegality: true`, so `UpdateOperation` skips its whole-args parse and its
 *    three legality analyses and hands them back as `assertArmLegality()`, run only on
 *    the taken found branch. The CREATE arm is built with no such option, so its
 *    payload is validated at construction whether or not it is taken. The asymmetry is
 *    pinned below rather than left to be discovered.
 *  · The deferral covers the ANALYSES, not the arm's shape. An unknown key or a wrong
 *    scalar type in the untaken update arm still rejects — measured at 00cca59 — because
 *    `UpsertOperation` separately parses each arm's scalar half. What is deferred is the
 *    whole-args `args.update` parse plus the primary-key-arithmetic portability check,
 *    the relation-key legality walk (CLASS IV) and the `updateMany`-carries-relations
 *    walk (CLASS V).
 *
 * CLASS IV is already pinned, on the create-taken direction, by
 * `tests/query-engine/relation-key-update-legality.test.ts` ("does not validate an
 * untaken top-level upsert update branch"). This file extends rather than repeats it:
 * CLASS V, which that test does not reach, plus the create-arm asymmetry.
 */
const untakenArmSchema = (() => {
  const writer = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      label: s.string().default("x"),
      books: s.oneToMany(() => book),
    })
    .map("e5u4_writers");
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      writerId: s.string(),
      writer: s
        .manyToOne(() => writer)
        .fields("writerId")
        .references("id"),
      pages: s.oneToMany(() => page),
    })
    .map("e5u4_books");
  const page = s
    .model({
      id: s.string().id(),
      bookId: s.string(),
      book: s
        .manyToOne(() => book)
        .fields("bookId")
        .references("id"),
      tagId: s.string(),
      tag: s
        .manyToOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .map("e5u4_pages");
  const tag = s
    .model({
      id: s.string().id(),
      pages: s.oneToMany(() => page),
    })
    .map("e5u4_tags");
  return { writer, book, page, tag };
})();

hydrateSchemaNames(untakenArmSchema);

/** A CLASS V payload: a nested relation write inside `updateMany` data. It is
 *  inexpressible (a set-based UPDATE has no per-row identity for a child write to
 *  reference), and the walk that says so is one of the deferred analyses. */
const CLASS_V_UPDATE = {
  books: {
    updateMany: {
      where: {},
      data: { writer: { connect: { id: "w-other" } } },
    },
  },
};

const CLASS_V_MESSAGE =
  "Nested relation writes inside updateMany data for relation 'books' are not supported.";

let client: any;

beforeAll(async () => {
  client = createClient({
    schema: untakenArmSchema,
    driver: new PGliteDriver({ client: new PGlite() }),
  }) as any;
  await push(client, { force: true });
}, 120_000);

describe("E5-U4 the untaken arm's legality stays deferred", () => {
  test("the UPDATE arm's deferred analysis does not run when the CREATE arm is taken", async () => {
    // The create arm executes; the update arm carries a payload whose deferred walk
    // would reject the whole tree if the envelope — or anything else on the way in —
    // had descended into it.
    const made = await client.writer.upsert({
      where: { id: "w1" },
      create: { id: "w1", email: "w1@x" },
      update: CLASS_V_UPDATE,
    });
    expect(made).toMatchObject({ id: "w1" });
  }, 120_000);

  test("…and DOES run when the UPDATE arm is taken", async () => {
    // The other half: the analysis is deferred, not deleted.
    await client.writer.create({ data: { id: "w2", email: "w2@x" } });
    await expect(
      client.writer.upsert({
        where: { id: "w2" },
        create: { id: "w2", email: "w2@x" },
        update: CLASS_V_UPDATE,
      })
    ).rejects.toThrow(CLASS_V_MESSAGE);
  }, 120_000);

  test("the CREATE arm is NOT deferred — its payload is validated either way", async () => {
    // Measured asymmetry, pinned so it is a recorded fact rather than a surprise: the
    // create arm's sub-op is built without `deferArmLegality`, so an untaken create arm
    // still rejects at construction. Nothing in E5-U3 changed this, and nothing in
    // E5-U3 depends on it.
    await client.writer.create({ data: { id: "w3", email: "w3@x" } });
    await expect(
      client.writer.upsert({
        where: { id: "w3" },
        create: { id: "w3", email: 42 },
        update: { label: "y" },
      })
    ).rejects.toThrow("Expected string");
    // The update arm was the taken one and did not run: the tree was refused whole.
    expect(
      (await client.writer.findUnique({ where: { id: "w3" } })).label
    ).toBe("x");
  }, 120_000);
});

describe("selected-record CLASS V legality", () => {
  test("an ordinary deep selected update rejects before the root write", async () => {
    await client.writer.create({
      data: { id: "w4", email: "w4@x" },
    });
    await client.book.create({
      data: { id: "b4", title: "book", writerId: "w4" },
    });
    await client.tag.create({ data: { id: "t4" } });
    await client.page.create({
      data: { id: "p4", bookId: "b4", tagId: "t4" },
    });

    await expect(
      client.writer.update({
        where: { id: "w4" },
        data: {
          label: "changed",
          books: {
            update: {
              where: { id: "b4" },
              data: {
                pages: {
                  updateMany: {
                    where: {},
                    data: { tag: { connect: { id: "t4" } } },
                  },
                },
              },
            },
          },
        },
      })
    ).rejects.toThrow(
      "query-engine-v2 updateMany for relation 'pages' does not support nested relation writes in its data."
    );

    expect(
      (await client.writer.findUnique({ where: { id: "w4" } })).label
    ).toBe("x");
  }, 120_000);
});
