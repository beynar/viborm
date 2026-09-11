import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

function junctionScenario(
  id:
    | "g2-junction-singular-transfer"
    | "g2-junction-supply-modify"
    | "g2-junction-set-owned-refill"
    | "g2-variant-junction-set-all"
    | "g2-junction-disconnect-shared"
    | "g2-junction-delete-shared"
    | "g2-junction-exact-reconnect"
    | "g2-junction-exact-set-refill"
    | "g2-junction-key-reconnect"
    | "g2-junction-key-transfer"
    | "g2-variant-junction-empty-set"
    | "g2-junction-inverse-delete-owner"
    | "g2-junction-inverse-disconnect"
): ScenarioDefinition {
  return {
    id,
    family: "C06",
    contracts: ["C06", "C07"],
    sources: [
      "tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts",
      "src/query-engine/write-engine/junction-singular-transfer.ts",
    ],
    prepare() {
      const book = s
        .model({
          region: s.string(),
          isbn: s.string(),
          title: s.string(),
          shelf: s.toOne(() => shelf),
        })
        .id(["region", "isbn"])
        .map("g2_j_books");
      const clip = s
        .model({
          id: s.int().id().increment(),
          label: s.string(),
          shelves: s.toMany(() => shelf),
        })
        .map("g2_j_clips");
      const note = s
        .model({ id: s.int().id(), body: s.string() })
        .map("g2_j_notes");
      const shelf = s
        .model({
          tenantId: s.string(),
          code: s.string(),
          label: s.string(),
          items: s
            .toMany(
              { book: () => book, clip: () => clip, note: () => note },
              {
                values: {
                  book: "entry.book.v1",
                  clip: "entry.clip.v1",
                  note: "entry.note.v1",
                },
              }
            )
            .through({
              book: {
                table: "g2_j_shelf_books",
                source: "holder",
                target: "entry",
              },
              clip: {
                table: "g2_j_shelf_clips",
                source: "holder",
                target: "entry",
              },
              note: {
                table: "g2_j_shelf_notes",
                source: "holder",
                target: "entry",
              },
            }),
        })
        .id(["tenantId", "code"])
        .map("g2_j_shelves");
      const schema = { shelf, book, clip, note };
      const transfer = id === "g2-junction-singular-transfer";
      const modify = id === "g2-junction-supply-modify";
      const setOwned = id === "g2-junction-set-owned-refill";
      const setAll = id === "g2-variant-junction-set-all";
      const disconnect = id === "g2-junction-disconnect-shared";
      const deletes = id === "g2-junction-delete-shared";
      const reconnect = id === "g2-junction-exact-reconnect";
      const exactSet = id === "g2-junction-exact-set-refill";
      const keyReconnect = id === "g2-junction-key-reconnect";
      const keyTransfer = id === "g2-junction-key-transfer";
      const movesKey = keyReconnect || keyTransfer;
      const emptySet = id === "g2-variant-junction-empty-set";
      const inverseDelete = id === "g2-junction-inverse-delete-owner";
      const inverseDisconnect = id === "g2-junction-inverse-disconnect";
      const updatesBook =
        modify || movesKey || inverseDelete || inverseDisconnect;
      const audit = reconnect || exactSet || keyReconnect;
      const bookTarget = {
        type: "book",
        where: { region_isbn: { region: "eu", isbn: "111" } },
      } as const;
      const noteTarget = { type: "note", where: { id: 11 } } as const;
      const items =
        transfer || reconnect
          ? { connect: [bookTarget] }
          : exactSet
            ? {
                set: [
                  bookTarget,
                  { type: "clip", where: { id: 11 } } as const,
                  noteTarget,
                ],
              }
            : setOwned
              ? { set: [bookTarget] }
              : setAll
                ? { set: [noteTarget] }
                : emptySet
                  ? { set: [] }
                  : disconnect
                    ? { disconnect: [noteTarget] }
                    : { delete: [noteTarget] };
      const shelfArgs = {
        where: {
          tenantId_code: { tenantId: "t1", code: transfer ? "right" : "left" },
        },
        data: { items },
        select: { tenantId: true, code: true, label: true },
      };
      const bookArgs = {
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: movesKey
          ? {
              isbn: "333",
              shelf: {
                connect: {
                  tenantId_code: {
                    tenantId: "t1",
                    code: keyTransfer ? "right" : "left",
                  },
                },
              },
            }
          : inverseDelete
            ? { shelf: { delete: true } }
            : inverseDisconnect
              ? { shelf: { disconnect: true } }
              : {
                  shelf: {
                    update: { label: "Supplied" },
                    connect: {
                      tenantId_code: { tenantId: "t1", code: "right" },
                    },
                    disconnect: true,
                  },
                },
        select: { region: true, isbn: true, title: true },
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
        clips: [
          { id: 11, label: "Shared clip" },
          { id: 12, label: "Untouched clip" },
        ],
        notes: [
          { id: 11, body: "Shared note" },
          { id: 12, body: "Untouched right" },
          { id: 13, body: "Untouched tenant" },
        ],
        bookMembers: [
          { holder_1: "t1", holder_2: "left", entry_1: "eu", entry_2: "111" },
          { holder_1: "t1", holder_2: "right", entry_1: "eu", entry_2: "222" },
          { holder_1: "t2", holder_2: "left", entry_1: "us", entry_2: "111" },
        ],
        clipMembers: [
          { holder_1: "t1", holder_2: "left", entry: 11 },
          { holder_1: "t1", holder_2: "right", entry: 11 },
          { holder_1: "t2", holder_2: "left", entry: 12 },
        ],
        noteMembers: [
          { holder_1: "t1", holder_2: "left", entry: 11 },
          { holder_1: "t1", holder_2: "right", entry: 11 },
          { holder_1: "t1", holder_2: "right", entry: 12 },
          { holder_1: "t2", holder_2: "left", entry: 13 },
        ],
        sequences: [{ name: "g2_j_clips", seq: 40 }],
        ...(audit ? { membershipAudit: [] } : {}),
      };
      const final = {
        shelves: modify
          ? [
              initial.shelves[0],
              { tenantId: "t1", code: "right", label: "Supplied" },
              initial.shelves[2],
            ]
          : inverseDelete
            ? initial.shelves.slice(1)
            : initial.shelves,
        books: movesKey
          ? [
              initial.books[1],
              { region: "eu", isbn: "333", title: "Exact" },
              initial.books[2],
            ]
          : initial.books,
        clips: initial.clips,
        notes: deletes ? [initial.notes[1], initial.notes[2]] : initial.notes,
        bookMembers: keyTransfer
          ? [
              initial.bookMembers[1],
              {
                holder_1: "t1",
                holder_2: "right",
                entry_1: "eu",
                entry_2: "333",
              },
              initial.bookMembers[2],
            ]
          : transfer || modify
            ? [
                {
                  holder_1: "t1",
                  holder_2: "right",
                  entry_1: "eu",
                  entry_2: "111",
                },
                initial.bookMembers[1],
                initial.bookMembers[2],
              ]
            : setAll || emptySet || inverseDelete || inverseDisconnect
              ? [initial.bookMembers[1], initial.bookMembers[2]]
              : keyReconnect
                ? [
                    { ...initial.bookMembers[0], entry_2: "333" },
                    initial.bookMembers[1],
                    initial.bookMembers[2],
                  ]
                : initial.bookMembers,
        clipMembers:
          setOwned || setAll || emptySet || inverseDelete
            ? [initial.clipMembers[1], initial.clipMembers[2]]
            : initial.clipMembers,
        noteMembers: deletes
          ? [initial.noteMembers[2], initial.noteMembers[3]]
          : setOwned || disconnect || emptySet || inverseDelete
            ? [
                initial.noteMembers[1],
                initial.noteMembers[2],
                initial.noteMembers[3],
              ]
            : initial.noteMembers,
        sequences: initial.sequences,
        ...(audit
          ? {
              membershipAudit: exactSet
                ? [
                    { seq: 1, effect: "delete", ...initial.bookMembers[0] },
                    { seq: 2, effect: "insert", ...initial.bookMembers[0] },
                  ]
                : keyReconnect
                  ? [
                      {
                        seq: 1,
                        effect: "update",
                        ...initial.bookMembers[0],
                        entry_2: "333",
                      },
                    ]
                  : [],
            }
          : {}),
      };
      return {
        publicInput: {
          model: updatesBook ? "book" : "shelf",
          operation: "update",
          args: updatesBook ? bookArgs : shelfArgs,
        },
        requiredCuts: [],
        seed(database) {
          // Book's singular inverse requires UNIQUE over its COMPLETE target tuple.
          // Clip/note remain plural; deleting a target cascades every owning link.
          database.exec(`
            CREATE TABLE g2_j_shelves(tenantId TEXT NOT NULL,code TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(tenantId,code));
            CREATE TABLE g2_j_books(region TEXT NOT NULL,isbn TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(region,isbn));
            CREATE TABLE g2_j_clips(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL);
            CREATE TABLE g2_j_notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
            CREATE TABLE g2_j_shelf_books(holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry_1 TEXT NOT NULL,entry_2 TEXT NOT NULL,PRIMARY KEY(holder_1,holder_2,entry_1,entry_2),UNIQUE(entry_1,entry_2),FOREIGN KEY(holder_1,holder_2) REFERENCES g2_j_shelves(tenantId,code) ON DELETE CASCADE ON UPDATE CASCADE,FOREIGN KEY(entry_1,entry_2) REFERENCES g2_j_books(region,isbn) ON DELETE CASCADE ON UPDATE CASCADE);
            CREATE TABLE g2_j_shelf_clips(holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry INTEGER NOT NULL,PRIMARY KEY(holder_1,holder_2,entry),FOREIGN KEY(holder_1,holder_2) REFERENCES g2_j_shelves(tenantId,code) ON DELETE CASCADE ON UPDATE CASCADE,FOREIGN KEY(entry) REFERENCES g2_j_clips(id) ON DELETE CASCADE ON UPDATE CASCADE);
            CREATE TABLE g2_j_shelf_notes(holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry INTEGER NOT NULL,PRIMARY KEY(holder_1,holder_2,entry),FOREIGN KEY(holder_1,holder_2) REFERENCES g2_j_shelves(tenantId,code) ON DELETE CASCADE ON UPDATE CASCADE,FOREIGN KEY(entry) REFERENCES g2_j_notes(id) ON DELETE CASCADE ON UPDATE CASCADE);
            INSERT INTO g2_j_shelves VALUES('t1','left','Left'),('t1','right','Right'),('t2','left','Crossed owner');
            INSERT INTO g2_j_books VALUES('eu','111','Exact'),('eu','222','Crossed ISBN'),('us','111','Crossed region');
            INSERT INTO g2_j_clips VALUES(11,'Shared clip'),(12,'Untouched clip');
            INSERT INTO g2_j_notes VALUES(11,'Shared note'),(12,'Untouched right'),(13,'Untouched tenant');
            INSERT INTO g2_j_shelf_books VALUES('t1','left','eu','111'),('t1','right','eu','222'),('t2','left','us','111');
            INSERT INTO g2_j_shelf_clips VALUES('t1','left',11),('t1','right',11),('t2','left',12);
            INSERT INTO g2_j_shelf_notes VALUES('t1','left',11),('t1','right',11),('t1','right',12),('t2','left',13);
            UPDATE sqlite_sequence SET seq=40 WHERE name='g2_j_clips';
          `);
          // Row-effect evidence: ignored INSERTs and zero-row DELETEs are not
          // observable here, so this audit does not prove zero attempted statements.
          if (audit)
            database.exec(`
              CREATE TABLE g2_j_membership_audit(
                seq INTEGER PRIMARY KEY, effect TEXT NOT NULL,
                holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,
                entry_1 TEXT NOT NULL,entry_2 TEXT NOT NULL
              );
              CREATE TRIGGER g2_j_audit_delete AFTER DELETE ON g2_j_shelf_books
              BEGIN
                INSERT INTO g2_j_membership_audit(effect,holder_1,holder_2,entry_1,entry_2)
                VALUES('delete',OLD.holder_1,OLD.holder_2,OLD.entry_1,OLD.entry_2);
              END;
              CREATE TRIGGER g2_j_audit_insert AFTER INSERT ON g2_j_shelf_books
              BEGIN
                INSERT INTO g2_j_membership_audit(effect,holder_1,holder_2,entry_1,entry_2)
                VALUES('insert',NEW.holder_1,NEW.holder_2,NEW.entry_1,NEW.entry_2);
              END;
              CREATE TRIGGER g2_j_audit_update AFTER UPDATE ON g2_j_shelf_books
              BEGIN
                INSERT INTO g2_j_membership_audit(effect,holder_1,holder_2,entry_1,entry_2)
                VALUES('update',NEW.holder_1,NEW.holder_2,NEW.entry_1,NEW.entry_2);
              END;
            `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              updatesBook ? "book" : "shelf",
              "update",
              updatesBook ? bookArgs : shelfArgs
            );
          const client = createClient({ schema, driver });
          // Only these fixture-owned dynamic argument unions cross the bridge;
          // actual public update methods continue to own all admission.
          const publicClient = client as unknown as {
            shelf: { update(args: typeof shelfArgs): Promise<unknown> };
            book: { update(args: typeof bookArgs): Promise<unknown> };
          };
          return updatesBook
            ? publicClient.book.update(bookArgs)
            : publicClient.shelf.update(shelfArgs);
        },
        inspect(database) {
          return {
            shelves: database
              .prepare("SELECT * FROM g2_j_shelves ORDER BY tenantId,code")
              .all(),
            books: database
              .prepare("SELECT * FROM g2_j_books ORDER BY region,isbn")
              .all(),
            clips: database
              .prepare("SELECT * FROM g2_j_clips ORDER BY id")
              .all(),
            notes: database
              .prepare("SELECT * FROM g2_j_notes ORDER BY id")
              .all(),
            bookMembers: database
              .prepare(
                "SELECT * FROM g2_j_shelf_books ORDER BY holder_1,holder_2,entry_1,entry_2"
              )
              .all(),
            clipMembers: database
              .prepare(
                "SELECT * FROM g2_j_shelf_clips ORDER BY holder_1,holder_2,entry"
              )
              .all(),
            noteMembers: database
              .prepare(
                "SELECT * FROM g2_j_shelf_notes ORDER BY holder_1,holder_2,entry"
              )
              .all(),
            sequences: database
              .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
              .all(),
            ...(audit
              ? {
                  membershipAudit: database
                    .prepare("SELECT * FROM g2_j_membership_audit ORDER BY seq")
                    .all(),
                }
              : {}),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            final,
            JSON.stringify(observation.outcome)
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: updatesBook
              ? {
                  region: "eu",
                  isbn: movesKey ? "333" : "111",
                  title: "Exact",
                }
              : {
                  tenantId: "t1",
                  code: transfer ? "right" : "left",
                  label: transfer ? "Right" : "Left",
                },
          });
        },
      };
    },
  };
}

export const junctionTransitionScenarios: ScenarioDefinition[] = [
  junctionScenario("g2-junction-singular-transfer"),
  junctionScenario("g2-junction-supply-modify"),
  junctionScenario("g2-junction-set-owned-refill"),
  junctionScenario("g2-variant-junction-set-all"),
  junctionScenario("g2-junction-disconnect-shared"),
  junctionScenario("g2-junction-delete-shared"),
  junctionScenario("g2-junction-exact-reconnect"),
  junctionScenario("g2-junction-exact-set-refill"),
  junctionScenario("g2-junction-key-reconnect"),
  junctionScenario("g2-junction-key-transfer"),
  junctionScenario("g2-variant-junction-empty-set"),
  junctionScenario("g2-junction-inverse-delete-owner"),
  // Public inverse disconnect contract: polymorphic-collection-write-behavior.ts
  // 637–655 preserves both endpoints; a later transfer cannot mask this removal.
  junctionScenario("g2-junction-inverse-disconnect"),
];
