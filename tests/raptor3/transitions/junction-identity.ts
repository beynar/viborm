import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@client/client";
import { s } from "@schema";
import { isRecord } from "@validation/value-guards";
import type Database from "better-sqlite3";
import type { ScenarioDefinition, StateRows } from "../harness/protocol";

const cases = [
  "g2-junction-coc-captured-target-replaced",
  "g2-junction-coc-missing-create",
] as const;

/** A found COC's unique selector and captured compound identity must still agree. */
export const junctionIdentityScenarios: ScenarioDefinition[] = cases.map(
  (id) => ({
    id,
    family: "C06",
    contracts: ["C02", "C06"],
    sources: [
      "tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts",
      "tests/contracts/engine/write/polymorphic-write-family.test.ts",
      "tests/contracts/engine/write/to-one-update-family.test.ts",
    ],
    prepare(controls) {
      assert.equal(controls.profile, "sqlite-atomic-batch");
      const replaced = id === "g2-junction-coc-captured-target-replaced";
      const book = s
        .model({
          region: s.string(),
          isbn: s.string(),
          title: s.string().unique(),
          shelf: s.toOne(() => shelf),
        })
        .id(["region", "isbn"])
        .map("g2_identity_books");
      const note = s
        .model({ id: s.int().id(), body: s.string() })
        .map("g2_identity_notes");
      const shelf = s
        .model({
          tenantId: s.string(),
          code: s.string(),
          label: s.string(),
          items: s
            .toMany(
              { book: () => book, note: () => note },
              {
                values: { book: "entry.book.v1", note: "entry.note.v1" },
              }
            )
            .through({
              book: {
                table: "g2_identity_shelf_books",
                source: "holder",
                target: "entry",
              },
              note: {
                table: "g2_identity_shelf_notes",
                source: "holder",
                target: "entry",
              },
            }),
        })
        .id(["tenantId", "code"])
        .map("g2_identity_shelves");
      const schema = { shelf, book, note };
      const args = {
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            connectOrCreate: [
              {
                type: "book" as const,
                where: { title: replaced ? "Exact" : "Missing" },
                create: replaced
                  ? { region: "unused", isbn: "unused", title: "Never created" }
                  : { region: "eu", isbn: "444", title: "Missing" },
              },
            ],
          },
        },
        select: { tenantId: true, code: true, label: true },
      };
      const initial = {
        shelves: [
          { tenantId: "t1", code: "left", label: "Left" },
          { tenantId: "t1", code: "right", label: "Right" },
          { tenantId: "t2", code: "left", label: "Crossed owner" },
        ],
        books: [
          { region: "eu", isbn: "111", title: "Exact" },
          { region: "eu", isbn: "222", title: "Crossed ISBN" },
          { region: "us", isbn: "111", title: "Crossed region" },
        ],
        notes: [
          { id: 11, body: "Shared note" },
          { id: 12, body: "Other owner" },
        ],
        bookMembers: [
          { holder_1: "t1", holder_2: "left", entry_1: "eu", entry_2: "111" },
          { holder_1: "t1", holder_2: "right", entry_1: "eu", entry_2: "222" },
          { holder_1: "t2", holder_2: "left", entry_1: "us", entry_2: "111" },
        ],
        noteMembers: [
          { holder_1: "t1", holder_2: "left", entry: 11 },
          { holder_1: "t1", holder_2: "right", entry: 11 },
          { holder_1: "t2", holder_2: "left", entry: 12 },
        ],
      };
      const final = {
        ...initial,
        books: replaced
          ? [
              { region: "eu", isbn: "111", title: "Replacement" },
              initial.books[1],
              { region: "eu", isbn: "333", title: "Exact" },
              initial.books[2],
            ]
          : [
              initial.books[0],
              initial.books[1],
              { region: "eu", isbn: "444", title: "Missing" },
              initial.books[2],
            ],
        bookMembers: replaced
          ? [
              {
                holder_1: "t1",
                holder_2: "left",
                entry_1: "eu",
                entry_2: "333",
              },
              initial.bookMembers[1],
              initial.bookMembers[2],
            ]
          : [
              initial.bookMembers[0],
              initial.bookMembers[1],
              {
                holder_1: "t1",
                holder_2: "right",
                entry_1: "eu",
                entry_2: "444",
              },
              initial.bookMembers[2],
            ],
      };
      const inspect = (database: Database.Database) => ({
        shelves: database
          .prepare("SELECT * FROM g2_identity_shelves ORDER BY tenantId,code")
          .all(),
        books: database
          .prepare("SELECT * FROM g2_identity_books ORDER BY region,isbn")
          .all(),
        notes: database
          .prepare("SELECT * FROM g2_identity_notes ORDER BY id")
          .all(),
        bookMembers: database
          .prepare(
            "SELECT * FROM g2_identity_shelf_books ORDER BY holder_1,holder_2,entry_1,entry_2"
          )
          .all(),
        noteMembers: database
          .prepare(
            "SELECT * FROM g2_identity_shelf_notes ORDER BY holder_1,holder_2,entry"
          )
          .all(),
      });
      const cut = "coc-target-and-owner-captured";
      let targetCaptured = false;
      let ownerCaptured = false;
      let changed = false;
      let ownEffectObserved = false;
      let externalState: StateRows | undefined;
      const replaceCapturedTarget = (database: Database.Database) => {
        if (
          !replaced ||
          changed ||
          !targetCaptured ||
          !ownerCaptured ||
          database.inTransaction
        )
          return undefined;
        if (!isDeepStrictEqual(inspect(database), initial)) {
          ownEffectObserved = true;
          return undefined;
        }
        const moved = database
          .prepare(
            "UPDATE g2_identity_books SET isbn='333' WHERE region='eu' AND isbn='111' AND title='Exact'"
          )
          .run();
        assert.equal(
          moved.changes,
          1,
          "Fixture must move the exact captured book"
        );
        database
          .prepare("INSERT INTO g2_identity_books VALUES(?,?,?)")
          .run("eu", "111", "Replacement");
        changed = true;
        externalState = inspect(database);
        return cut;
      };
      return {
        publicInput: {
          model: "shelf",
          operation: "update",
          args,
          ...(replaced
            ? {
                externalMutation: {
                  after: cut,
                  move: {
                    region: "eu",
                    fromIsbn: "111",
                    toIsbn: "333",
                    title: "Exact",
                  },
                  insert: { region: "eu", isbn: "111", title: "Replacement" },
                },
              }
            : {}),
        },
        requiredCuts: replaced ? [cut] : [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_identity_shelves(tenantId TEXT NOT NULL,code TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(tenantId,code));
          CREATE TABLE g2_identity_books(region TEXT NOT NULL,isbn TEXT NOT NULL,title TEXT NOT NULL UNIQUE,PRIMARY KEY(region,isbn));
          CREATE TABLE g2_identity_notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
          CREATE TABLE g2_identity_shelf_books(
            holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry_1 TEXT NOT NULL,entry_2 TEXT NOT NULL,
            PRIMARY KEY(holder_1,holder_2,entry_1,entry_2),UNIQUE(entry_1,entry_2),
            FOREIGN KEY(holder_1,holder_2) REFERENCES g2_identity_shelves(tenantId,code) ON UPDATE CASCADE ON DELETE CASCADE,
            FOREIGN KEY(entry_1,entry_2) REFERENCES g2_identity_books(region,isbn) ON UPDATE CASCADE ON DELETE CASCADE
          );
          CREATE TABLE g2_identity_shelf_notes(
            holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry INTEGER NOT NULL,
            PRIMARY KEY(holder_1,holder_2,entry),
            FOREIGN KEY(holder_1,holder_2) REFERENCES g2_identity_shelves(tenantId,code) ON UPDATE CASCADE ON DELETE CASCADE,
            FOREIGN KEY(entry) REFERENCES g2_identity_notes(id) ON UPDATE CASCADE ON DELETE CASCADE
          );
          INSERT INTO g2_identity_shelves VALUES('t1','left','Left'),('t1','right','Right'),('t2','left','Crossed owner');
          INSERT INTO g2_identity_books VALUES('eu','111','Exact'),('eu','222','Crossed ISBN'),('us','111','Crossed region');
          INSERT INTO g2_identity_notes VALUES(11,'Shared note'),(12,'Other owner');
          INSERT INTO g2_identity_shelf_books VALUES('t1','left','eu','111'),('t1','right','eu','222'),('t2','left','us','111');
          INSERT INTO g2_identity_shelf_notes VALUES('t1','left',11),('t1','right',11),('t2','left',12);
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
          if (!replaced) return undefined;
          if (changed) {
            if (!isDeepStrictEqual(inspect(database), final))
              ownEffectObserved = true;
            return undefined;
          }
          // Exact row facts, not SQL spelling or statement order, identify both
          // captures. A wider projection or one response carrying both is valid.
          if (
            completion.parameters.includes("Exact") &&
            completion.rows.some(
              (row) =>
                isRecord(row) && row.region === "eu" && row.isbn === "111"
            )
          )
            targetCaptured = true;
          if (
            (completion.parameters.includes("Exact") ||
              (completion.parameters.includes("eu") &&
                completion.parameters.includes("111"))) &&
            completion.rows.some(
              (row) =>
                isRecord(row) &&
                row.holder_1 === "t1" &&
                row.holder_2 === "left"
            )
          )
            ownerCaptured = true;
          return completion.transactionOpen
            ? undefined
            : replaceCapturedTarget(database);
        },
        afterTransaction(database, phase) {
          return phase === "commit"
            ? replaceCapturedTarget(database)
            : undefined;
        },
        assert(observation) {
          if (replaced) {
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind === "failure") {
              const failure = observation.outcome.failure;
              assert.equal(failure.name, "NestedWriteError");
              assert.equal(failure.code, "V7001");
              assert.equal(
                failure.message,
                "Record was replaced by another transaction during nested connectOrCreate"
              );
              assert(isRecord(failure.meta));
              assert.equal(failure.meta.relation, "items.book");
              assert.notEqual(failure.meta.raceable, true);
            }
            assert.deepEqual(
              externalState,
              final,
              "The external move must preserve the original book and its cascaded owner link"
            );
            assert.equal(
              ownEffectObserved,
              false,
              "Target identity refusal must precede ORM effects, not merely roll them back"
            );
          } else {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: { tenantId: "t1", code: "right", label: "Right" },
            });
          }
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, final);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, replaced ? [cut] : []);
        },
      };
    },
  })
);
