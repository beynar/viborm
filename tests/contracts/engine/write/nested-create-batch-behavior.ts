import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import {
  recordStatements,
  type SentStatement,
} from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * parity-17: a nested `create` LIST writes its child-free children as ONE
 * multi-row INSERT per child table, through the same grouped, bind-budgeted
 * owner `createMany` uses, where it used to send one INSERT per child.
 *
 * Every witness reads the traffic at the driver's own `execute`/`executeRaw`
 * seam, so the count is what the provider received. The tables already hold
 * 2,000 articles, and the payloads are the sizes a real nested create sends.
 */

const writer = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
    articles: s.toMany(() => article),
  })
  .map("ncb_writers");

const article = s
  .model({
    id: s.int().id().increment(),
    title: s.string(),
    slug: s.string().unique(),
    status: s.enum(["draft", "published"]).default("draft"),
    views: s.int().default(0),
    createdAt: s.dateTime().now(),
    writerId: s.int(),
    writer: s
      .toOne(() => writer)
      .fields("writerId")
      .references("id"),
    notes: s.toMany(() => note),
  })
  .map("ncb_articles");

const note = s
  .model({
    id: s.string().ulid().id(),
    body: s.string(),
    articleId: s.int(),
    article: s
      .toOne(() => article)
      .fields("articleId")
      .references("id"),
  })
  .map("ncb_notes");

const schema = { writer, article, note };

type BatchClient = VibORMClient<VibORMConfig<typeof schema>>;

