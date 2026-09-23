import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { isRecord } from "@validation/value-guards";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

export const missingLookupScenario: ScenarioDefinition = {
  id: "g25-junction-coc-missing-reobserved",
  family: "C06",
  contracts: ["C02", "C05", "C06"],
  sources: ["tests/raptor3/transitions/junction-identity.ts"],
  prepare(controls) {
    assert.equal(controls.profile, "sqlite-atomic-batch");
    const book = s
      .model({
        id: s.int().id(),
        title: s.string().unique(),
        shelf: s.toOne(() => shelf),
      })
      .map("g25_timing_books");
    const shelf = s
      .model({
        id: s.int().id(),
        label: s.string(),
        items: s
          .toMany({ book: () => book }, { values: { book: "book.v1" } })
          .through({
            book: {
              table: "g25_timing_members",
              source: "holder",
              target: "entry",
            },
          }),
      })
      .map("g25_timing_shelves");
    const schema = { shelf, book };
    const args = {
      where: { id: 1 },
      data: {
        items: {
          connectOrCreate: {
            type: "book",
            where: { title: "Missing" },
            create: { id: 55, title: "Different create branch" },
          },
        },
      },
      select: { id: true, label: true },
    } as const;
    const initial = {
      shelves: [
        { id: 1, label: "selected" },
        { id: 9, label: "other" },
      ],
      books: [{ id: 99, title: "other book" }],
      members: [{ holder: 9, entry: 99 }],
    };
    const external = {
      ...initial,
      books: [{ id: 44, title: "Missing" }, ...initial.books],
    };
    const final = {
      ...external,
      members: [{ holder: 1, entry: 44 }, ...initial.members],
    };
    const inspect = (database: Database.Database) => ({
      shelves: database
        .prepare("SELECT * FROM g25_timing_shelves ORDER BY id")
        .all(),
      books: database
        .prepare("SELECT * FROM g25_timing_books ORDER BY id")
        .all(),
      members: database
        .prepare("SELECT * FROM g25_timing_members ORDER BY holder,entry")
        .all(),
    });
    let inserted = false;
    let reobserved = false;
    return {
      publicInput: {
        model: "shelf",
        operation: "update",
        args,
        externalMutation: {
          after: "empty target lookup before ORM effects",
          insert: { id: 44, title: "Missing" },
        },
      },
      requiredCuts: [
        "missing-target-peer-inserted",
        "missing-target-reobserved",
      ],
      seed(database) {
        database.exec(`
          CREATE TABLE g25_timing_shelves(id INTEGER PRIMARY KEY,label TEXT NOT NULL);
          CREATE TABLE g25_timing_books(id INTEGER PRIMARY KEY,title TEXT NOT NULL UNIQUE);
          CREATE TABLE g25_timing_members(holder INTEGER NOT NULL REFERENCES g25_timing_shelves(id),entry INTEGER NOT NULL UNIQUE REFERENCES g25_timing_books(id),PRIMARY KEY(holder,entry));
          INSERT INTO g25_timing_shelves VALUES(1,'selected'),(9,'other');
          INSERT INTO g25_timing_books VALUES(99,'other book');
          INSERT INTO g25_timing_members VALUES(9,99);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "shelf",
            "update",
            args
          );
        return createClient({ schema, driver }).shelf.update(args);
      },
      inspect,
      afterStatement(database, completion) {
        if (
          !inserted &&
          completion.parameters.includes("Missing") &&
          completion.rows.length === 0
        ) {
          assert.equal(
            database.inTransaction,
            false,
            "The peer insert must precede the atomic effect transaction"
          );
          assert.deepEqual(
            inspect(database),
            initial,
            "The absence observation must precede ORM effects"
          );
          database
            .prepare("INSERT INTO g25_timing_books VALUES(?,?)")
            .run(44, "Missing");
          inserted = true;
          assert.deepEqual(inspect(database), external);
          return "missing-target-peer-inserted";
        }
        if (
          inserted &&
          !reobserved &&
          completion.parameters.includes("Missing") &&
          completion.rows.some((row) => isRecord(row) && row.id === 44n)
        ) {
          reobserved = true;
          return "missing-target-reobserved";
        }
        return undefined;
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(
          observation.final,
          final,
          "A missing pre-effect observation must not freeze the create arm"
        );
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, [
          "missing-target-peer-inserted",
          "missing-target-reobserved",
        ]);
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { id: 1, label: "selected" },
        });
      },
    };
  },
};
