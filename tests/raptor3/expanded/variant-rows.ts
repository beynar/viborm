import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g1-variant-row-create",
  "g1-variant-row-connect",
  "g1-variant-row-coc-found",
  "g1-variant-row-coc-missing",
  "g1-variant-row-upsert-found",
  "g1-variant-row-upsert-missing",
  "g1-variant-inverse-generated",
  "g1-variant-inverse-upsert-foreign",
] as const;

export const variantRowScenarios: ScenarioDefinition[] = cases.map((id) => ({
  id,
  family: "C02",
  contracts: ["C01", "C02", "C04"],
  sources: [
    "tests/contracts/drivers/behaviors/polymorphic-relation-behavior.ts",
    "tests/contracts/engine/write/polymorphic-write-family.test.ts",
    "tests/contracts/engine/write/depth-seam-behavior.ts",
  ],
  prepare() {
    const post = s
      .model({
        id: s.int().id().increment(),
        slug: s.string().unique(),
        title: s.string(),
        comments: s.toMany(() => comment).name("subject"),
      })
      .map("g1_vr_posts");
    const video = s
      .model({
        id: s.int().id().increment(),
        slug: s.string().unique(),
        title: s.string(),
      })
      .map("g1_vr_videos");
    const comment = s
      .model({
        id: s.int().id().increment(),
        body: s.string(),
        subject: s
          .toOne(
            { post: () => post, video: () => video },
            {
              values: { post: "content.post.v1", video: "content.video.v1" },
            }
          )
          .name("subject")
          .optional(),
      })
      .map("g1_vr_comments");
    const schema = { post, video, comment };
    const inverse = id === "g1-variant-inverse-generated";
    const foreignInverse = id === "g1-variant-inverse-upsert-foreign";
    const selected = id.includes("upsert") && !foreignInverse;
    const foundUpsert = id === "g1-variant-row-upsert-found";
    const videoCreate =
      id === "g1-variant-row-create" || id === "g1-variant-row-coc-missing";
    const postCreate = inverse || id === "g1-variant-row-upsert-missing";
    const subject =
      id === "g1-variant-row-create"
        ? {
            create: {
              type: "video",
              data: { slug: "fresh", title: "Created" },
            },
          }
        : id === "g1-variant-row-connect"
          ? { connect: { type: "post", where: { slug: "match" } } }
          : id === "g1-variant-row-coc-found"
            ? {
                connectOrCreate: {
                  type: "post",
                  where: { slug: "match" },
                  create: { slug: "unused", title: "Must not publish" },
                },
              }
            : id === "g1-variant-row-coc-missing"
              ? {
                  connectOrCreate: {
                    type: "video",
                    where: { slug: "absent" },
                    create: { slug: "fresh", title: "Created" },
                  },
                }
              : {
                  upsert: {
                    type: "post",
                    create: { slug: "fresh", title: "Created" },
                    update: { title: "Updated" },
                  },
                };
    const directArgs = {
      data: { id: 10, body: "Requested", subject },
      include: { subject: true },
    };
    const updateArgs = {
      where: { id: 10 },
      data: { subject },
      include: { subject: true },
    };
    const inverseArgs = {
      data: {
        slug: "fresh",
        title: "Created",
        comments: { create: [{ body: "First" }, { body: "Second" }] },
      },
      include: { comments: { orderBy: { id: "asc" } } },
    } as const;
    // The selector exists under video11, not post11. A different create key
    // cannot turn a foreign present arm into an absent arm (depth-seam contract).
    const inverseUpsertArgs = {
      where: { id: 11 },
      data: {
        comments: {
          upsert: {
            where: { id: 7 },
            create: { id: 42, body: "Must not create" },
            update: { body: "Must not update" },
          },
        },
      },
      select: { id: true, title: true },
    };
    const initial = {
      posts: [{ id: 11, slug: "match", title: "Post" }],
      videos: [{ id: 11, slug: "match", title: "Video decoy" }],
      comments: [
        {
          id: 7,
          body: "Untouched",
          subject_type: "content.video.v1",
          subject_id: 11,
        },
        ...(selected
          ? [
              {
                id: 10,
                body: "Selected",
                subject_type: foundUpsert ? "content.post.v1" : null,
                subject_id: foundUpsert ? 11 : null,
              },
            ]
          : []),
      ],
      sequences: [
        { name: "g1_vr_comments", seq: 60 },
        { name: "g1_vr_posts", seq: 40 },
        { name: "g1_vr_videos", seq: 50 },
      ],
    };
    const target = videoCreate
      ? { id: 51, slug: "fresh", title: "Created" }
      : postCreate
        ? { id: 41, slug: "fresh", title: "Created" }
        : { id: 11, slug: "match", title: foundUpsert ? "Updated" : "Post" };
    const newComments = inverse
      ? [
          {
            id: 61,
            body: "First",
            subject_type: "content.post.v1",
            subject_id: 41,
          },
          {
            id: 62,
            body: "Second",
            subject_type: "content.post.v1",
            subject_id: 41,
          },
        ]
      : [
          {
            id: 10,
            body: selected ? "Selected" : "Requested",
            subject_type: videoCreate ? "content.video.v1" : "content.post.v1",
            subject_id: target.id,
          },
        ];
    const final = {
      posts: postCreate
        ? [...initial.posts, target]
        : foundUpsert
          ? [target]
          : initial.posts,
      videos: videoCreate ? [...initial.videos, target] : initial.videos,
      comments: [initial.comments[0], ...newComments],
      sequences: [
        { name: "g1_vr_comments", seq: inverse ? 62 : 60 },
        { name: "g1_vr_posts", seq: postCreate ? 41 : 40 },
        { name: "g1_vr_videos", seq: videoCreate ? 51 : 50 },
      ],
    };
    const value = inverse
      ? {
          ...target,
          comments: [
            { id: 61, body: "First" },
            { id: 62, body: "Second" },
          ],
        }
      : {
          id: 10,
          body: selected ? "Selected" : "Requested",
          subject: { type: videoCreate ? "video" : "post", data: target },
        };
    return {
      publicInput: {
        model: inverse || foreignInverse ? "post" : "comment",
        operation: selected || foreignInverse ? "update" : "create",
        args: foreignInverse
          ? inverseUpsertArgs
          : inverse
            ? inverseArgs
            : selected
              ? updateArgs
              : directArgs,
      },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_vr_posts(id INTEGER PRIMARY KEY AUTOINCREMENT,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL);
          CREATE TABLE g1_vr_videos(id INTEGER PRIMARY KEY AUTOINCREMENT,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL);
          CREATE TABLE g1_vr_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,subject_type TEXT,subject_id INTEGER);
          INSERT INTO g1_vr_posts VALUES(11,'match','Post');
          INSERT INTO g1_vr_videos VALUES(11,'match','Video decoy');
          INSERT INTO g1_vr_comments VALUES(7,'Untouched','content.video.v1',11);
          UPDATE sqlite_sequence SET seq=40 WHERE name='g1_vr_posts';
          UPDATE sqlite_sequence SET seq=50 WHERE name='g1_vr_videos';
          UPDATE sqlite_sequence SET seq=60 WHERE name='g1_vr_comments';
        `);
        if (selected)
          database
            .prepare("INSERT INTO g1_vr_comments VALUES(10,'Selected',?,?)")
            .run(
              foundUpsert ? "content.post.v1" : null,
              foundUpsert ? 11 : null
            );
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            inverse || foreignInverse ? "post" : "comment",
            selected || foreignInverse ? "update" : "create",
            foreignInverse
              ? inverseUpsertArgs
              : inverse
                ? inverseArgs
                : selected
                  ? updateArgs
                  : directArgs
          );
        const client = createClient({ schema, driver });
        // Fixture-selected mutation unions enter the real public runtime boundary;
        // this bridge does not claim contextual typing for a dynamically built bag.
        const publicClient = client as unknown as {
          post: {
            create(args: typeof inverseArgs): Promise<unknown>;
            update(args: typeof inverseUpsertArgs): Promise<unknown>;
          };
          comment: {
            create(args: typeof directArgs): Promise<unknown>;
            update(args: typeof updateArgs): Promise<unknown>;
          };
        };
        if (foreignInverse) return publicClient.post.update(inverseUpsertArgs);
        if (inverse) return publicClient.post.create(inverseArgs);
        return selected
          ? publicClient.comment.update(updateArgs)
          : publicClient.comment.create(directArgs);
      },
      inspect(database) {
        return {
          posts: database
            .prepare("SELECT * FROM g1_vr_posts ORDER BY id")
            .all(),
          videos: database
            .prepare("SELECT * FROM g1_vr_videos ORDER BY id")
            .all(),
          comments: database
            .prepare("SELECT * FROM g1_vr_comments ORDER BY id")
            .all(),
          sequences: database
            .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, foreignInverse ? initial : final);
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        if (foreignInverse) {
          assert.deepEqual(observation.outcome, {
            kind: "failure",
            failure: {
              name: "NestedWriteError",
              code: "V7001",
              message:
                "Cannot upsert relation 'comments': target record was not found for this parent.",
              meta: Object.assign(Object.create(null), {
                relation: "comments",
              }),
            },
          });
          return;
        }
        assert.deepEqual(observation.outcome, { kind: "success", value });
      },
    };
  },
}));
