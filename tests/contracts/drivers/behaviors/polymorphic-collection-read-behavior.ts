/**
 * Direct polymorphic COLLECTION reads, against a real database.
 *
 * Sibling of `polymorphic-relation-behavior.ts`, which owns the row-held slot.
 * Everything here is a §13.3 row: what the provider actually returns, not what
 * the compiler emitted. The orphan rows go through RAW SQL on purpose — a
 * hostile or constraint-free write is exactly the state the strict integrity
 * carrier exists to catch, and the public API cannot produce it.
 *
 * Writes stay refused until Package D, so every fixture row is seeded through
 * raw membership INSERTs rather than a nested write.
 */

import { QueryEngineError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const collectionSchema = (() => {
  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      rank: s.int(),
      gallery: s.manyToOne(() => gallery).optional(),
      // THE CONTROL EDGE. An ordinary, foreign-key-backed to-one with the same
      // shape of nullability as the singular inverse above, so parent ordering
      // through the junction can be compared against parent ordering through a
      // plain join ON THE SAME DIALECT. Default NULL placement is a dialect
      // fact — PostgreSQL sorts NULLs last ascending, SQLite sorts them first —
      // and the invariant here is that the junction path does not CHANGE it.
      sectionId: s.int().nullable(),
      section: s
        .manyToOne(() => section)
        .fields("sectionId")
        .optional(),
    })
    .map("coll_contract_articles");

  const section = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      articles: s.oneToMany(() => article),
    })
    .map("coll_contract_sections");

  const clip = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      seconds: s.int(),
      galleries: s.manyToMany(() => gallery),
    })
    .map("coll_contract_clips");

  const gallery = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      items: s.polymorphicToMany(
        { article: () => article, clip: () => clip },
        {
          values: {
            article: "coll.article.v1",
            clip: "coll.clip.v1",
          },
        }
      ),
    })
    .map("coll_contract_galleries");

  return { article, clip, gallery, section };
})();

const ARTICLE_MEMBERS = "coll_contract_galleries_items_article";
const CLIP_MEMBERS = "coll_contract_galleries_items_clip";

export type PolymorphicCollectionReadBehaviorOptions = {
  readonly name: string;
} & BehaviorDatabaseSource;

