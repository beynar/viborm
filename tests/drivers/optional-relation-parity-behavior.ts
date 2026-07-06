import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const MUTUALLY_EXCLUSIVE = /mutually exclusive/i;

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => post).name("author"),
  editedPosts: s.oneToMany(() => post).name("editor"),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string().nullable(),
  editorId: s.string().nullable(),
  author: s
    .manyToOne(() => user)
    .fields("authorId")
    .references("id")
    .optional()
    .name("author"),
  editor: s
    .manyToOne(() => user)
    .fields("editorId")
    .references("id")
    .optional()
    .name("editor"),
});

const schema = { user, post };

type ParityClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ParityClient = VibORMClient<ParityClientConfig>;

export interface OptionalRelationParityBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Execution-backed Prisma-parity checks for relation validation fixes:
 * - create() does not require optional to-one relations
 * - where: { relation: null } matches rows with a null FK
 * - include: { rel: false } omits the relation from the result
 * - select/include can alternate down the relation tree
 * - nested select+include on the same node is rejected
 * - mutations return scalars only unless select/include is passed
 */
export function runOptionalRelationParityBehavior({
  driverName,
  createDriver,
}: OptionalRelationParityBehaviorOptions) {
  describe(`${driverName} optional-relation Prisma parity`, () => {
    let client: ParityClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema,
        driver: createDriver(),
      });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    function requireClient(value: ParityClient | undefined): ParityClient {
      if (!value) {
        throw new Error("Client is not initialized");
      }
      return value;
    }

    test("create succeeds with all optional relations omitted", async () => {
      const created = await requireClient(client).post.create({
        data: { id: "p1", title: "hello" },
      });
      expect(created).toMatchObject({
        id: "p1",
        title: "hello",
        authorId: null,
        editorId: null,
      });
    });

    test("nested create does not demand other optional relations", async () => {
      const created = await requireClient(client).user.create({
        data: {
          id: "u1",
          name: "A",
          posts: { create: [{ id: "p1", title: "t" }] },
        },
        include: { posts: true },
      });
      expect(created.posts).toHaveLength(1);
      expect(created.posts[0]).toMatchObject({
        id: "p1",
        authorId: "u1",
        editorId: null,
      });
    });

    test("where: { relation: null } matches rows with a null FK", async () => {
      const c = requireClient(client);
      await c.user.create({ data: { id: "u1", name: "A" } });
      await c.post.create({
        data: { id: "with-author", title: "a", authorId: "u1" },
      });
      await c.post.create({ data: { id: "orphan", title: "b" } });

      const orphans = await c.post.findMany({ where: { author: null } });
      expect(orphans.map((p) => p.id)).toEqual(["orphan"]);

      const authored = await c.post.findMany({
        where: { author: { isNot: null } },
      });
      expect(authored.map((p) => p.id)).toEqual(["with-author"]);
    });

    test("include: { rel: false } omits the relation", async () => {
      const c = requireClient(client);
      await c.user.create({
        data: {
          id: "u1",
          name: "A",
          posts: { create: [{ id: "p1", title: "t" }] },
        },
      });

      const row = await c.user.findUnique({
        where: { id: "u1" },
        include: { posts: false, editedPosts: true },
      });
      expect(row).not.toBeNull();
      expect(row && "posts" in row).toBe(false);
      expect(row?.editedPosts).toEqual([]);
    });

    test("select > include chains down the relation tree", async () => {
      const c = requireClient(client);
      await c.user.create({
        data: {
          id: "u1",
          name: "A",
          posts: { create: [{ id: "p1", title: "t" }] },
        },
      });

      const row = await c.user.findUnique({
        where: { id: "u1" },
        select: { id: true, posts: { include: { author: true } } },
      });
      expect(row).toMatchObject({
        id: "u1",
        posts: [{ id: "p1", author: { id: "u1", name: "A" } }],
      });
      expect(row && "name" in row).toBe(false);
    });

    test("nested select+include on the same node is rejected", async () => {
      const c = requireClient(client);
      await expect(
        c.user.findMany({
          include: {
            posts: { select: { id: true }, include: { author: true } },
          },
        })
      ).rejects.toThrow(MUTUALLY_EXCLUSIVE);
    });

    test("create with nested writes returns scalars only without include", async () => {
      const created = await requireClient(client).user.create({
        data: {
          id: "u1",
          name: "A",
          posts: { create: [{ id: "p1", title: "t" }] },
        },
      });
      expect(created).toEqual({ id: "u1", name: "A" });
      expect("posts" in created).toBe(false);
    });
  });
}
