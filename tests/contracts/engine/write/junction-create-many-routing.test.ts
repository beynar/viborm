import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const rowLocalSkipSchema = (() => {
  const collection = s
    .model({
      id: s.string().id(),
      entries: s.toMany(() => entry).through("f1_collection_entry"),
    })
    .map("f1_collections");
  const entry = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().nullable().unique(),
      alias: s.string().nullable().unique(),
      token: s.string(),
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
      details: s.toMany(() => detail),
      tags: s.toMany(() => tag).through("f1_entry_tag"),
    })
    .map("f1_entries");
  const detail = s
    .model({
      id: s.string().id(),
      body: s.string(),
      entryId: s.int().nullable(),
      entry: s
        .toOne(() => entry)
        .fields("entryId")
        .references("id"),
    })
    .map("f1_details");
  const tag = s
    .model({
      id: s.string().id(),
      // One endpoint owns every junction override (R011).
      entries: s.toMany(() => entry),
    })
    .map("f1_tags");
  return { collection, detail, entry, tag };
})();

describe("residual F1 — junction skip disposition is row-local and ordered", () => {
  test("a spelled scalar key links only when that exact target exists", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.entry.create({
      data: {
        id: 1,
        slug: "taken",
        token: "alternate",
        label: "ALTERNATE",
      },
    });
    await client.entry.create({
      data: {
        id: 2,
        slug: "authoritative",
        token: "exact",
        label: "EXACT",
      },
    });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                id: 3,
                slug: "taken",
                token: "suppressed",
                label: "SUPPRESSED",
              },
              {
                id: 4,
                slug: "fresh",
                token: "fresh",
                label: "FRESH",
              },
              {
                id: 2,
                slug: "taken",
                token: "must not overwrite",
                label: "MUST NOT OVERWRITE",
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
        orderBy: { id: "asc" },
        select: { id: true, label: true },
      })
    ).resolves.toEqual([
      { id: 2, label: "EXACT" },
      { id: 4, label: "FRESH" },
    ]);
    await expect(
      client.entry.findUnique({ where: { id: 3 } })
    ).resolves.toBeNull();
    await expect(
      client.entry.findUnique({ where: { id: 1 } })
    ).resolves.toMatchObject({
      label: "ALTERNATE",
      slug: "taken",
    });
    await client.$disconnect();
  }, 60_000);

  test("a relation-bearing spelled duplicate suppresses its subtree and join", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.entry.create({
      data: {
        id: 1,
        slug: "existing",
        token: "existing",
        label: "EXISTING",
      },
    });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                id: 1,
                slug: "existing",
                token: "duplicate",
                label: "IGNORED",
                details: {
                  create: { id: "ghost", body: "must be suppressed" },
                },
              },
              {
                id: 2,
                slug: "fresh-with-child",
                token: "fresh",
                label: "FRESH",
                details: { create: { id: "landed", body: "landed" } },
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
        select: { id: true },
      })
    ).resolves.toEqual([{ id: 2 }]);
    await expect(
      client.detail.findMany({ orderBy: { id: "asc" } })
    ).resolves.toMatchObject([{ id: "landed", body: "landed" }]);
    await client.$disconnect();
  }, 60_000);

  test("an adoptable row and a relation-bearing unnameable row keep their own meanings", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.entry.create({
      data: {
        slug: "B-slug",
        alias: "B-alias",
        token: "seed-b",
        label: "ORIGINAL-B",
      },
    });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              { slug: "A", token: "A-first", label: "FIRST-A" },
              {
                slug: "B-slug",
                alias: "B-alias",
                token: "new-b",
                label: "IGNORED-B",
                details: {
                  create: { id: "ghost", body: "must be suppressed" },
                },
              },
              { slug: "C", token: "C", label: "FRESH-C" },
              { slug: "A", token: "A-second", label: "IGNORED-A" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
        orderBy: { slug: "asc" },
        select: { slug: true, label: true },
      })
    ).resolves.toEqual([
      { slug: "A", label: "FIRST-A" },
      { slug: "C", label: "FRESH-C" },
    ]);
    await expect(client.detail.findMany({})).resolves.toEqual([]);
    await client.$disconnect();
  }, 60_000);

  test("spelled rows stay on both sides of a relation-bearing generated row", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.$executeRawUnsafe(
      'CREATE TABLE "f1_order" ("n" SERIAL PRIMARY KEY, "label" TEXT NOT NULL)'
    );
    await client
      .$executeRawUnsafe(
        'CREATE TRIGGER "f1_entry_order" AFTER INSERT ON "f1_entries" FOR EACH ROW EXECUTE FUNCTION viborm_test_f1_order()'
      )
      .catch(async () => {
        await client.$executeRawUnsafe(
          'CREATE OR REPLACE FUNCTION viborm_test_f1_order() RETURNS trigger AS $$ BEGIN INSERT INTO "f1_order" ("label") VALUES (NEW."label"); RETURN NEW; END; $$ LANGUAGE plpgsql'
        );
        await client.$executeRawUnsafe(
          'CREATE TRIGGER "f1_entry_order" AFTER INSERT ON "f1_entries" FOR EACH ROW EXECUTE FUNCTION viborm_test_f1_order()'
        );
      });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              { id: 100, slug: "S1", token: "S1", label: "first" },
              {
                token: "B",
                label: "middle",
                details: { create: { id: "d1", body: "middle child" } },
              },
              { id: 101, slug: "S2", token: "S2", label: "last" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.$queryRawUnsafe('SELECT "label" FROM "f1_order" ORDER BY "n"')
    ).resolves.toEqual([
      { label: "first" },
      { label: "middle" },
      { label: "last" },
    ]);
    await expect(client.detail.findMany({})).resolves.toMatchObject([
      { id: "d1", body: "middle child" },
    ]);
    await client.$disconnect();
  }, 60_000);

  test("a later adopter plans after an earlier suppressible series row", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                slug: "first-slug",
                alias: "shared-alias",
                token: "first-token",
                label: "FIRST",
                details: { create: { id: "d1", body: "first child" } },
              },
              {
                alias: "shared-alias",
                token: "ignored-token",
                label: "IGNORED",
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
        select: { label: true },
      })
    ).resolves.toEqual([{ label: "FIRST" }]);
    await expect(
      client.detail.findMany({ select: { body: true } })
    ).resolves.toEqual([{ body: "first child" }]);
    await client.$disconnect();
  }, 60_000);

  test("each relation-bearing adopter plans after its predecessor", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                slug: "A",
                token: "A",
                label: "FIRST",
                tags: { create: { id: "t1" } },
              },
              {
                slug: "B",
                token: "B",
                label: "SECOND",
                tags: { connect: { id: "t1" } },
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { tags: { some: { id: "t1" } } },
        orderBy: { slug: "asc" },
        select: { slug: true },
      })
    ).resolves.toEqual([{ slug: "A" }, { slug: "B" }]);
    await client.$disconnect();
  }, 60_000);

  test("a scalar adopter plans after a relation-bearing adopter creates its target", async () => {
    const client = createClient({
      schema: rowLocalSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                slug: "A",
                token: "parent-token",
                label: "PARENT",
                children: {
                  create: {
                    slug: "B",
                    token: "child-token",
                    label: "CHILD",
                  },
                },
              },
              { slug: "B", token: "ignored-token", label: "IGNORED" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
        orderBy: { slug: "asc" },
        select: { slug: true, label: true },
      })
    ).resolves.toEqual([
      { slug: "A", label: "PARENT" },
      { slug: "B", label: "CHILD" },
    ]);
    await client.$disconnect();
  }, 60_000);
});