export function runPolymorphicCollectionReadBehavior(
  options: PolymorphicCollectionReadBehaviorOptions
): void {
  describe(`${options.name} polymorphic collection reads`, () => {
    const openDatabase = useBehaviorDatabase(collectionSchema, options);
    let database: Awaited<ReturnType<typeof openDatabase>> | undefined;

    beforeEach(async () => {
      database = await openDatabase();
    });

    afterEach(async () => {
      await database?.dispose();
      database = undefined;
    });

    function requireDatabase() {
      if (!database) throw new Error("Behavior database is not initialized");
      return database;
    }

    /**
     * Turn a member junction's FOREIGN KEYS off, however this dialect spells it.
     *
     * THE MALFORMED STATES BELOW ARE OTHERWISE UNREACHABLE, and that is the
     * point: a member junction carries real foreign keys to both endpoints and,
     * when its inverse is singular, a real UNIQUE over the complete target side.
     * The provider refuses an orphan and refuses a duplicate. The strict
     * integrity carrier exists for the case the plan actually names — "a
     * disabled constraint or hostile raw write" — so the test disables the
     * constraint rather than pretending the happy path can produce the state.
     */
    async function disableMemberForeignKeys(
      client: ReturnType<typeof requireDatabase>["client"],
      table: string
    ) {
      const dialect = client.$driver.dialect;
      if (dialect === "sqlite") {
        // SQLite enforces foreign keys per CONNECTION and the driver turns them
        // on; turning them off IS the disablement. Nothing is dropped, so the
        // schema still converges on the next push.
        await client.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
        return;
      }
      const ident = client.$driver.adapter.identifiers.escape;
      if (dialect === "mysql") {
        const named = await client.$queryRaw<{ name: string }>(
          sql`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND CONSTRAINT_TYPE = 'FOREIGN KEY'`
        );
        for (const row of named) {
          await client.$executeRaw(
            sql`ALTER TABLE ${ident(table)} DROP FOREIGN KEY ${ident(row.name)}`
          );
        }
        return;
      }
      const rows = await client.$queryRaw<{ conname: string }>(
        sql`SELECT conname FROM pg_constraint WHERE conrelid = ${table}::regclass AND contype = 'f'`
      );
      for (const row of rows) {
        await client.$executeRaw(
          sql`ALTER TABLE ${ident(table)} DROP CONSTRAINT ${ident(row.conname)}`
        );
      }
    }

    /**
     * Drop the UNIQUE over the complete target side — the constraint that MAKES
     * an inverse singular — and report whether this dialect could.
     *
     * SQLite answers `false`: the serializer emits a table-level
     * `CONSTRAINT x UNIQUE (...)`, which SQLite backs with an internal
     * auto-index it refuses to drop. Rebuilding the table here would put a
     * second copy of the serializer's member-table DDL inside a behaviour test,
     * so the duplicate row measures the invariant from the other side there.
     */
    async function dropSingularUniqueSide(
      client: ReturnType<typeof requireDatabase>["client"],
      table: string
    ): Promise<boolean> {
      const dialect = client.$driver.dialect;
      if (dialect === "sqlite") return false;
      const ident = client.$driver.adapter.identifiers.escape;
      if (dialect === "mysql") {
        // MySQL SATISFIES THE FOREIGN KEY'S INDEX REQUIREMENT WITH THIS VERY
        // UNIQUE INDEX, so dropping it while the keys stand is errno 1553.
        await disableMemberForeignKeys(client, table);
        const named = await client.$queryRaw<{ name: string }>(
          sql`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND CONSTRAINT_TYPE = 'UNIQUE'`
        );
        for (const row of named) {
          await client.$executeRaw(
            sql`ALTER TABLE ${ident(table)} DROP INDEX ${ident(row.name)}`
          );
        }
        return true;
      }
      const rows = await client.$queryRaw<{ conname: string }>(
        sql`SELECT conname FROM pg_constraint WHERE conrelid = ${table}::regclass AND contype = 'u'`
      );
      for (const row of rows) {
        await client.$executeRaw(
          sql`ALTER TABLE ${ident(table)} DROP CONSTRAINT ${ident(row.conname)}`
        );
      }
      return true;
    }

    /** Membership rows, written raw: the write family lands in Package D. */
    async function link(
      client: ReturnType<typeof requireDatabase>["client"],
      table: string,
      galleryId: number,
      column: string,
      targetId: number
    ) {
      const ident = client.$driver.adapter.identifiers.escape;
      await client.$executeRaw(
        sql`INSERT INTO ${ident(table)} (${ident("galleryId")}, ${ident(
          column
        )}) VALUES (${galleryId}, ${targetId})`
      );
    }

    async function seed() {
      const { client } = requireDatabase();
      const gallery = await client.gallery.create({ data: { name: "main" } });
      const first = await client.article.create({
        data: { title: "first", rank: 1 },
      });
      const second = await client.article.create({
        data: { title: "second", rank: 2 },
      });
      const clip = await client.clip.create({
        data: { label: "reel", seconds: 30 },
      });
      await link(client, ARTICLE_MEMBERS, gallery.id, "articleId", first.id);
      await link(client, ARTICLE_MEMBERS, gallery.id, "articleId", second.id);
      await link(client, CLIP_MEMBERS, gallery.id, "clipId", clip.id);
      return { client, gallery, first, second, clip };
    }

    test("an empty collection reads as a fresh empty array, never null", async () => {
      const { client } = requireDatabase();
      const empty = await client.gallery.create({ data: { name: "empty" } });
      const read = await client.gallery.findUniqueOrThrow({
        where: { id: empty.id },
        include: { items: true },
      });
      expect(read.items).toEqual([]);
      expect(read.items).not.toBeNull();
    });

    test("mixed variants flatten in DECLARATION order, tagged correctly", async () => {
      const { client, gallery, first, second, clip } = await seed();
      const read = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: { items: true },
      });
      expect(read.items.map((item) => item.type)).toEqual([
        "article",
        "article",
        "clip",
      ]);
      expect(
        read.items.map((item) => (item.data as { id: number }).id)
      ).toEqual([first.id, second.id, clip.id]);
    });

    test("equal ids in two target tables return two correctly tagged rows", async () => {
      const { client } = requireDatabase();
      const gallery = await client.gallery.create({ data: { name: "twins" } });
      const article = await client.article.create({
        data: { title: "twin", rank: 1 },
      });
      const clip = await client.clip.create({
        data: { label: "twin", seconds: 1 },
      });
      // Independent sequences can, and here do, collide on id.
      await link(client, ARTICLE_MEMBERS, gallery.id, "articleId", article.id);
      await link(client, CLIP_MEMBERS, gallery.id, "clipId", clip.id);

      const read = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: { items: true },
      });
      expect(read.items).toHaveLength(2);
      expect(read.items.map((item) => item.type)).toEqual(["article", "clip"]);
    });

    test("order, window and distinct stay ARM-LOCAL", async () => {
      const { client, gallery, second } = await seed();
      const read = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: {
          items: {
            variants: {
              article: { orderBy: { rank: "desc" }, take: 1 },
            },
          },
        },
      });
      // The article arm was ordered and limited; the clip arm was not touched.
      expect(read.items.map((item) => item.type)).toEqual(["article", "clip"]);
      expect((read.items[0]?.data as { id: number }).id).toBe(second.id);
    });

    test("a negative arm take restores the logical order", async () => {
      const { client, gallery, first, second } = await seed();
      const read = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: {
          items: {
            only: ["article"],
            variants: { article: { orderBy: { rank: "asc" }, take: -2 } },
          },
        },
      });
      expect(
        read.items.map((item) => (item.data as { id: number }).id)
      ).toEqual([first.id, second.id]);
    });

    test("only narrows the returned variants without reordering", async () => {
      const { client, gallery, clip } = await seed();
      const read = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: { items: { only: ["clip"] } },
      });
      expect(read.items.map((item) => item.type)).toEqual(["clip"]);
      expect((read.items[0]?.data as { id: number }).id).toBe(clip.id);

      const none = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: { items: { only: [] } },
      });
      expect(none.items).toEqual([]);
    });

    test("total and filtered counts, and count ordering", async () => {
      const { client, gallery } = await seed();
      const other = await client.gallery.create({ data: { name: "smaller" } });
      const lone = await client.article.create({
        data: { title: "lone", rank: 9 },
      });
      await link(client, ARTICLE_MEMBERS, other.id, "articleId", lone.id);

      const counted = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        select: { id: true, _count: { select: { items: true } } },
      });
      expect(counted._count.items).toBe(3);

      const filtered = await client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        select: {
          id: true,
          _count: {
            select: {
              items: { where: { type: "article", is: { rank: { gt: 1 } } } },
            },
          },
        },
      });
      expect(filtered._count.items).toBe(1);

      const ordered = await client.gallery.findMany({
        orderBy: { items: { _count: "desc" } },
        select: { id: true },
      });
      expect(ordered.map((row) => row.id)).toEqual([gallery.id, other.id]);
    });

    test("some / every / none over a MIXED-VARIANT truth table", async () => {
      const { client, gallery } = await seed();
      const articlesOnly = await client.gallery.create({
        data: { name: "articles-only" },
      });
      const soleArticle = await client.article.create({
        data: { title: "sole", rank: 5 },
      });
      await link(
        client,
        ARTICLE_MEMBERS,
        articlesOnly.id,
        "articleId",
        soleArticle.id
      );
      const empty = await client.gallery.create({ data: { name: "empty" } });

      const ids = async (where: Record<string, unknown>) =>
        (await client.gallery.findMany({ where, select: { id: true } }))
          .map((row) => row.id)
          .sort((left, right) => left - right);

      // `some` is false on an empty arm.
      expect(await ids({ items: { some: { type: "clip" } } })).toEqual([
        gallery.id,
      ]);
      // `every` demands that EVERY member be the tagged variant AND satisfy the
      // predicate — the mixed gallery fails on its clip member alone.
      expect(
        await ids({
          items: { every: { type: "article", is: { rank: { gt: 0 } } } },
        })
      ).toEqual([articlesOnly.id, empty.id].sort((a, b) => a - b));
      // `every` and `none` are vacuously true on an empty collection.
      expect(await ids({ items: { none: { type: "clip" } } })).toEqual(
        [articlesOnly.id, empty.id].sort((a, b) => a - b)
      );
      // "every article satisfies P while other variants are allowed" is the
      // `none … isNot` spelling, and it DOES admit the mixed gallery.
      expect(
        await ids({
          items: { none: { type: "article", isNot: { rank: { gt: 0 } } } },
        })
      ).toEqual([gallery.id, articlesOnly.id, empty.id].sort((a, b) => a - b));
    });

    test("an owner-scoped orphan fails the read, even hidden behind only", async () => {
      const { client, gallery, clip } = await seed();
      const ident = client.$driver.adapter.identifiers.escape;
      // With its FKs intact the provider CASCADEs the membership away and there
      // is no orphan at all. Disable them, then delete the target: the
      // membership row survives, pointing at nothing.
      await disableMemberForeignKeys(client, CLIP_MEMBERS);
      await client.$executeRaw(
        sql`DELETE FROM ${ident("coll_contract_clips")} WHERE ${ident("id")} = ${clip.id}`
      );

      const full = client.gallery.findUniqueOrThrow({
        where: { id: gallery.id },
        include: { items: true },
      });
      await expect(full).rejects.toBeInstanceOf(QueryEngineError);
      await expect(full).rejects.toThrow(
        "Polymorphic relation 'items' references a missing 'clip' record."
      );

      // AND the allow-list cannot hide it: `only: ["article"]` asks for nothing
      // from the clip member table, and `only: []` asks for nothing at all.
      await expect(
        client.gallery.findUniqueOrThrow({
          where: { id: gallery.id },
          include: { items: { only: ["article"] } },
        })
      ).rejects.toThrow(
        "Polymorphic relation 'items' references a missing 'clip' record."
      );
      await expect(
        client.gallery.findUniqueOrThrow({
          where: { id: gallery.id },
          include: { items: { only: [] } },
        })
      ).rejects.toThrow(
        "Polymorphic relation 'items' references a missing 'clip' record."
      );
    });

    test("a singular inverse returns one row or null, and a plural one an array", async () => {
      const { client, gallery, first, clip } = await seed();

      const singular = await client.article.findUniqueOrThrow({
        where: { id: first.id },
        include: { gallery: true },
      });
      expect(singular.gallery).toMatchObject({ id: gallery.id, name: "main" });

      const unlinked = await client.article.create({
        data: { title: "unlinked", rank: 7 },
      });
      const absent = await client.article.findUniqueOrThrow({
        where: { id: unlinked.id },
        include: { gallery: true },
      });
      expect(absent.gallery).toBeNull();

      const plural = await client.clip.findUniqueOrThrow({
        where: { id: clip.id },
        include: { galleries: true },
      });
      expect(plural.galleries).toEqual([
        expect.objectContaining({ id: gallery.id }),
      ]);
    });

    test("a singular-inverse duplicate fails BEFORE the LIMIT", async () => {
      const { client, first } = await seed();
      const second = await client.gallery.create({ data: { name: "second" } });
      // The UNIQUE over the complete target side is what MAKES this inverse
      // singular, and the provider enforces it. Drop it to reach the state the
      // plan names — "malformed provider state even if a missing unique
      // constraint allowed it".
      const dropped = await dropSingularUniqueSide(client, ARTICLE_MEMBERS);
      if (!dropped) {
        // SQLite cannot drop it, so the malformed state is unreachable and the
        // SAME invariant is measured from the other side: the database itself
        // refuses the second membership row. Without this arm the row would
        // silently degrade into a skip on a third of the estate.
        await expect(
          link(client, ARTICLE_MEMBERS, second.id, "articleId", first.id)
        ).rejects.toThrow();
        return;
      }
      await link(client, ARTICLE_MEMBERS, second.id, "articleId", first.id);

      await expect(
        client.article.findUniqueOrThrow({
          where: { id: first.id },
          include: { gallery: true },
        })
      ).rejects.toBeInstanceOf(QueryEngineError);
      // The other half of the §13.3 row — "even when a target filter would
      // leave one visible row" — is pinned as BYTES in
      // `polymorphic-inverse-read-sql.core.test.ts`: both integrity branches sit
      // outside the row subquery, ahead of its WHERE and its LIMIT. It cannot be
      // driven from here, and NOT because of anything Package C left undone: no
      // to-one include node anywhere in the estate offers a target `where`
      // (`toOneIncludeFactory` is `{select, include, omit}`), so a singular
      // inverse offering none is precisely §8.3's "ordinary relation schemas for
      // their cardinality". The equivalence is pinned in
      // `tests/unit/operation-schemas/relations/polymorphic-collection-selection.core.test.ts`.
    });

    test("parent ordering through a singular inverse keeps NULL placement", async () => {
      const { client, gallery, first, second } = await seed();
      const late = await client.gallery.create({ data: { name: "zeta" } });
      // Move `second`'s membership rather than adding one: the UNIQUE over the
      // target side is intact here, exactly as a singular inverse requires.
      const ident = client.$driver.adapter.identifiers.escape;
      await client.$executeRaw(
        sql`DELETE FROM ${ident(ARTICLE_MEMBERS)} WHERE ${ident("galleryId")} = ${gallery.id} AND ${ident("articleId")} = ${second.id}`
      );
      await link(client, ARTICLE_MEMBERS, late.id, "articleId", second.id);
      const unlinked = await client.article.create({
        data: { title: "orphanless", rank: 3 },
      });

      // The control: the SAME three articles, the same two names, the same
      // missing third — reached through an ordinary foreign key instead of the
      // member junction.
      await client.section.create({
        data: { name: "main", articles: { connect: [{ id: first.id }] } },
      });
      await client.section.create({
        data: { name: "zeta", articles: { connect: [{ id: second.id }] } },
      });

      const ordered = await client.article.findMany({
        orderBy: { gallery: { name: "asc" } },
        select: { id: true },
      });
      const control = await client.article.findMany({
        orderBy: { section: { name: "asc" } },
        select: { id: true },
      });

      // Both joins are OUTER, so the article with no membership at all still
      // yields a row...
      expect(ordered.map((row) => row.id)).toContain(unlinked.id);
      expect(ordered).toHaveLength(3);
      // ...and the two linked rows keep their name order...
      const linkedOrder = ordered
        .map((row) => row.id)
        .filter((id) => id !== unlinked.id);
      expect(linkedOrder).toEqual([first.id, second.id]);
      // ...and the NULL row lands exactly where this dialect puts it for an
      // ordinary to-one. Pinning a literal position here would pin PostgreSQL's
      // NULLS LAST default and go red on SQLite for a reason that has nothing
      // to do with polymorphism.
      expect(ordered).toEqual(control);
    });
  });
}

export const polymorphicCollectionReadContract = defineContract({
  id: "drivers.polymorphic-collection-read",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runPolymorphicCollectionReadBehavior,
});
