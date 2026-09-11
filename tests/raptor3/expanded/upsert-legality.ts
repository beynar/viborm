import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import v from "@validation/primitives/v";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g1-upsert-illegal-update-selected",
  "g1-upsert-illegal-update-untaken",
  "g1-upsert-invalid-create-untaken",
  "g1-upsert-invalid-update-untaken",
  "g1-upsert-invalid-nested-update-untaken",
  "g1-upsert-nested-admission-publication",
] as const;

export const upsertLegalityScenarios: ScenarioDefinition[] = cases.map(
  (id) => ({
    id,
    family: "C02",
    contracts: ["C02", "C13"],
    sources: [
      "tests/contracts/engine/query/relation-key-update-legality-local-fk.test.ts",
      "tests/contracts/engine/write/upsert-untaken-arm-legality.test.ts",
      "tests/contracts/engine/write/produced-compound-identity.test.ts",
    ],
    prepare(controls) {
      const transformedUpdate = id === "g1-upsert-nested-admission-publication";
      let singleAdmission = false;
      let transforms = 0;
      const author = s
        .model({
          id: s.int().id(),
          name: transformedUpdate
            ? s.string().schema(
                v.string({
                  transform(value) {
                    const transformed = `${value}-${++transforms}`;
                    controls.recordDefault(
                      "author.name.transform",
                      transformed
                    );
                    return transformed;
                  },
                })
              )
            : s.string(),
          posts: s.toMany(() => post),
        })
        .map("g1_legality_authors");
      const post = s
        .model({
          id: s.int().id(),
          title: s.string(),
          score: s.int(),
          authorId: s.int().nullable(),
          author: s
            .toOne(() => author)
            .fields("authorId")
            .references("id")
            .onUpdate("cascade"),
        })
        .map("g1_legality_posts");
      const schema = { author, post };
      const invalidCreate = id === "g1-upsert-invalid-create-untaken";
      const invalidUpdate = id === "g1-upsert-invalid-update-untaken";
      const invalidNestedUpdate =
        id === "g1-upsert-invalid-nested-update-untaken";
      const found =
        id === "g1-upsert-illegal-update-selected" ||
        invalidCreate ||
        transformedUpdate;
      const admitted = id === "g1-upsert-illegal-update-untaken";
      const selectedId = found ? 10 : 99;
      const args = {
        where: { id: selectedId },
        create: {
          id: selectedId,
          title: invalidCreate ? 42 : "Created",
          score: 0,
          authorId: 1,
        },
        update: invalidNestedUpdate
          ? { author: { update: { name: 42 } } }
          : transformedUpdate
            ? { author: { update: { name: "Changed" } } }
            : invalidUpdate
              ? { title: 42 }
              : {
                  authorId: { increment: 1 },
                  author: { update: { name: "must not change" } },
                },
      };
      const initial = {
        authors: [
          { id: 1, name: "Original" },
          { id: 2, name: "Untouched" },
        ],
        posts: [
          { id: 10, title: "Stored", score: 0, authorId: 1 },
          { id: 20, title: "Decoy", score: 5, authorId: 2 },
        ],
      };
      const created = { id: 99, title: "Created", score: 0, authorId: 1 };
      let completedStatements = 0;
      return {
        publicInput: { model: "post", operation: "upsert", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g1_legality_authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          CREATE TABLE g1_legality_posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, score INTEGER NOT NULL, authorId INTEGER REFERENCES g1_legality_authors(id) ON UPDATE CASCADE);
          INSERT INTO g1_legality_authors VALUES (1,'Original'),(2,'Untouched');
          INSERT INTO g1_legality_posts VALUES (10,'Stored',0,1),(20,'Decoy',5,2);
        `);
        },
        async invoke(driver, candidateFactory) {
          singleAdmission = candidateFactory !== undefined;
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "post",
              "upsert",
              args
            );
          // Runtime admission must reject these deliberately wrong scalar types too.
          // @ts-expect-error — negative public-input witnesses include numeric string fields.
          return await createClient({ schema, driver }).post.upsert(args);
        },
        inspect(database) {
          return {
            authors: database
              .prepare("SELECT * FROM g1_legality_authors ORDER BY id")
              .all(),
            posts: database
              .prepare("SELECT * FROM g1_legality_posts ORDER BY id")
              .all(),
          };
        },
        afterStatement() {
          completedStatements += 1;
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            admitted
              ? { authors: initial.authors, posts: [...initial.posts, created] }
              : transformedUpdate
                ? {
                    authors: [{ id: 1, name: "Changed-1" }, initial.authors[1]],
                    posts: initial.posts,
                  }
                : initial
          );
          assert.deepEqual(
            observation.defaults,
            transformedUpdate
              ? [
                  // The approved candidate removes the discarded second admission;
                  // retain legacy's measured ledger and the same stored first value.
                  { name: "author.name.transform", value: "Changed-1" },
                  ...(!singleAdmission
                    ? [{ name: "author.name.transform", value: "Changed-2" }]
                    : []),
                ]
              : []
          );
          assert.deepEqual(observation.reachedCuts, []);
          if (transformedUpdate) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: initial.posts[0],
            });
            return;
          }
          if (admitted) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: created,
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          if (invalidCreate || invalidUpdate || invalidNestedUpdate) {
            assert.equal(
              completedStatements,
              0,
              "Invalid arm scalar input must fail before provider work"
            );
            assert.equal(observation.outcome.failure.name, "ValidationError");
            assert.match(
              observation.outcome.failure.message,
              /Expected string/
            );
            return;
          }
          assert.equal(observation.outcome.failure.name, "NestedWriteError");
          assert.equal(observation.outcome.failure.code, "V7001");
          assert.equal(
            observation.outcome.failure.message,
            "Cannot update relation key field 'authorId' with a non-literal operation while mutating relation 'author'. Use a literal value or '{ set: ... }'."
          );
        },
      };
    },
  })
);