const ULID = /^[0-9A-Z]{26}$/;
// Anywhere in the statement and namespace-qualified or not, so an INSERT
// inside a CTE counts too.
const INSERT_INTO = /\bINSERT\s+INTO\s+(?:[`"]?\w+[`"]?\.)?[`"]?(\w+)[`"]?/gi;

function inserts(
  sent: readonly SentStatement[],
  table: string
): SentStatement[] {
  return sent.filter((statement) =>
    [...statement.sql.matchAll(INSERT_INTO)].some((match) => match[1] === table)
  );
}

const SEEDED = 2000;

export function runNestedCreateBatchBehavior(options: {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.driverName} nested create batching`, () => {
    let client: BatchClient | undefined;
    let recorder: ReturnType<typeof recordStatements> | undefined;
    let bindLimit: number | undefined;
    let seedWriter = 0;

    beforeEach(async () => {
      const driver = options.createDriver();
      bindLimit = driver.maxBindParametersPerStatement;
      recorder = recordStatements(driver);
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.note.deleteMany({});
      await client.article.deleteMany({});
      await client.writer.deleteMany({});
      seedWriter = (
        await client.writer.create({
          data: { email: "seed@example.com", name: "seed" },
        })
      ).id;
      await client.article.createMany({
        data: Array.from({ length: SEEDED }, (_, n) => ({
          title: `Seed ${n}`,
          slug: `seed-${n}`,
          writerId: seedWriter,
        })),
      });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
      recorder = undefined;
    });

    test("250 nested children are one INSERT, read back in input order with their defaults", async () => {
      const titles = Array.from(
        { length: 250 },
        (_, n) => `Article ${(n * 7919) % 250}`
      );
      recorder?.start();
      const created = await client!.writer.create({
        data: {
          email: "batch@example.com",
          name: "batch",
          articles: {
            create: titles.map((title, n) => ({ title, slug: `batch-${n}` })),
          },
        },
        include: { articles: { orderBy: { id: "asc" } } },
      });
      const sent = recorder?.drain() ?? [];

      expect(inserts(sent, "ncb_articles")).toHaveLength(1);
      expect(inserts(sent, "ncb_writers")).toHaveLength(1);
      expect(created.articles.map((row) => row.title)).toEqual(titles);
      expect(created.articles.map((row) => row.slug)).toEqual(
        titles.map((_, n) => `batch-${n}`)
      );
      const ids = created.articles.map((row) => row.id);
      expect(ids.every((id, n) => n === 0 || id > ids[n - 1]!)).toBe(true);
      for (const row of created.articles) {
        expect(row.writerId).toBe(created.id);
        expect(row.status).toBe("draft");
        expect(row.views).toBe(0);
        expect(row.createdAt).toBeInstanceOf(Date);
      }
    });

    test("children past the bind budget split exactly where createMany splits", async () => {
      // Six written columns per child: everything but the generated id.
      const columns = 6;
      const count = Math.floor(bindLimit! / columns) + 1;
      const row = (n: number, prefix: string) => ({
        title: `Wide ${n}`,
        slug: `${prefix}-${n}`,
        status: "published" as const,
        views: n,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n % 60)),
      });

      recorder?.start();
      await client!.article.createMany({
        data: Array.from({ length: count }, (_, n) => ({
          ...row(n, "flat"),
          writerId: seedWriter,
        })),
      });
      const flat = inserts(recorder?.drain() ?? [], "ncb_articles");

      recorder?.start();
      const created = await client!.writer.create({
        data: {
          email: "wide@example.com",
          name: "wide",
          articles: {
            create: Array.from({ length: count }, (_, n) => row(n, "wide")),
          },
        },
      });
      const nested = inserts(recorder?.drain() ?? [], "ncb_articles");

      expect(flat.length).toBeGreaterThan(1);
      expect(nested.map((statement) => statement.params)).toEqual(
        flat.map((statement) => statement.params)
      );
      for (const statement of nested)
        expect(statement.params).toBeLessThanOrEqual(bindLimit!);
      const stored = await client!.article.findMany({
        where: { writerId: created.id },
        orderBy: { id: "asc" },
        select: { slug: true, views: true },
      });
      expect(stored).toHaveLength(count);
      expect(stored.at(-1)).toEqual({
        slug: `wide-${count - 1}`,
        views: count - 1,
      });
    });

    test("nested-of-nested creates keep their own parents and generated ids", async () => {
      recorder?.start();
      const created = await client!.writer.create({
        data: {
          email: "deep@example.com",
          name: "deep",
          articles: {
            create: [
              {
                title: "a1",
                slug: "deep-1",
                notes: {
                  create: [{ body: "n1" }, { body: "n2" }, { body: "n3" }],
                },
              },
              {
                title: "a2",
                slug: "deep-2",
                notes: { create: [{ body: "n4" }] },
              },
              { title: "a3", slug: "deep-3" },
              { title: "a4", slug: "deep-4" },
            ],
          },
        },
        include: {
          articles: {
            orderBy: { id: "asc" },
            include: { notes: { orderBy: { body: "asc" } } },
          },
        },
      });
      const sent = recorder?.drain() ?? [];

      expect(
        created.articles.map((row) => [
          row.title,
          row.notes.map((child) => child.body),
        ])
      ).toEqual([
        ["a1", ["n1", "n2", "n3"]],
        ["a2", ["n4"]],
        ["a3", []],
        ["a4", []],
      ]);
      const notes = created.articles.flatMap((row) => row.notes);
      expect(new Set(notes.map((child) => child.id)).size).toBe(4);
      for (const child of notes) expect(child.id).toMatch(ULID);
      // a1 and a2 are read by their own notes, so each is its own INSERT; the
      // child-free a3 and a4 share one, and a1's three notes share one.
      expect(inserts(sent, "ncb_articles")).toHaveLength(3);
      expect(inserts(sent, "ncb_notes")).toHaveLength(2);
    });

    test("a connect beside the created list keeps both memberships", async () => {
      recorder?.start();
      const created = await client!.writer.create({
        data: {
          email: "mixed@example.com",
          name: "mixed",
          articles: {
            create: [
              { title: "x", slug: "mixed-x" },
              { title: "y", slug: "mixed-y" },
              { title: "z", slug: "mixed-z" },
            ],
            connect: [{ slug: "seed-0" }],
          },
        },
        include: { articles: { orderBy: { id: "asc" } } },
      });
      const sent = recorder?.drain() ?? [];

      expect(inserts(sent, "ncb_articles")).toHaveLength(1);
      expect(created.articles.map((row) => row.slug)).toEqual([
        "seed-0",
        "mixed-x",
        "mixed-y",
        "mixed-z",
      ]);
      expect(
        await client!.article.count({ where: { writerId: seedWriter } })
      ).toBe(SEEDED - 1);
    });

    test("inside an interactive transaction the list is still one INSERT", async () => {
      recorder?.start();
      const created = await client!.$transaction(async (tx) =>
        tx.writer.create({
          data: {
            email: "tx@example.com",
            name: "tx",
            articles: {
              create: Array.from({ length: 40 }, (_, n) => ({
                title: `t${n}`,
                slug: `tx-${n}`,
              })),
            },
          },
          include: { articles: true },
        })
      );
      const sent = recorder?.drain() ?? [];

      expect(created.articles).toHaveLength(40);
      expect(inserts(sent, "ncb_articles")).toHaveLength(1);
    });

    test("one duplicate in the list fails the grouped INSERT and rolls the whole create back", async () => {
      recorder?.start();
      await expect(
        client!.writer.create({
          data: {
            email: "dup@example.com",
            name: "dup",
            articles: {
              create: [
                { title: "fresh", slug: "dup-fresh" },
                { title: "taken", slug: "seed-1" },
              ],
            },
          },
        })
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      // The violation is raised by the one grouped statement, not by a
      // per-entry INSERT after its sibling already landed.
      expect(inserts(recorder?.drain() ?? [], "ncb_articles")).toHaveLength(1);
      expect(
        await client!.writer.count({ where: { email: "dup@example.com" } })
      ).toBe(0);
      expect(
        await client!.article.count({ where: { slug: "dup-fresh" } })
      ).toBe(0);
    });
  });
}
