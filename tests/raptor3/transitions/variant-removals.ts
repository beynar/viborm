import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g2-variant-inverse-set-removal",
  "g2-variant-inverse-delete-owned",
  "g2-variant-inverse-delete-wrong-type",
  "g2-variant-direct-disconnect",
  "g2-variant-required-set-retain",
  "g2-variant-required-set-depart",
  "g2-variant-required-disconnect-refused",
] as const;

/** The inverse membership is the stored discriminator AND its referenced ID. */
export const variantRemovalScenarios: ScenarioDefinition[] = cases.map(
  (id) => ({
    id,
    family: "C06",
    contracts: ["C01", "C06", "C13"],
    sources: [
      "tests/contracts/engine/write/polymorphic-write-family.test.ts",
      "src/validation/relations/update.ts",
      "src/query-engine/write-engine/relation-nullability.ts",
    ],
    prepare() {
      const required = id.startsWith("g2-variant-required-");
      const set = id === "g2-variant-inverse-set-removal";
      const deletes = id === "g2-variant-inverse-delete-owned";
      const wrongType = id === "g2-variant-inverse-delete-wrong-type";
      const direct = id === "g2-variant-direct-disconnect";
      const depart = id === "g2-variant-required-set-depart";
      const disconnect = id === "g2-variant-required-disconnect-refused";
      const refused = wrongType || depart || disconnect;
      const postType = required ? "required.post.v1" : "content.post.v1";
      const videoType = required ? "required.video.v1" : "content.video.v1";
      const post = s
        .model({
          id: s.int().id(),
          title: s.string(),
          comments: s.toMany(() => comment).name("subject"),
        })
        .map("g2_removal_posts");
      const video = s
        .model({ id: s.int().id(), title: s.string() })
        .map("g2_removal_videos");
      const subject = s
        .toOne(
          { post: () => post, video: () => video },
          { values: { post: postType, video: videoType } }
        )
        .name("subject");
      const comment = s
        .model({
          id: s.int().id(),
          body: s.string(),
          subject: required ? subject : subject.optional(),
        })
        .map("g2_removal_comments");
      const schema = { post, video, comment };
      const initial = {
        posts: [
          { id: 400, title: "Selected" },
          { id: 401, title: "Other owner" },
          { id: 499, title: "Untouched post" },
        ],
        videos: [
          { id: 400, title: "Same referenced ID, different variant" },
          { id: 499, title: "Untouched video" },
        ],
        comments: [
          {
            id: 410,
            body: "retained",
            subject_type: postType,
            subject_id: 400,
          },
          {
            id: 411,
            body: "departing",
            subject_type: postType,
            subject_id: 400,
          },
          { id: 412, body: "adopted", subject_type: postType, subject_id: 401 },
          {
            id: 413,
            body: "wrong type",
            subject_type: videoType,
            subject_id: 400,
          },
          {
            id: 419,
            body: "untouched",
            subject_type: postType,
            subject_id: 499,
          },
        ],
      };
      const mutation = set
        ? { set: [{ id: 410 }, { id: 412 }] }
        : deletes || wrongType
          ? { delete: { id: wrongType ? 413 : 410 } }
          : disconnect
            ? { disconnect: { id: 410 } }
            : { set: depart ? [{ id: 410 }] : [{ id: 410 }, { id: 411 }] };
      const inverseArgs = {
        where: { id: 400 },
        data: { comments: mutation },
        select: { id: true, title: true },
      } as const;
      const directArgs = {
        where: { id: 410 },
        data: { subject: { disconnect: true } },
        select: { id: true, body: true },
      } as const;
      const final = {
        posts: initial.posts,
        videos: initial.videos,
        comments: deletes
          ? initial.comments.slice(1)
          : set
            ? [
                initial.comments[0],
                {
                  ...initial.comments[1],
                  subject_type: null,
                  subject_id: null,
                },
                {
                  ...initial.comments[2],
                  subject_type: postType,
                  subject_id: 400,
                },
                initial.comments[3],
                initial.comments[4],
              ]
            : direct
              ? [
                  {
                    ...initial.comments[0],
                    subject_type: null,
                    subject_id: null,
                  },
                  ...initial.comments.slice(1),
                ]
              : initial.comments,
      };
      const inspect = (database: Database.Database) => ({
        posts: database
          .prepare("SELECT * FROM g2_removal_posts ORDER BY id")
          .all(),
        videos: database
          .prepare("SELECT * FROM g2_removal_videos ORDER BY id")
          .all(),
        comments: database
          .prepare("SELECT * FROM g2_removal_comments ORDER BY id")
          .all(),
      });
      let completedStatements = 0;
      return {
        publicInput: {
          model: direct ? "comment" : "post",
          operation: "update",
          args: direct ? directArgs : inverseArgs,
        },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_removal_posts(id INTEGER PRIMARY KEY NOT NULL,title TEXT NOT NULL);
          CREATE TABLE g2_removal_videos(id INTEGER PRIMARY KEY NOT NULL,title TEXT NOT NULL);
          CREATE TABLE g2_removal_comments(
            id INTEGER PRIMARY KEY NOT NULL, body TEXT NOT NULL,
            subject_type TEXT ${required ? "NOT NULL" : ""},
            subject_id INTEGER ${required ? "NOT NULL" : ""},
            CHECK (
              (subject_type IS NULL AND subject_id IS NULL)
              OR (subject_type IS NOT NULL AND subject_id IS NOT NULL
                AND subject_type IN ('${postType}','${videoType}'))
            )
          );
        `);
          for (const row of initial.posts)
            database
              .prepare("INSERT INTO g2_removal_posts VALUES (?,?)")
              .run(row.id, row.title);
          for (const row of initial.videos)
            database
              .prepare("INSERT INTO g2_removal_videos VALUES (?,?)")
              .run(row.id, row.title);
          for (const row of initial.comments)
            database
              .prepare("INSERT INTO g2_removal_comments VALUES (?,?,?,?)")
              .run(row.id, row.body, row.subject_type, row.subject_id);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              direct ? "comment" : "post",
              "update",
              direct ? directArgs : inverseArgs
            );
          // Optionality varies only between these fixed worlds. The bridge does
          // not bypass public admission, including the required-disconnect refusal.
          const client = createClient({ schema, driver }) as unknown as {
            post: { update(args: typeof inverseArgs): Promise<unknown> };
            comment: { update(args: typeof directArgs): Promise<unknown> };
          };
          return direct
            ? client.comment.update(directArgs)
            : client.post.update(inverseArgs);
        },
        inspect,
        afterStatement(database) {
          completedStatements++;
          if (refused)
            assert.deepEqual(
              inspect(database),
              initial,
              "variant-removal: refusal precedes all effects"
            );
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            final,
            "variant-removal: exact discriminator and complete clear"
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!refused) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: direct
                ? { id: 410, body: "retained" }
                : { id: 400, title: "Selected" },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(
            observation.outcome.failure.name,
            disconnect ? "ValidationError" : "NestedWriteError"
          );
          assert.equal(
            observation.outcome.failure.code,
            disconnect ? "V4001" : "V7001"
          );
          assert.equal(
            observation.outcome.failure.message,
            disconnect
              ? "Validation failed for update: Unknown key: disconnect"
              : wrongType
                ? "Cannot delete relation 'comments': target record was not found for this parent."
                : "Cannot set relation 'comments' because foreign key field(s) subject_type, subject_id are required: rows removed from the set cannot be disconnected. Delete them instead."
          );
          if (disconnect)
            assert.equal(
              completedStatements,
              0,
              "Required inverse disconnect is refused by public admission"
            );
        },
      };
    },
  })
);
