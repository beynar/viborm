import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { s } from "@schema";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * §9.4 moved this verdict EARLIER. An unnamed slot facing two competing
 * partners used to be a READ-time refusal — the engine reached the include and
 * could not choose a foreign key. The relation gate owns it now (R009), so the
 * schema never produces a client that could mis-read in the first place.
 */
const AMBIGUOUS_RELATION_PATTERN = /competing inverse candidates/;
const EMPTY_SELECT_PATTERN = /at least one truthy value/i;

// =============================================================================
// Schema 1: two named relations between the same models + mapped FK column
// + a string scalar holding JSON-looking content
// =============================================================================

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    authored: s.toMany(() => post).name("author"),
    edited: s.toMany(() => post).name("editor"),
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
      .toOne(() => user)
      .fields("authorId")
      .references("id")
      .name("author"),
    editor: s
      .toOne(() => user)
      .fields("editorId")
      .references("id")
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
    posts: s.toMany(() => ambiguousPost),
  })
  .map("read_path_amb_users");

const ambiguousPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    editorId: s.string().nullable(),
    author: s
      .toOne(() => ambiguousUser)
      .fields("authorId")
      .references("id"),
    editor: s
      .toOne(() => ambiguousUser)
      .fields("editorId")
      .references("id"),
  })
  .map("read_path_amb_posts");

const ambiguousSchema = { user: ambiguousUser, post: ambiguousPost };

// =============================================================================
// Schema 3: many-to-many where both models have mapped PK columns
// =============================================================================

const taggedPost = s
  .model({
    id: s.string().id().map("post_pk"),
    title: s.string(),
    tags: s
      .toMany(() => tag)
      .through("read_path_post_tags")
      .source("postId")
      .target("tagId"),
  })
  .map("read_path_mm_posts");

const tag = s
  .model({
    id: s.string().id().map("tag_pk"),
    name: s.string(),
    // §6.6/D2: ONE endpoint owns every junction override and the other reads
    // the mirrored view, so restating the same three names here is a second
    // owner (R011) rather than an agreement.
    posts: s.toMany(() => taggedPost),
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
    children: s.toMany(() => emptyProjectionChild),
  })
  .omit({ id: true })
  .map("read_path_empty_parents");

const emptyProjectionChild = s
  .model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .toOne(() => emptyProjectionParent)
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
 * 5. Nested cursor and nested negative take page the relation per parent
 *    instead of being ignored or mis-paginated.
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
        await syncLiveSchema(client);

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

      // Retargeted (W3-A unit 2): a nested cursor is honored per parent instead
      // of refused; a cursor naming no row still yields an empty window.
      test("nested cursor pages per parent instead of being ignored", async () => {
        const paged = await client.user.findUnique({
          where: { id: "u1" },
          include: {
            authored: { orderBy: { id: "asc" }, cursor: { id: "p1" } },
          },
        });
        expect(paged?.authored.map((p) => p.id)).toEqual(["p1"]);

        const missing = await client.user.findUnique({
          where: { id: "u1" },
          include: {
            authored: { orderBy: { id: "asc" }, cursor: { id: "nope" } },
          },
        });
        expect(missing?.authored).toEqual([]);
      });

      // Retargeted (W3-A unit 1): a nested negative take is no longer refused —
      // it pages backward and returns the window in logical order.
      test("nested negative take pages backward in logical order", async () => {
        await client.post.create({
          data: { id: "p3", title: "Alice again", authorId: "u1" },
        });
        await client.post.create({
          data: { id: "p4", title: "Alice once more", authorId: "u1" },
        });

        const alice = await client.user.findUnique({
          where: { id: "u1" },
          include: { authored: { orderBy: { id: "asc" }, take: -2 } },
        });
        expect(alice?.authored.map((p) => p.id)).toEqual(["p3", "p4"]);

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
        await syncLiveSchema(client);
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
      test("refuses the schema outright instead of picking the first FK", () => {
        // No push, no client: the refusal lands before anything effect-capable
        // exists, and it NAMES both competitors rather than reporting one
        // unreadable include.
        expect(() =>
          createClient({ schema: ambiguousSchema, driver: createDriver() })
        ).toThrow(AMBIGUOUS_RELATION_PATTERN);
      });
    });

    describe("many-to-many with mapped PK columns", () => {
      let client: ManyToManyClient;

      beforeEach(async () => {
        client = createClient({ schema: m2mSchema, driver: createDriver() });
        await syncLiveSchema(client);

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

export const readPathRegressionContract = defineContract({
  id: "drivers.read-path-regression",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runReadPathRegressionBehavior,
});
