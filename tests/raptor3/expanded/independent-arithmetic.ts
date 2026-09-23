import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

export const independentArithmeticScenario: ScenarioDefinition = {
  id: "g1-literal-rebind-independent-arithmetic",
  family: "C03",
  contracts: ["C02", "C03"],
  sources: [
    "tests/contracts/engine/query/relation-key-update-legality-local-fk.test.ts",
  ],
  prepare() {
    const author = s
      .model({
        id: s.int().id(),
        name: s.string(),
        posts: s.toMany(() => post),
      })
      .map("g1_ia_authors");
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
      .map("g1_ia_posts");
    const schema = { author, post };
    const args = {
      where: { id: 10 },
      data: {
        score: { increment: 1 },
        authorId: { set: 2 },
        author: { update: { name: "Updated final" } },
      },
    };
    const initial = {
      authors: [
        { id: 1, name: "Original" },
        { id: 2, name: "Destination" },
        { id: 3, name: "Decoy" },
      ],
      posts: [
        { id: 10, title: "Stored", score: 0, authorId: 1 },
        { id: 20, title: "Untouched", score: 5, authorId: 3 },
      ],
    };
    const updated = { id: 10, title: "Stored", score: 1, authorId: 2 };
    return {
      publicInput: { model: "post", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_ia_authors(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
          CREATE TABLE g1_ia_posts(id INTEGER PRIMARY KEY,title TEXT NOT NULL,score INTEGER NOT NULL,authorId INTEGER REFERENCES g1_ia_authors(id) ON UPDATE CASCADE);
          INSERT INTO g1_ia_authors VALUES(1,'Original'),(2,'Destination'),(3,'Decoy');
          INSERT INTO g1_ia_posts VALUES(10,'Stored',0,1),(20,'Untouched',5,3);
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
          authors: database
            .prepare("SELECT * FROM g1_ia_authors ORDER BY id")
            .all(),
          posts: database
            .prepare("SELECT * FROM g1_ia_posts ORDER BY id")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, {
          authors: [
            initial.authors[0],
            { id: 2, name: "Updated final" },
            initial.authors[2],
          ],
          posts: [updated, initial.posts[1]],
        });
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: updated,
        });
      },
    };
  },
};
