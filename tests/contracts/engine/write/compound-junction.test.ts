import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const compoundJunctionSchema = (() => {
  const author = s
    .model({
      tenantId: s.string().map("author_tenant"),
      slug: s.string().map("author_slug"),
      name: s.string(),
      books: s
        .toMany(() => book)
        .through("compound_author_book")
        .source("author")
        .target("book")
        .onUpdate("cascade"),
    })
    .id(["tenantId", "slug"])
    .map("compound_authors");

  const book = s
    .model({
      region: s.string().map("book_region"),
      code: s.string().map("book_code"),
      isbn: s.string().unique(),
      title: s.string(),
      // One endpoint owns every override (R011); `author.books` above spells
      // the same table, sides and action, and the resolver mirrors them here.
      authors: s.toMany(() => author),
    })
    .id(["region", "code"])
    .map("compound_books");

  return { author, book };
})();

const authorKey = (tenantId: string, slug: string) => ({
  tenantId_slug: { tenantId, slug },
});

const bookKey = (region: string, code: string) => ({
  region_code: { region, code },
});

const asymmetricJunctionSchema = (() => {
  const workspace = s
    .model({
      tenantId: s.string().map("workspace_tenant"),
      slug: s.string().map("workspace_slug"),
      name: s.string(),
      labels: s
        .toMany(() => label)
        .through("compound_workspace_label")
        .source("workspace")
        .target("label"),
    })
    .id(["tenantId", "slug"])
    .map("compound_workspaces");
  const label = s
    .model({
      id: s.string().id().map("label_id"),
      name: s.string(),
      workspaces: s.toMany(() => workspace),
    })
    .map("compound_labels");
  return { label, workspace };
})();

const workspaceKey = (tenantId: string, slug: string) => ({
  tenantId_slug: { tenantId, slug },
});

const memberUniqueJunctionSchema = (() => {
  const catalog = s
    .model({
      id: s.string().id(),
      entries: s.toMany(() => entry).through("compound_catalog_entry"),
    })
    .map("compound_catalogs");
  const entry = s
    .model({
      tenantId: s.string().unique(),
      localId: s.string(),
      label: s.string(),
      catalogs: s.toMany(() => catalog),
    })
    .id(["tenantId", "localId"])
    .map("compound_catalog_entries");
  return { catalog, entry };
})();

const compoundSelfJunctionSchema = (() => {
  const node = s
    .model({
      tenantId: s.string(),
      key: s.string(),
      label: s.string(),
      outgoing: s
        .toMany(() => node)
        .name("directed")
        .through("compound_node_links")
        .source("source")
        .target("target"),
      incoming: s.toMany(() => node).name("directed"),
    })
    .id(["tenantId", "key"])
    .map("compound_nodes");
  return { node };
})();

/**
 * A self junction whose two halves configure NOTHING but the table: §9.4 lets a
 * paired self `toMany` use the field-derived default side tokens instead of
 * forcing `.source()`/`.target()`. It was a LONE self slot here until the
 * unified language made an ordinary slot without an inverse an error.
 */
const compoundDefaultSelfJunctionSchema = (() => {
  const node = s
    .model({
      tenantId: s.string(),
      key: s.string(),
      label: s.string(),
      peers: s
        .toMany(() => node)
        .name("peers")
        .through("compound_node_peers"),
      peeredBy: s.toMany(() => node).name("peers"),
    })
    .id(["tenantId", "key"])
    .map("compound_peer_nodes");
  return { node };
})();

const nodeKey = (tenantId: string, key: string) => ({
  tenantId_key: { tenantId, key },
});

const generatedCompoundJunctionSchema = (() => {
  const owner = s
    .model({
      scope: s.string(),
      id: s.string(),
      targets: s
        .toMany(() => target)
        .through("generated_compound_owner_target"),
    })
    .id(["scope", "id"])
    .map("generated_compound_owners");
  const target = s
    .model({
      tenantId: s.string(),
      serial: s.int().increment(),
      label: s.string(),
      owners: s.toMany(() => owner),
    })
    .id(["tenantId", "serial"])
    .map("generated_compound_targets");
  return { owner, target };
})();

