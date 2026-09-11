import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

function collectionOwnWriteScenario(
  id:
    | "g2-own-coc-set-distinct"
    | "g2-own-coc-set-same"
    | "g2-own-delete-create"
    | "g2-own-delete-update-refused"
    | "g2-own-set-create"
    | "g2-own-update-coc-refused"
): ScenarioDefinition {
  return {
    id,
    family: "C07",
    contracts: ["C06", "C07"],
    sources: [
      "tests/contracts/engine/write/own-write-linearization-behavior.ts",
      "src/validation/relations/update.ts",
    ],
    prepare() {
      const conditional =
        id === "g2-own-coc-set-distinct" || id === "g2-own-coc-set-same";
      const refused =
        id === "g2-own-coc-set-same" ||
        id === "g2-own-delete-update-refused" ||
        id === "g2-own-update-coc-refused";
      const setCreate = id === "g2-own-set-create";
      const updateConditional = id === "g2-own-update-coc-refused";
      const author = s
        .model({
          id: s.int().id(),
          email: s.string().unique(),
          name: s.string(),
          notes: s.toMany(() => note),
        })
        .map("g2_own_authors");
      const note = s
        .model({
          id: s.int().id(),
          body: s.string(),
          authorId: s.int().nullable(),
          author: s
            .toOne(() => author)
            .fields("authorId")
            .references("id"),
        })
        .map("g2_own_notes");
      const schema = { author, note };
      // Caller insertion order is deliberately not execution order. These public
      // to-many siblings are admitted together; the write contract orders them.
      const mutation = setCreate
        ? { create: [{ id: 901, body: "fresh-901" }], set: [{ id: 803 }] }
        : updateConditional
          ? {
              connectOrCreate: [
                { where: { id: 802 }, create: { id: 802, body: "never" } },
              ],
              update: [{ where: { id: 802 }, data: { body: "changed" } }],
            }
          : conditional
            ? {
                set: [{ id: refused ? 905 : 801 }],
                connectOrCreate: [
                  {
                    where: { id: 905 },
                    create: { id: 905, body: "adopted-905" },
                  },
                ],
              }
            : refused
              ? {
                  update: [{ where: { id: 801 }, data: { body: "never" } }],
                  delete: [{ id: 801 }],
                }
              : {
                  create: [{ id: 801, body: "reborn-801" }],
                  delete: [{ id: 801 }],
                };
      const args = {
        where: { id: 1 },
        data: { name: "root-effect", notes: mutation },
        select: { id: true, email: true, name: true },
      } as const;
      const initial = {
        authors: [
          { id: 1, email: "one@x", name: "one" },
          { id: 2, email: "two@x", name: "untouched" },
        ],
        notes: [
          { id: 801, body: "member-801", authorId: 1 },
          { id: 802, body: "member-802", authorId: 1 },
          { id: 803, body: "free-803", authorId: null },
          { id: 804, body: "member-804", authorId: 1 },
          { id: 899, body: "untouched", authorId: 2 },
        ],
      };
      const publicValue = { id: 1, email: "one@x", name: "root-effect" };
      const final = refused
        ? initial
        : {
            authors: [publicValue, initial.authors[1]!],
            notes: setCreate
              ? [
                  { ...initial.notes[0]!, authorId: null },
                  { ...initial.notes[1]!, authorId: null },
                  { ...initial.notes[2]!, authorId: 1 },
                  { ...initial.notes[3]!, authorId: null },
                  initial.notes[4]!,
                  { id: 901, body: "fresh-901", authorId: 1 },
                ]
              : conditional
                ? [
                    initial.notes[0]!,
                    { id: 802, body: "member-802", authorId: null },
                    initial.notes[2]!,
                    { id: 804, body: "member-804", authorId: null },
                    initial.notes[4]!,
                    { id: 905, body: "adopted-905", authorId: null },
                  ]
                : [
                    { id: 801, body: "reborn-801", authorId: 1 },
                    initial.notes[1]!,
                    initial.notes[2]!,
                    initial.notes[3]!,
                    initial.notes[4]!,
                  ],
          };
      const inspect = (database: Database.Database) => ({
        authors: database
          .prepare("SELECT * FROM g2_own_authors ORDER BY id")
          .all(),
        notes: database.prepare("SELECT * FROM g2_own_notes ORDER BY id").all(),
      });
      return {
        publicInput: { model: "author", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_own_authors(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL);
            CREATE TABLE g2_own_notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL,authorId INTEGER REFERENCES g2_own_authors(id));
            INSERT INTO g2_own_authors VALUES(1,'one@x','one'),(2,'two@x','untouched');
            INSERT INTO g2_own_notes VALUES(801,'member-801',1),(802,'member-802',1),(803,'free-803',NULL),(804,'member-804',1),(899,'untouched',2);
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
        inspect,
        afterStatement(database) {
          if (refused)
            assert.deepEqual(
              inspect(database),
              initial,
              "OwnWrite refusal must precede root and relation effects, not merely roll them back"
            );
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, final);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!refused) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: publicValue,
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(observation.outcome.failure.name, "NestedWriteError");
          assert.equal(observation.outcome.failure.code, "V7001");
          assert.equal(
            observation.outcome.failure.message,
            updateConditional
              ? "Nested operation 'connectOrCreate' on relation 'notes' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries."
              : conditional
                ? "Nested operation 'set' on relation 'notes' depends on an earlier 'connectOrCreate' target write in the same nested write. Split these operations into separate queries."
                : "Nested operation 'update' on relation 'notes' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
          );
        },
      };
    },
  };
}

