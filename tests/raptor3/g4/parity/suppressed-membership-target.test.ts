/**
 * N5 — a skipped INSERT is not a skipped MEMBERSHIP, and the membership is
 * written against the row the member NAMES.
 *
 * `skipDuplicates` suppresses the ROW. The membership the member declared is
 * therefore written against the row that already exists — the shipped
 * `joinWhenTargetExists` route — and the row is LOCATED, not assumed: a
 * spelled key that names nothing writes nothing, a generated key names the
 * existing row through the one declared unique the payload spells (the shipped
 * `adopt` disposition, E6.8's `connectOrCreate` adopt), and a member that
 * declares an effect of its own strands whole, join included.
 *
 * At the base this file's four red cells measured the one guard that answered
 * "did this member spell its own row key" as if it answered "does a row exist
 * at that key": a junction INSERT replayed for a never-inserted key (FK
 * violation), a relation-bearing duplicate keeping its join, and no adopt
 * route at all.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const collection = s
  .model({
    id: s.string().id(),
    entries: s.toMany(() => entry).through("n5s_collection_entry"),
  })
  .map("n5s_collections");
const entry = s
  .model({
    id: s.int().id().increment(),
    slug: s.string().nullable().unique(),
    alias: s.string().nullable().unique(),
    label: s.string(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => entry)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => entry).name("tree"),
    // One endpoint owns every junction override (R011).
    collections: s.toMany(() => collection),
    notes: s.toMany(() => note),
  })
  .map("n5s_entries");
const note = s
  .model({
    id: s.string().id(),
    body: s.string(),
    entryId: s.int().nullable(),
    entry: s
      .toOne(() => entry)
      .fields("entryId")
      .references("id"),
  })
  .map("n5s_notes");
const schema = { collection, entry, note };

/** The same estate with an UNNAMEABLE unique index beside a nameable one. */
const indexedCollection = s
  .model({
    id: s.string().id(),
    entries: s.toMany(() => indexedEntry).through("n5i_collection_entry"),
  })
  .map("n5i_collections");
const indexedEntry = s
  .model({
    id: s.int().id().increment(),
    slug: s.string().unique(),
    token: s.string(),
    label: s.string(),
    // One endpoint owns every junction override (R011).
    collections: s.toMany(() => indexedCollection),
  })
  .index(["token"], { unique: true, name: "n5i_entries_token_uq" })
  .map("n5i_entries");
const indexedSchema = {
  collection: indexedCollection,
  entry: indexedEntry,
};

describe("N5: a suppressed member's membership names a located row", () => {
  let driver: RecordingSQLiteDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  async function world() {
    driver = new RecordingSQLiteDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.collection.create({ data: { id: "c1" } });
    return client;
  }
  const members = async (client: any) =>
    (
      await client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
        orderBy: { id: "asc" },
        select: { id: true, label: true },
      })
    ).map((row: { label: string }) => row.label);

  it("a spelled key that names NO row writes no membership and raises nothing", async () => {
    const client = await world();
    await client.entry.create({
      data: { id: 1, slug: "taken", label: "ALTERNATE" },
    });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [{ id: 3, slug: "taken", label: "SUPPRESSED" }],
            skipDuplicates: true,
          },
        },
      },
    });

    assert.deepEqual(await members(client), []);
    assert.equal(await client.entry.findUnique({ where: { id: 3 } }), null);
  });

  it("a spelled key that NAMES an existing row writes its membership, idempotently", async () => {
    const client = await world();
    await client.entry.create({
      data: { id: 1, slug: "taken", label: "EXISTING" },
    });

    const link = () =>
      client.collection.update({
        where: { id: "c1" },
        data: {
          entries: {
            createMany: {
              data: [{ id: 1, slug: "taken", label: "MUST NOT OVERWRITE" }],
              skipDuplicates: true,
            },
          },
        },
      });
    await link();
    await link();

    assert.deepEqual(await members(client), ["EXISTING"]);
    assert.deepEqual(
      await client.$queryRawUnsafe(
        'SELECT COUNT(*) AS "n" FROM "n5s_collection_entry"'
      ),
      [{ n: 1 }]
    );
  });

  it("a suppressed member that declares an effect of its own strands whole, join included", async () => {
    const client = await world();
    await client.entry.create({
      data: { id: 1, slug: "taken", label: "EXISTING" },
    });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                id: 1,
                slug: "taken",
                label: "IGNORED",
                notes: { create: { id: "ghost", body: "must be suppressed" } },
              },
              { id: 2, slug: "fresh", label: "FRESH" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    assert.deepEqual(await members(client), ["FRESH"]);
    assert.deepEqual(await client.note.findMany({}), []);
  });

  it("a GENERATED row key names the existing row through the one unique it spells", async () => {
    const client = await world();
    const existing = await client.entry.create({
      data: { slug: "sitting", label: "EXISTING" },
    });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              { slug: "sitting", label: "IGNORED" },
              { slug: "arriving", label: "FRESH" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    assert.deepEqual(await members(client), ["EXISTING", "FRESH"]);
    assert.equal(
      (await client.entry.findUnique({ where: { slug: "sitting" } }))?.id,
      existing.id
    );
  });

  it("the named row may be one a sibling member's nested child created", async () => {
    const client = await world();

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                slug: "A",
                label: "PARENT",
                children: { create: { slug: "B", label: "CHILD" } },
              },
              { slug: "B", label: "IGNORED" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    assert.deepEqual(await members(client), ["PARENT", "CHILD"]);
  });

  it("TWO spelled uniques name two rows, and so name none", async () => {
    const client = await world();
    await client.entry.create({
      data: { slug: "B-slug", alias: "B-alias", label: "EXISTING" },
    });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [{ slug: "B-slug", alias: "B-alias", label: "IGNORED" }],
            skipDuplicates: true,
          },
        },
      },
    });

    assert.deepEqual(await members(client), []);
  });

  it("an unnameable unique index suppresses a member whose spelled unique names no row", async () => {
    driver = new RecordingSQLiteDriver();
    const client = createClient({ schema: indexedSchema, driver });
    await syncLiveSchema(client);
    await client.collection.create({ data: { id: "c1" } });
    await client.entry.create({
      data: { slug: "existing", token: "TAKEN", label: "EXISTING" },
    });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [{ slug: "new-slug", token: "TAKEN", label: "IGNORED" }],
            skipDuplicates: true,
          },
        },
      },
    });

    assert.deepEqual(
      await client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
      }),
      []
    );
    assert.equal(
      await client.entry.findUnique({ where: { slug: "new-slug" } }),
      null
    );
  });
});
