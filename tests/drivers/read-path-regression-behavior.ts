import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const AMBIGUOUS_RELATION_PATTERN = /Ambiguous relation .*\.name\(\)/s;
const CURSOR_PATTERN = /cursor/;
const EMPTY_SELECT_PATTERN = /at least one truthy value/i;
const TAKE_PATTERN = /take/i;

// =============================================================================
// Schema 1: two named relations between the same models + mapped FK column
// + a string scalar holding JSON-looking content
// =============================================================================

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    authored: s.oneToMany(() => post).name("author"),
    edited: s.oneToMany(() => post).name("editor"),
  })
  .map("read_path_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    notes: s.string().nullable(),
    authorId: s.string().nullable(),
    editorId: s.string().nullable().map("editor_fk"),
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
  })
  .map("read_path_posts");

const schema = { user, post };

type NamedClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};
type NamedClient = VibORMClient<NamedClientConfig>;

// =============================================================================
// Schema 2: same shape but WITHOUT .name() - ambiguous inverse lookup
// =============================================================================

const ambiguousUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => ambiguousPost),
  })
  .map("read_path_amb_users");

const ambiguousPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    editorId: s.string().nullable(),
    author: s
      .manyToOne(() => ambiguousUser)
      .fields("authorId")
      .references("id"),
    editor: s
      .manyToOne(() => ambiguousUser)
      .fields("editorId")
      .references("id")
      .optional(),
  })
  .map("read_path_amb_posts");

const ambiguousSchema = { user: ambiguousUser, post: ambiguousPost };

type AmbiguousClientConfig = VibORMConfig & {
  schema: typeof ambiguousSchema;
  driver: AnyDriver;
};
type AmbiguousClient = VibORMClient<AmbiguousClientConfig>;

// =============================================================================
// Schema 3: many-to-many where both models have mapped PK columns
// =============================================================================

const taggedPost = s
  .model({
    id: s.string().id().map("post_pk"),
    title: s.string(),
    tags: s
      .manyToMany(() => tag)
      .through("read_path_post_tags")
      .A("postId")
      .B("tagId"),
  })
  .map("read_path_mm_posts");

const tag = s
  .model({
    id: s.string().id().map("tag_pk"),
    name: s.string(),
    posts: s
      .manyToMany(() => taggedPost)
      .through("read_path_post_tags")
      .A("tagId")
      .B("postId"),
  })
  .map("read_path_mm_tags");

const m2mSchema = { post: taggedPost, tag };

type ManyToManyClientConfig = VibORMConfig & {
  schema: typeof m2mSchema;
  driver: AnyDriver;
};
type ManyToManyClient = VibORMClient<ManyToManyClientConfig>;

// =============================================================================
// Schema 4: default projections with every scalar omitted
// =============================================================================

const emptyProjectionParent = s
  .model({
    id: s.string().id(),
    children: s.oneToMany(() => emptyProjectionChild),
  })
  .omit({ id: true })
  .map("read_path_empty_parents");

const emptyProjectionChild = s
  .model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .manyToOne(() => emptyProjectionParent)
      .fields("parentId")
      .references("id"),
  })
  .omit({ id: true, parentId: true })
  .map("read_path_empty_children");

const emptyProjectionSchema = {
  parent: emptyProjectionParent,
  child: emptyProjectionChild,
};

type EmptyProjectionClientConfig = VibORMConfig & {
  schema: typeof emptyProjectionSchema;
  driver: AnyDriver;
};
type EmptyProjectionClient = VibORMClient<EmptyProjectionClientConfig>;

export interface ReadPathRegressionBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Execution-backed regressions for silent-wrong-result read-path bugs:
 * 1. Ambiguous inverse relations must resolve by .name() (or throw), never
 *    fall back to the first match and correlate on the wrong FK.
 * 2. Relation is/isNot null must respect .map()-ed FK columns.
 * 3. Many-to-many joins must respect .map()-ed PK columns.
 * 4. String scalars containing JSON-looking text must round-trip as strings.
 * 5. Nested cursor / negative take must be rejected, not silently ignored.
 */
