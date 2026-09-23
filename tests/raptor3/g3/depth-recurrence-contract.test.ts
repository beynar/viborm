import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

function selfSchema() {
  const node = s
    .model({
      id: s.string().id(),
      label: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("g3_depth_nodes");
  return { node };
}

function nestedCreate(depth: number, level = 1): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: `n${level}`,
    label: `level-${level}`,
  };
  if (level < depth) body.children = { create: nestedCreate(depth, level + 1) };
  return body;
}

describe("G3 C11 recursive body instantiation", () => {
  for (const depth of [1, 2, 8, 32]) {
    it(`keeps a self-relation chain exact at depth ${depth}`, async () => {
      const schema = selfSchema();
      const database = new Database(":memory:");
      const driver = new SQLite3Driver({ client: database });
      const client = createClient({ schema, driver });
      const migration = await syncLiveSchema(client);
      assert.equal(migration.applied, true);
      const candidate = createCommandEngine({ schema, driver });
      try {
        await candidate.execute("node", "create", {
          data: {
            id: "n0",
            label: "root",
            children: { create: nestedCreate(depth) },
          },
          select: { id: true },
        });

        const rows = database
          .prepare("SELECT id,parentId FROM g3_depth_nodes")
          .all();
        assert.equal(rows.length, depth + 1);
        const parents = new Map(
          rows.map((row) => {
            assert(
              row && typeof row === "object" && "id" in row && "parentId" in row
            );
            assert.equal(typeof row.id, "string");
            assert(row.parentId === null || typeof row.parentId === "string");
            return [row.id, row.parentId] as const;
          })
        );
        assert.equal(parents.get("n0"), null);
        for (let level = 1; level <= depth; level++)
          assert.equal(parents.get(`n${level}`), `n${level - 1}`);
      } finally {
        await client.$disconnect();
        database.close();
      }
    });
  }
});

function variantSchema() {
  const warehouse = s
    .model({
      id: s.string().id(),
      crates: s.toMany(() => crate),
    })
    .map("g3_depth_warehouses");
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      crates: s.toMany(() => crate),
    })
    .map("g3_depth_books");
  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("g3_depth_notes");
  const crate = s
    .model({
      id: s.string().id(),
      warehouseId: s.string(),
      warehouse: s
        .toOne(() => warehouse)
        .fields("warehouseId")
        .references("id"),
      items: s
        .toMany(
          { book: () => book, note: () => note },
          { values: { book: "g3.book", note: "g3.note" } }
        )
        .through({
          book: {
            table: "g3_depth_crate_books",
            source: "crate",
            target: "book",
          },
          note: {
            table: "g3_depth_crate_notes",
            source: "crate",
            target: "note",
          },
        }),
    })
    .map("g3_depth_crates");
  return { warehouse, crate, book, note };
}

describe("G3 C11 cross-shape recurrence", () => {
  it("instantiates alternating variant arms inside a nested fixed collection", async () => {
    const schema = variantSchema();
    const database = new Database(":memory:");
    const driver = new SQLite3Driver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    try {
      await candidate.execute("warehouse", "create", {
        data: {
          id: "w1",
          crates: {
            create: {
              id: "c1",
              items: {
                create: [
                  {
                    type: "book",
                    data: { id: "b1", title: "book" },
                  },
                  { type: "note", data: { id: "n1", body: "note" } },
                  {
                    type: "book",
                    data: { id: "b2", title: "book two" },
                  },
                ],
              },
            },
          },
        },
        select: { id: true },
      });

      const crate = await client.crate.findUnique({
        where: { id: "c1" },
        include: { items: true },
      });
      assert(crate);
      assert.deepEqual(
        crate.items.map((entry) => `${entry.type}:${entry.data.id}`).sort(),
        ["book:b1", "book:b2", "note:n1"]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("publishes a changed compound target key to its later child and junction writes", async () => {
    const author = s
      .model({
        tenant: s.string(),
        slug: s.string(),
        name: s.string(),
        books: s.toMany(() => book).through("g3_depth_author_books"),
      })
      .id(["tenant", "slug"])
      .map("g3_depth_authors");
    const book = s
      .model({
        region: s.string(),
        code: s.string(),
        isbn: s.string().unique(),
        title: s.string(),
        authors: s.toMany(() => author),
        chapters: s.toMany(() => chapter),
      })
      .id(["region", "code"])
      .map("g3_depth_compound_books");
    const chapter = s
      .model({
        id: s.string().id(),
        bookRegion: s.string(),
        bookCode: s.string(),
        book: s
          .toOne(() => book)
          .fields("bookRegion", "bookCode")
          .references("region", "code"),
      })
      .map("g3_depth_chapters");
    const schema = { author, book, chapter };
    const database = new Database(":memory:");
    const driver = new SQLite3Driver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    try {
      await client.book.create({
        data: {
          region: "eu",
          code: "old",
          isbn: "moving",
          title: "before",
        },
      });

      await candidate.execute("author", "create", {
        data: {
          tenant: "t1",
          slug: "a1",
          name: "author",
          books: {
            upsert: {
              where: { isbn: "moving" },
              create: {
                region: "never",
                code: "create",
                isbn: "moving",
                title: "never",
              },
              update: {
                region: "ap",
                code: "moved",
                title: "after",
                chapters: { create: { id: "chapter" } },
              },
            },
          },
        },
        select: { tenant: true, slug: true },
      });

      assert.deepEqual(
        await client.chapter.findUnique({
          where: { id: "chapter" },
          select: { bookRegion: true, bookCode: true },
        }),
        { bookRegion: "ap", bookCode: "moved" }
      );
      const storedAuthor = await client.author.findUnique({
        where: { tenant_slug: { tenant: "t1", slug: "a1" } },
        include: { books: true },
      });
      assert(storedAuthor);
      assert.deepEqual(
        storedAuthor.books.map(({ region, code }) => ({ region, code })),
        [{ region: "ap", code: "moved" }]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });
});
