import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

function junctionTransition(
  id: "g2-key-junction-modify" | "g2-key-junction-disconnect"
): ScenarioDefinition {
  return {
    id,
    family: "C05",
    contracts: ["C05", "C06"],
    sources: [
      "tests/contracts/engine/write/pk-transition-junction-mixed-edge.test.ts",
    ],
    prepare() {
      const disconnect = id === "g2-key-junction-disconnect";
      const author = s
        .model({
          id: s.string().id(),
          name: s.string(),
          posts: s.toMany(() => post),
        })
        .map("g2_mixed_authors");
      const post = s
        .model({
          id: s.string().id(),
          title: s.string(),
          slug: s.string().unique(),
          authorId: s.string(),
          author: s
            .toOne(() => author)
            .fields("authorId")
            .references("id"),
          comments: s.toMany(() => comment),
          tags: s
            .toMany(() => tag)
            .through("g2_mixed_post_tags")
            .source("postId")
            .target("tagId"),
        })
        .map("g2_mixed_posts");
      const comment = s
        .model({
          id: s.string().id(),
          body: s.string(),
          postId: s.string(),
          post: s
            .toOne(() => post)
            .fields("postId")
            .references("id"),
        })
        .map("g2_mixed_comments");
      const tag = s
        .model({
          id: s.string().id(),
          name: s.string(),
          posts: s.toMany(() => post),
        })
        .map("g2_mixed_tags");
      const schema = { author, post, comment, tag };
      const tags = disconnect
        ? { disconnect: { id: "t2" } }
        : { update: { where: { id: "t1" }, data: { name: "edited" } } };
      const args = {
        where: { id: "a1" },
        data: {
          posts: {
            update: {
              where: { id: "p1" },
              data: {
                id: "p9",
                tags,
                comments: { create: { id: "c1", body: "fresh" } },
              },
            },
          },
        },
        select: { id: true, name: true },
      } as const;
      const initial = {
        authors: [
          { id: "a1", name: "author" },
          { id: "a9", name: "decoy" },
        ],
        posts: [
          { id: "p-decoy", title: "decoy", slug: "decoy-slug", authorId: "a9" },
          { id: "p1", title: "target", slug: "target-slug", authorId: "a1" },
        ],
        comments: [{ id: "c-decoy", body: "decoy", postId: "p-decoy" }],
        tags: [
          { id: "t1", name: "shared" },
          { id: "t2", name: "second" },
        ],
        memberships: [
          { postId: "p-decoy", tagId: "t1" },
          { postId: "p1", tagId: "t1" },
          { postId: "p1", tagId: "t2" },
        ],
      };
      const final = {
        authors: initial.authors,
        posts: [
          initial.posts[0],
          { id: "p9", title: "target", slug: "target-slug", authorId: "a1" },
        ],
        comments: [
          ...initial.comments,
          { id: "c1", body: "fresh", postId: "p9" },
        ],
        tags: disconnect
          ? initial.tags
          : [{ id: "t1", name: "edited" }, initial.tags[1]],
        memberships: [
          { postId: "p-decoy", tagId: "t1" },
          { postId: "p9", tagId: "t1" },
          ...(disconnect ? [] : [{ postId: "p9", tagId: "t2" }]),
        ],
      };
      return {
        publicInput: { model: "author", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_mixed_authors(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);
            CREATE TABLE g2_mixed_posts(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,authorId TEXT NOT NULL REFERENCES g2_mixed_authors(id));
            CREATE TABLE g2_mixed_comments(id TEXT PRIMARY KEY NOT NULL,body TEXT NOT NULL,postId TEXT NOT NULL REFERENCES g2_mixed_posts(id) ON UPDATE NO ACTION);
            CREATE TABLE g2_mixed_tags(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);
            CREATE TABLE g2_mixed_post_tags(
              postId TEXT NOT NULL REFERENCES g2_mixed_posts(id) ON UPDATE CASCADE ON DELETE CASCADE,
              tagId TEXT NOT NULL REFERENCES g2_mixed_tags(id) ON UPDATE CASCADE ON DELETE CASCADE,
              PRIMARY KEY(postId,tagId)
            );
            INSERT INTO g2_mixed_authors VALUES('a1','author'),('a9','decoy');
            INSERT INTO g2_mixed_posts VALUES('p1','target','target-slug','a1'),('p-decoy','decoy','decoy-slug','a9');
            INSERT INTO g2_mixed_comments VALUES('c-decoy','decoy','p-decoy');
            INSERT INTO g2_mixed_tags VALUES('t1','shared'),('t2','second');
            INSERT INTO g2_mixed_post_tags VALUES('p1','t1'),('p1','t2'),('p-decoy','t1');
          `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "author",
              "update",
              args
            );
          return createClient({ schema, driver }).author.update(args);
        },
        inspect(database) {
          return {
            authors: database
              .prepare("SELECT * FROM g2_mixed_authors ORDER BY id")
              .all(),
            posts: database
              .prepare("SELECT * FROM g2_mixed_posts ORDER BY id")
              .all(),
            comments: database
              .prepare("SELECT * FROM g2_mixed_comments ORDER BY id")
              .all(),
            tags: database
              .prepare("SELECT * FROM g2_mixed_tags ORDER BY id")
              .all(),
            memberships: database
              .prepare("SELECT * FROM g2_mixed_post_tags ORDER BY postId,tagId")
              .all(),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { id: "a1", name: "author" },
          });
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            final,
            "Old membership selects the target; final identity owns the junction and non-cascade child writes"
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
        },
      };
    },
  };
}

const conditionalAdoption: ScenarioDefinition = {
  id: "g2-key-adopt-coc-mixed",
  family: "C05",
  contracts: ["C05", "C06"],
  sources: ["tests/contracts/engine/write/post-transition-adopt-behavior.ts"],
  prepare() {
    const list = s
      .model({
        id: s.int().id(),
        name: s.string().unique(),
        items: s.toMany(() => item),
      })
      .map("g2_adopt_lists");
    const item = s
      .model({
        id: s.int().id(),
        label: s.string(),
        listId: s.int().nullable(),
        list: s
          .toOne(() => list)
          .fields("listId")
          .references("id")
          .onUpdate("setNull"),
      })
      .map("g2_adopt_items");
    const schema = { list, item };
    const args = {
      where: { id: 1 },
      data: {
        id: 5,
        items: {
          connectOrCreate: [
            { where: { id: 20 }, create: { id: 20, label: "unused" } },
            { where: { id: 30 }, create: { id: 30, label: "fresh" } },
          ],
        },
      },
      select: { id: true, name: true },
    };
    const initial = {
      lists: [
        { id: 1, name: "target" },
        { id: 9, name: "decoy" },
      ],
      items: [
        { id: 10, label: "decoy", listId: 9 },
        { id: 20, label: "free", listId: null },
        { id: 40, label: "untouched-free", listId: null },
      ],
    };
    const final = {
      lists: [{ id: 5, name: "target" }, initial.lists[1]],
      items: [
        initial.items[0],
        { id: 20, label: "free", listId: 5 },
        { id: 30, label: "fresh", listId: 5 },
        initial.items[2],
      ],
    };
    return {
      publicInput: { model: "list", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g2_adopt_lists(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
          CREATE TABLE g2_adopt_items(id INTEGER PRIMARY KEY,label TEXT NOT NULL,listId INTEGER REFERENCES g2_adopt_lists(id) ON UPDATE SET NULL);
          INSERT INTO g2_adopt_lists VALUES(1,'target'),(9,'decoy');
          INSERT INTO g2_adopt_items VALUES(10,'decoy',9),(20,'free',NULL),(40,'untouched-free',NULL);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "list",
            "update",
            args
          );
        // The source behavior uses a routed-operation helper on some substrates;
        // this witness must establish the same answer through public admission.
        return createClient({ schema, driver }).list.update(args);
      },
      inspect(database) {
        return {
          lists: database
            .prepare("SELECT * FROM g2_adopt_lists ORDER BY id")
            .all(),
          items: database
            .prepare("SELECT * FROM g2_adopt_items ORDER BY id")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { id: 5, name: "target" },
        });
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(
          observation.final,
          final,
          "Both COC arms bind key5; the found row keeps its original label"
        );
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
      },
    };
  },
};

const variantTransition: ScenarioDefinition = {
  id: "g2-variant-key-transition",
  family: "C05",
  contracts: ["C05", "C06"],
  sources: ["tests/contracts/engine/write/polymorphic-write-family.test.ts"],
  prepare() {
    const post = s
      .model({
        id: s.int().id(),
        slug: s.string().unique(),
        title: s.string(),
        comments: s.toMany(() => comment).name("commentable"),
      })
      .map("g2_variant_move_posts");
    const video = s
      .model({
        id: s.int().id(),
        slug: s.string().unique(),
        title: s.string(),
      })
      .map("g2_variant_move_videos");
    const comment = s
      .model({
        id: s.int().id(),
        body: s.string(),
        commentable: s
          .toOne(
            { post: () => post, video: () => video },
            {
              values: { post: "content.post.v1", video: "content.video.v1" },
            }
          )
          .name("commentable")
          .optional(),
      })
      .map("g2_variant_move_comments");
    const schema = { post, video, comment };
    const args = {
      where: { id: 800 },
      data: {
        id: { increment: 1 },
        comments: {
          connect: { id: 802 },
          create: { id: 803, body: "create after transition" },
        },
      },
      select: { id: true, slug: true, title: true },
    };
    const initial = {
      posts: [
        { id: 800, slug: "transition-owner", title: "Transition" },
        { id: 900, slug: "other-owner", title: "Untouched post" },
      ],
      videos: [{ id: 800, slug: "same-id-video", title: "Untouched video" }],
      comments: [
        {
          id: 801,
          body: "old membership",
          commentable_type: "content.post.v1",
          commentable_id: 800,
        },
        {
          id: 802,
          body: "adopt after transition",
          commentable_type: null,
          commentable_id: null,
        },
        {
          id: 804,
          body: "wrong discriminator",
          commentable_type: "content.video.v1",
          commentable_id: 800,
        },
        {
          id: 905,
          body: "other owner",
          commentable_type: "content.post.v1",
          commentable_id: 900,
        },
      ],
    };
    const final = {
      posts: [
        { id: 801, slug: "transition-owner", title: "Transition" },
        initial.posts[1],
      ],
      videos: initial.videos,
      comments: [
        initial.comments[0],
        {
          id: 802,
          body: "adopt after transition",
          commentable_type: "content.post.v1",
          commentable_id: 801,
        },
        {
          id: 803,
          body: "create after transition",
          commentable_type: "content.post.v1",
          commentable_id: 801,
        },
        initial.comments[2],
        initial.comments[3],
      ],
    };
    return {
      publicInput: { model: "post", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        // Polymorphic carriers deliberately have no target FK: moving a post
        // must not invent a cascade for old members or same-ID video members.
        database.exec(`
          CREATE TABLE g2_variant_move_posts(id INTEGER PRIMARY KEY,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL);
          CREATE TABLE g2_variant_move_videos(id INTEGER PRIMARY KEY,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL);
          CREATE TABLE g2_variant_move_comments(
            id INTEGER PRIMARY KEY,body TEXT NOT NULL,commentable_type TEXT,commentable_id INTEGER,
            CHECK((commentable_type IS NULL AND commentable_id IS NULL) OR
              (commentable_type IS NOT NULL AND commentable_id IS NOT NULL)),
            CHECK(commentable_type IN ('content.post.v1','content.video.v1'))
          );
          INSERT INTO g2_variant_move_posts VALUES(800,'transition-owner','Transition'),(900,'other-owner','Untouched post');
          INSERT INTO g2_variant_move_videos VALUES(800,'same-id-video','Untouched video');
          INSERT INTO g2_variant_move_comments VALUES
            (801,'old membership','content.post.v1',800),
            (802,'adopt after transition',NULL,NULL),
            (804,'wrong discriminator','content.video.v1',800),
            (905,'other owner','content.post.v1',900);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "post",
            "update",
            args
          );
        return createClient({ schema, driver }).post.update(args);
      },
      inspect(database) {
        return {
          posts: database
            .prepare("SELECT * FROM g2_variant_move_posts ORDER BY id")
            .all(),
          videos: database
            .prepare("SELECT * FROM g2_variant_move_videos ORDER BY id")
            .all(),
          comments: database
            .prepare("SELECT * FROM g2_variant_move_comments ORDER BY id")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { id: 801, slug: "transition-owner", title: "Transition" },
        });
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(
          observation.final,
          final,
          "Old variant membership keeps key800; supplied members take801 with the exact stored discriminator"
        );
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
      },
    };
  },
};

export const mixedKeyTransitionScenarios: ScenarioDefinition[] = [
  junctionTransition("g2-key-junction-modify"),
  junctionTransition("g2-key-junction-disconnect"),
  conditionalAdoption,
  variantTransition,
];