const mixedIndexSkipSchema = (() => {
  const collection = s
    .model({
      id: s.string().id(),
      entries: s.toMany(() => entry).through("f1i_collection_entry"),
    })
    .map("f1i_collections");
  const entry = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      token: s.string(),
      label: s.string(),
      // One endpoint owns every junction override (R011).
      collections: s.toMany(() => collection),
    })
    .index(["token"], { unique: true, name: "f1i_entries_token_uq" })
    .map("f1i_entries");
  return { collection, entry };
})();

describe("residual F1 — unnameable indexes dominate an adoptable selector", () => {
  test("a raw unique index prevents an unsafe adopt route", async () => {
    const client = createClient({
      schema: mixedIndexSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.entry.create({
      data: { slug: "existing", token: "TAKEN", label: "EXISTING" },
    });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                slug: "new-slug",
                token: "TAKEN",
                label: "IGNORED",
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
      })
    ).resolves.toEqual([]);
    await client.$disconnect();
  }, 60_000);

  test("a spelled key does not link when only a raw unique index conflicts", async () => {
    const client = createClient({
      schema: mixedIndexSkipSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    });
    await push(client, { force: true });
    await client.entry.create({
      data: { id: 1, slug: "existing", token: "TAKEN", label: "EXISTING" },
    });
    await client.collection.create({ data: { id: "c1" } });

    await client.collection.update({
      where: { id: "c1" },
      data: {
        entries: {
          createMany: {
            data: [
              {
                id: 2,
                slug: "new-slug",
                token: "TAKEN",
                label: "IGNORED",
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.entry.findMany({
        where: { collections: { some: { id: "c1" } } },
      })
    ).resolves.toEqual([]);
    await expect(
      client.entry.findUnique({ where: { id: 2 } })
    ).resolves.toBeNull();
    await client.$disconnect();
  }, 60_000);
});