export function runReadPathRegressionBehavior({
  driverName,
  createDriver,
}: ReadPathRegressionBehaviorOptions) {
  describe(`${driverName} read-path regression behavior`, () => {
    describe("named inverse relations", () => {
      let client: NamedClient;

      beforeEach(async () => {
        client = createClient({ schema, driver: createDriver() });
        await push(client, { force: true });

        await client.user.create({ data: { id: "u1", name: "Alice" } });
        await client.user.create({ data: { id: "u2", name: "Bob" } });
        await client.post.create({
          data: {
            id: "p1",
            title: "Alice writes, Bob edits",
            notes: '{"sneaky": true}',
            authorId: "u1",
            editorId: "u2",
          },
        });
        await client.post.create({
          data: {
            id: "p2",
            title: "Bob writes, nobody edits",
            notes: "[1,2,3]",
            authorId: "u2",
            editorId: null,
          },
        });
      });

      afterEach(async () => {
        await client.$disconnect();
      });

      test("include correlates each named relation on its own FK", async () => {
        const users = await client.user.findMany({
          orderBy: { id: "asc" },
          include: { authored: true, edited: true },
        });

        expect(users.map((u) => u.authored.map((p) => p.id).sort())).toEqual([
          ["p1"],
          ["p2"],
        ]);
        expect(users.map((u) => u.edited.map((p) => p.id).sort())).toEqual([
          [],
          ["p1"],
        ]);
      });

      test("relation filter correlates each named relation on its own FK", async () => {
        const editors = await client.user.findMany({
          where: { edited: { some: { id: "p1" } } },
        });
        expect(editors.map((u) => u.id)).toEqual(["u2"]);
      });

      test("nested create through named relation writes the matching FK", async () => {
        await client.user.create({
          data: {
            id: "u3",
            name: "Cara",
            edited: {
              create: { id: "p3", title: "Cara edits", authorId: "u1" },
            },
          },
        });

        const created = await client.post.findUnique({ where: { id: "p3" } });
        expect(created?.authorId).toBe("u1");
        expect(created?.editorId).toBe("u3");
      });

      test("is null / isNot null respect the mapped FK column", async () => {
        const unedited = await client.post.findMany({
          where: { editor: { is: null } },
        });
        expect(unedited.map((p) => p.id)).toEqual(["p2"]);

        const edited = await client.post.findMany({
          where: { editor: { isNot: null } },
        });
        expect(edited.map((p) => p.id)).toEqual(["p1"]);
      });

      test("string scalars holding JSON-looking text round-trip as strings", async () => {
        const posts = await client.post.findMany({ orderBy: { id: "asc" } });
        expect(posts.map((p) => p.notes)).toEqual([
          '{"sneaky": true}',
          "[1,2,3]",
        ]);

        const withAuthored = await client.user.findUnique({
          where: { id: "u1" },
          include: { authored: true },
        });
        expect(withAuthored?.authored[0]?.notes).toBe('{"sneaky": true}');
      });

      test("groupBy returns mapped scalars under their public names", async () => {
        const groups = await client.post.groupBy({
          by: "editorId",
          where: { editorId: { not: null } },
          _count: true,
        });

        expect(groups).toEqual([{ editorId: "u2", _count: 1 }]);
      });

      test("nested cursor is rejected instead of silently ignored", async () => {
        // `cursor` is also rejected at the type level; cast to reach the runtime guard
        const invalidInclude = { authored: { cursor: { id: "p1" } } } as never;
        await expect(
          client.user.findMany({ include: invalidInclude })
        ).rejects.toThrow(CURSOR_PATTERN);
      });

      test("nested negative take is rejected instead of mis-paginating", async () => {
        await expect(
          client.user.findMany({
            include: { authored: { take: -1 } },
          })
        ).rejects.toThrow(TAKE_PATTERN);

        const limited = await client.user.findUnique({
          where: { id: "u2" },
          include: { edited: { take: 1 } },
        });
        expect(limited?.edited).toHaveLength(1);
      });
    });

    describe("empty default projections", () => {
      let client: EmptyProjectionClient;

      beforeEach(async () => {
        client = createClient({
          schema: emptyProjectionSchema,
          driver: createDriver(),
        });
        await push(client, { force: true });
        await client.parent.createMany({
          data: [{ id: "parent-1" }, { id: "parent-2" }],
        });
        await client.child.createMany({
          data: [
            { id: "child-1", parentId: "parent-1" },
            { id: "child-2", parentId: "parent-1" },
          ],
        });
      });

      afterEach(async () => {
        await client.$disconnect();
      });

      test("preserves root and nested row cardinality", async () => {
        const roots = await client.parent.findMany({ orderBy: { id: "asc" } });
        expect(roots).toEqual([{}, {}]);

        const nested = await client.parent.findMany({
          orderBy: { id: "asc" },
          include: { children: { orderBy: { id: "asc" } } },
        });
        expect(nested).toEqual([{ children: [{}, {}] }, { children: [] }]);
      });

      test("still rejects an explicit empty select", async () => {
        await expect(client.parent.findMany({ select: {} })).rejects.toThrow(
          EMPTY_SELECT_PATTERN
        );
      });

      test("returns an empty public object from a live nested create", async () => {
        const created = await client.parent.create({
          data: {
            id: "parent-3",
            children: {
              create: [{ id: "child-3" }, { id: "child-4" }],
            },
          },
        });

        expect(created).toEqual({});
        const persisted = await client.parent.findUnique({
          where: { id: "parent-3" },
          include: { children: true },
        });
        expect(persisted).toEqual({ children: [{}, {}] });
      });
    });

    describe("ambiguous unnamed inverse relations", () => {
      let client: AmbiguousClient;

      beforeEach(async () => {
        client = createClient({
          schema: ambiguousSchema,
          driver: createDriver(),
        });
        await push(client, { force: true });
        await client.user.create({ data: { id: "u1" } });
      });

      afterEach(async () => {
        await client.$disconnect();
      });

      test("include throws a descriptive error instead of picking the first FK", async () => {
        await expect(
          client.user.findMany({ include: { posts: true } })
        ).rejects.toThrow(AMBIGUOUS_RELATION_PATTERN);
      });
    });

    describe("many-to-many with mapped PK columns", () => {
      let client: ManyToManyClient;

      beforeEach(async () => {
        client = createClient({ schema: m2mSchema, driver: createDriver() });
        await push(client, { force: true });

        await client.post.create({ data: { id: "p1", title: "Tagged" } });
        await client.post.create({ data: { id: "p2", title: "Untagged" } });
        await client.tag.create({ data: { id: "t1", name: "orm" } });
        // Escape identifiers through the adapter so the seed runs on every
        // dialect (MySQL rejects double-quoted identifiers)
        const ident = client.$driver.adapter.identifiers.escape;
        await client.$executeRaw(
          sql`INSERT INTO ${ident("read_path_post_tags")} (${ident(
            "postId"
          )}, ${ident("tagId")}) VALUES (${"p1"}, ${"t1"})`
        );
      });

      afterEach(async () => {
        await client.$disconnect();
      });

      test("include resolves junction join through mapped PK columns", async () => {
        const posts = await client.post.findMany({
          orderBy: { id: "asc" },
          include: { tags: true },
        });
        expect(posts.map((p) => p.tags.map((t) => t.name))).toEqual([
          ["orm"],
          [],
        ]);
      });

      test("relation filter resolves junction join through mapped PK columns", async () => {
        const tagged = await client.post.findMany({
          where: { tags: { some: { name: "orm" } } },
        });
        expect(tagged.map((p) => p.id)).toEqual(["p1"]);
      });
    });
  });
}