for (const mode of ["transaction", "atomicBatch"] as const) {
  describe(`compound many-to-many (${mode})`, () => {
    const family = usePGliteSchemaFamily(compoundJunctionSchema, mode);

    async function seedDecoys(): Promise<void> {
      const { client } = family();
      for (const [tenantId, slug] of [
        ["t1", "a1"],
        ["t1", "a2"],
        ["t2", "a1"],
      ] as const) {
        await client.author.create({
          data: { tenantId, slug, name: `${tenantId}/${slug}` },
        });
      }
      for (const [region, code, isbn] of [
        ["eu", "b1", "isbn-eu-b1"],
        ["eu", "b2", "isbn-eu-b2"],
        ["us", "b1", "isbn-us-b1"],
      ] as const) {
        await client.book.create({
          data: { region, code, isbn, title: `${region}/${code}` },
        });
      }
    }

    async function booksOf(tenantId: string, slug: string): Promise<string[]> {
      const row = await family().client.author.findUnique({
        where: authorKey(tenantId, slug),
        include: { books: true },
      });
      return (row?.books ?? [])
        .map((book) => `${book.region}/${book.code}`)
        .sort();
    }

    test("connect and reads use every member of both stored references", async () => {
      await seedDecoys();
      const { client } = family();

      await client.author.update({
        where: authorKey("t1", "a1"),
        data: { books: { connect: bookKey("eu", "b1") } },
      });

      expect(await booksOf("t1", "a1")).toEqual(["eu/b1"]);
      expect(await booksOf("t1", "a2")).toEqual([]);
      expect(await booksOf("t2", "a1")).toEqual([]);

      const inverse = await client.book.findUnique({
        where: bookKey("eu", "b1"),
        include: { authors: true },
      });
      expect(
        (inverse?.authors ?? []).map(
          (author) => `${author.tenantId}/${author.slug}`
        )
      ).toEqual(["t1/a1"]);

      const filtered = await client.author.findMany({
        where: { books: { some: { region: "eu", code: "b1" } } },
      });
      expect(
        filtered.map((author) => `${author.tenantId}/${author.slug}`)
      ).toEqual(["t1/a1"]);
    });

    test("create, connectOrCreate, and upsert publish complete target keys", async () => {
      const { client } = family();
      await client.book.create({
        data: {
          region: "eu",
          code: "found",
          isbn: "isbn-found",
          title: "found",
        },
      });

      await client.author.create({
        data: {
          tenantId: "t1",
          slug: "a1",
          name: "author",
          books: {
            create: {
              region: "ap",
              code: "new",
              isbn: "isbn-created",
              title: "created",
            },
            connectOrCreate: {
              where: bookKey("eu", "found"),
              create: {
                region: "eu",
                code: "found",
                isbn: "isbn-ignored",
                title: "ignored",
              },
            },
          },
        },
      });

      await client.author.update({
        where: authorKey("t1", "a1"),
        data: {
          books: {
            upsert: {
              where: bookKey("us", "missing"),
              create: {
                region: "us",
                code: "missing",
                isbn: "isbn-upserted",
                title: "upserted",
              },
              update: { title: "never" },
            },
          },
        },
      });

      expect(await booksOf("t1", "a1")).toEqual([
        "ap/new",
        "eu/found",
        "us/missing",
      ]);
      expect(
        await client.book.findUnique({ where: bookKey("eu", "found") })
      ).toMatchObject({ title: "found" });
    });

    test("set, disconnect, update, and delete keep tuple membership exact", async () => {
      await seedDecoys();
      const { client } = family();
      await client.author.update({
        where: authorKey("t1", "a1"),
        data: {
          books: {
            connect: [bookKey("eu", "b1"), bookKey("eu", "b2")],
          },
        },
      });

      await client.author.update({
        where: authorKey("t1", "a1"),
        data: {
          books: {
            set: [bookKey("eu", "b2"), bookKey("us", "b1")],
          },
        },
      });
      await client.author.update({
        where: authorKey("t1", "a1"),
        data: {
          books: {
            update: {
              where: bookKey("eu", "b2"),
              data: { title: "updated" },
            },
          },
        },
      });
      expect(await booksOf("t1", "a1")).toEqual(["eu/b2", "us/b1"]);
      expect(
        await client.book.findUnique({ where: bookKey("eu", "b2") })
      ).toMatchObject({ title: "updated" });
      await expect(
        client.author.findUnique({
          where: authorKey("t1", "a1"),
          select: {
            _count: { select: { books: true } },
            books: { orderBy: { code: "asc" }, take: 1 },
          },
        })
      ).resolves.toMatchObject({
        _count: { books: 2 },
        books: [{ region: "us", code: "b1" }],
      });

      await client.author.update({
        where: authorKey("t1", "a1"),
        data: { books: { disconnect: bookKey("us", "b1") } },
      });
      await client.author.update({
        where: authorKey("t1", "a1"),
        data: { books: { delete: bookKey("eu", "b2") } },
      });

      expect(await booksOf("t1", "a1")).toEqual([]);
      expect(
        await client.book.findUnique({ where: bookKey("us", "b1") })
      ).not.toBeNull();
      expect(
        await client.book.findUnique({ where: bookKey("eu", "b2") })
      ).toBeNull();
      expect(
        await client.book.findUnique({ where: bookKey("eu", "b1") })
      ).not.toBeNull();
    });

    test("a compound target key transition cascades the complete junction side", async () => {
      await seedDecoys();
      const { client } = family();
      await client.author.update({
        where: authorKey("t1", "a1"),
        data: { books: { connect: bookKey("eu", "b1") } },
      });

      await client.book.update({
        where: bookKey("eu", "b1"),
        data: { region: "ap", code: "moved" },
      });

      expect(await booksOf("t1", "a1")).toEqual(["ap/moved"]);
      expect(
        await client.book.findUnique({ where: bookKey("us", "b1") })
      ).not.toBeNull();
    });

    test("a fresh-parent upsert joins the target's post-update compound key", async () => {
      const { client } = family();
      await client.book.create({
        data: {
          region: "eu",
          code: "old",
          isbn: "isbn-moving",
          title: "before",
        },
      });

      await client.author.create({
        data: {
          tenantId: "t1",
          slug: "fresh",
          name: "fresh parent",
          books: {
            upsert: {
              where: { isbn: "isbn-moving" },
              create: {
                region: "never",
                code: "created",
                isbn: "isbn-moving",
                title: "never",
              },
              update: { region: "ap", code: "moved", title: "after" },
            },
          },
        },
      });

      expect(await booksOf("t1", "fresh")).toEqual(["ap/moved"]);
      await expect(
        client.book.findUnique({ where: bookKey("ap", "moved") })
      ).resolves.toMatchObject({ isbn: "isbn-moving", title: "after" });
      await expect(
        client.book.findUnique({ where: bookKey("eu", "old") })
      ).resolves.toBeNull();
    });

    test("skipDuplicates links only the exact complete target key", async () => {
      const { client } = family();
      await client.author.create({
        data: { tenantId: "t1", slug: "owner", name: "owner" },
      });
      for (const row of [
        {
          region: "seed",
          code: "alternate",
          isbn: "isbn-taken",
          title: "alternate owner",
        },
        {
          region: "seed",
          code: "exact",
          isbn: "isbn-exact",
          title: "exact owner",
        },
        {
          region: "seed",
          code: "authoritative",
          isbn: "isbn-authoritative",
          title: "authoritative owner",
        },
      ] as const) {
        await client.book.create({ data: row });
      }

      await client.author.update({
        where: authorKey("t1", "owner"),
        data: {
          books: {
            createMany: {
              data: [
                {
                  region: "missing",
                  code: "alternate",
                  isbn: "isbn-taken",
                  title: "must be suppressed",
                },
                {
                  region: "fresh",
                  code: "created",
                  isbn: "isbn-fresh",
                  title: "created",
                },
                {
                  region: "seed",
                  code: "exact",
                  isbn: "isbn-exact",
                  title: "must not overwrite",
                },
                {
                  region: "seed",
                  code: "authoritative",
                  isbn: "isbn-taken",
                  title: "must not overwrite either row",
                },
              ],
              skipDuplicates: true,
            },
          },
        },
      });

      expect(await booksOf("t1", "owner")).toEqual([
        "fresh/created",
        "seed/authoritative",
        "seed/exact",
      ]);
      await expect(
        client.book.findUnique({ where: bookKey("missing", "alternate") })
      ).resolves.toBeNull();
      await expect(
        client.book.findUnique({ where: bookKey("seed", "alternate") })
      ).resolves.toMatchObject({
        isbn: "isbn-taken",
        title: "alternate owner",
      });
      await expect(
        client.book.findUnique({
          where: bookKey("seed", "authoritative"),
        })
      ).resolves.toMatchObject({
        isbn: "isbn-authoritative",
        title: "authoritative owner",
      });
    });
  });

  describe(`asymmetric compound many-to-many (${mode})`, () => {
    const family = usePGliteSchemaFamily(asymmetricJunctionSchema, mode);

    async function seedAsymmetricDecoys(): Promise<void> {
      const { client } = family();
      for (const [tenantId, slug] of [
        ["t1", "same"],
        ["t1", "other"],
        ["t2", "same"],
      ] as const) {
        await client.workspace.create({
          data: { tenantId, slug, name: `${tenantId}/${slug}` },
        });
      }
      for (const id of ["l1", "l2", "l3"] as const) {
        await client.label.create({ data: { id, name: id } });
      }
    }

    test("compound-source and compound-target directions keep every member", async () => {
      await seedAsymmetricDecoys();
      const { client } = family();

      await client.workspace.update({
        where: workspaceKey("t1", "same"),
        data: { labels: { connect: { id: "l1" } } },
      });
      await client.label.update({
        where: { id: "l2" },
        data: { workspaces: { connect: workspaceKey("t1", "other") } },
      });

      await expect(
        client.workspace.findUnique({
          where: workspaceKey("t1", "same"),
          include: { labels: true },
        })
      ).resolves.toMatchObject({ labels: [{ id: "l1" }] });
      await expect(
        client.workspace.findUnique({
          where: workspaceKey("t2", "same"),
          include: { labels: true },
        })
      ).resolves.toMatchObject({ labels: [] });
      await expect(
        client.label.findUnique({
          where: { id: "l2" },
          include: { workspaces: true },
        })
      ).resolves.toMatchObject({
        workspaces: [{ tenantId: "t1", slug: "other", name: "t1/other" }],
      });
    });

    test("bulk guards update and delete only the complete connected tuple", async () => {
      await seedAsymmetricDecoys();
      const { client } = family();
      await client.label.update({
        where: { id: "l1" },
        data: { workspaces: { connect: workspaceKey("t1", "same") } },
      });

      await client.label.update({
        where: { id: "l1" },
        data: {
          workspaces: {
            updateMany: {
              where: { slug: "same" },
              data: { name: "updated member" },
            },
          },
        },
      });
      await expect(
        client.workspace.findUnique({ where: workspaceKey("t1", "same") })
      ).resolves.toMatchObject({ name: "updated member" });
      await expect(
        client.workspace.findUnique({ where: workspaceKey("t2", "same") })
      ).resolves.toMatchObject({ name: "t2/same" });

      await client.label.update({
        where: { id: "l1" },
        data: { workspaces: { deleteMany: { slug: "same" } } },
      });
      await expect(
        client.workspace.findUnique({ where: workspaceKey("t1", "same") })
      ).resolves.toBeNull();
      await expect(
        client.workspace.findUnique({ where: workspaceKey("t2", "same") })
      ).resolves.toMatchObject({ name: "t2/same" });
    });
  });

  describe(`compound-key member uniqueness (${mode})`, () => {
    const family = usePGliteSchemaFamily(memberUniqueJunctionSchema, mode);

    test("one independently unique key member cannot link a different tuple", async () => {
      const { client } = family();
      await client.catalog.create({ data: { id: "catalog" } });
      await client.entry.create({
        data: { tenantId: "tenant", localId: "existing", label: "existing" },
      });

      await client.catalog.update({
        where: { id: "catalog" },
        data: {
          entries: {
            createMany: {
              data: [
                {
                  tenantId: "tenant",
                  localId: "different",
                  label: "must be suppressed",
                },
              ],
              skipDuplicates: true,
            },
          },
        },
      });

      await expect(
        client.catalog.findUnique({
          where: { id: "catalog" },
          include: { entries: true },
        })
      ).resolves.toMatchObject({ entries: [] });
      await expect(
        client.entry.findUnique({
          where: {
            tenantId_localId: {
              tenantId: "tenant",
              localId: "different",
            },
          },
        })
      ).resolves.toBeNull();
    });
  });

  describe(`paired compound self-junction orientation (${mode})`, () => {
    const family = usePGliteSchemaFamily(compoundSelfJunctionSchema, mode);

    test("paired self relations keep complete oriented sides", async () => {
      const { client } = family();
      for (const [tenantId, key] of [
        ["t1", "a"],
        ["t1", "b"],
        ["t2", "b"],
      ] as const) {
        await client.node.create({
          data: { tenantId, key, label: `${tenantId}/${key}` },
        });
      }

      await client.node.update({
        where: nodeKey("t1", "a"),
        data: {
          outgoing: { connect: nodeKey("t1", "b") },
        },
      });

      await expect(
        client.node.findUnique({
          where: nodeKey("t1", "a"),
          include: { outgoing: true, incoming: true },
        })
      ).resolves.toMatchObject({
        outgoing: [{ tenantId: "t1", key: "b" }],
        incoming: [],
      });
      await expect(
        client.node.findUnique({
          where: nodeKey("t1", "b"),
          include: { incoming: true },
        })
      ).resolves.toMatchObject({
        incoming: [{ tenantId: "t1", key: "a" }],
      });

      await client.node.update({
        where: nodeKey("t1", "b"),
        data: { incoming: { disconnect: nodeKey("t1", "a") } },
      });
      await expect(
        client.node.findUnique({
          where: nodeKey("t1", "a"),
          include: { outgoing: true },
        })
      ).resolves.toMatchObject({ outgoing: [] });
    });
  });

  describe(`default-token compound self-junction orientation (${mode})`, () => {
    const family = usePGliteSchemaFamily(
      compoundDefaultSelfJunctionSchema,
      mode
    );

    test("a paired self relation stores both complete default sides", async () => {
      const { client } = family();
      for (const [tenantId, key] of [
        ["t1", "a"],
        ["t1", "b"],
        ["t2", "b"],
      ] as const) {
        await client.node.create({
          data: { tenantId, key, label: `${tenantId}/${key}` },
        });
      }

      await client.node.update({
        where: nodeKey("t1", "a"),
        data: { peers: { connect: nodeKey("t2", "b") } },
      });

      await expect(
        client.node.findUnique({
          where: nodeKey("t1", "a"),
          include: { peers: true },
        })
      ).resolves.toMatchObject({ peers: [{ tenantId: "t2", key: "b" }] });
      await expect(
        client.node.findUnique({
          where: nodeKey("t1", "b"),
          include: { peers: true },
        })
      ).resolves.toMatchObject({ peers: [] });
      // The opposite side of the same default-token junction (§11.2.11).
      await expect(
        client.node.findUnique({
          where: nodeKey("t2", "b"),
          include: { peeredBy: true },
        })
      ).resolves.toMatchObject({ peeredBy: [{ tenantId: "t1", key: "a" }] });
    });
  });

  describe(`generated compound junction identity (${mode})`, () => {
    const family = usePGliteSchemaFamily(generatedCompoundJunctionSchema, mode);

    test("one generated target member publishes the complete tuple to the join", async () => {
      const { client } = family();

      await expect(
        client.owner.create({
          data: {
            scope: "scope",
            id: "owner",
            targets: {
              create: { tenantId: "tenant", label: "generated target" },
            },
          },
          select: {
            scope: true,
            id: true,
            targets: { select: { tenantId: true, serial: true, label: true } },
          },
        })
      ).resolves.toEqual({
        scope: "scope",
        id: "owner",
        targets: [{ tenantId: "tenant", serial: 1, label: "generated target" }],
      });
    });
  });
}