function wrapperFilterScenario(
  id:
    | "g2-own-filter-write-refused"
    | "g2-own-coc-found-filter-order"
    | "g2-own-coc-missing-filter-order"
): ScenarioDefinition {
  return {
    id,
    family: "C07",
    contracts: ["C07"],
    sources: [
      "tests/contracts/engine/write/vacate-then-supply-pair-lattice.test.ts",
      "tests/contracts/engine/write/vacate-then-supply-behavior.ts",
      "tests/contracts/engine/write/supplier-continuation-behavior.ts",
    ],
    prepare() {
      const conditional = id !== "g2-own-filter-write-refused";
      const suppliedId =
        id === "g2-own-coc-missing-filter-order" ? "b-new" : "b-alt";
      const station = s
        .model({
          id: s.string().id(),
          label: s.string(),
          badge: s.toOne(() => badge),
        })
        .map("g2_own_stations");
      const badge = s
        .model({
          id: s.string().id(),
          tag: s.string(),
          stationId: s.string().nullable().unique(),
          station: s
            .toOne(() => station)
            .fields("stationId")
            .references("id"),
        })
        .map("g2_own_badges");
      const schema = { station, badge };
      const supply = conditional
        ? {
            connectOrCreate: {
              where: { id: suppliedId },
              create: { id: suppliedId, tag: "alt" },
            },
          }
        : { connect: { id: "b-alt" } };
      // Plain connect declares a planning filter read; COC continues after supply.
      // The latter's exact ordering beside the enclosing tag write is baseline-first.
      const args = {
        where: { id: "b1" },
        data: {
          tag: "root-writes-tag",
          station: {
            update: {
              badge: {
                ...supply,
                update: { where: { tag: "alt" }, data: { tag: "moved" } },
              },
            },
          },
        },
        select: { id: true, tag: true, stationId: true },
      } as const;
      const initial = {
        stations: [
          { id: "s1", label: "selected" },
          { id: "s2", label: "untouched" },
        ],
        badges: [
          { id: "b-alt", tag: "alt", stationId: null },
          { id: "b-decoy", tag: "untouched", stationId: "s2" },
          { id: "b1", tag: "incumbent", stationId: "s1" },
        ],
      };
      const inspect = (database: Database.Database) => ({
        stations: database
          .prepare("SELECT * FROM g2_own_stations ORDER BY id")
          .all(),
        badges: database
          .prepare("SELECT * FROM g2_own_badges ORDER BY id")
          .all(),
      });
      return {
        publicInput: { model: "badge", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_own_stations(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL);
          CREATE TABLE g2_own_badges(id TEXT PRIMARY KEY NOT NULL,tag TEXT NOT NULL,stationId TEXT UNIQUE REFERENCES g2_own_stations(id));
          INSERT INTO g2_own_stations VALUES('s1','selected'),('s2','untouched');
          INSERT INTO g2_own_badges VALUES('b1','incumbent','s1'),('b-alt','alt',NULL),('b-decoy','untouched','s2');
        `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "badge",
              "update",
              args
            );
          return createClient({ schema, driver }).badge.update(args);
        },
        inspect,
        afterStatement(database) {
          if (!conditional)
            assert.deepEqual(
              inspect(database),
              initial,
              "The filter dependency must refuse before the root tag write or supplier adoption"
            );
          return undefined;
        },
        assert(observation) {
          // COC reaches native uniqueness before its wrapper-filter continuation;
          // plain connect instead declares an early planning dependency.
          if (conditional) {
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind === "failure") {
              assert.equal(
                observation.outcome.failure.name,
                "UniqueConstraintError"
              );
              assert.equal(observation.outcome.failure.code, "V3001");
              assert.equal(
                observation.outcome.failure.message,
                "Unique constraint violation"
              );
            }
          }
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, initial);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (conditional) return;
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(observation.outcome.failure.name, "NestedWriteError");
          assert.equal(observation.outcome.failure.code, "V7001");
          assert.equal(
            observation.outcome.failure.message,
            "Nested operation 'update' on relation 'badge' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries."
          );
        },
      };
    },
  };
}

export const ownWriteScenarios = [
  collectionOwnWriteScenario("g2-own-coc-set-distinct"),
  collectionOwnWriteScenario("g2-own-coc-set-same"),
  collectionOwnWriteScenario("g2-own-delete-create"),
  collectionOwnWriteScenario("g2-own-delete-update-refused"),
  wrapperFilterScenario("g2-own-filter-write-refused"),
  collectionOwnWriteScenario("g2-own-set-create"),
  collectionOwnWriteScenario("g2-own-update-coc-refused"),
  wrapperFilterScenario("g2-own-coc-found-filter-order"),
  wrapperFilterScenario("g2-own-coc-missing-filter-order"),
];
