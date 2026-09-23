import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g1-variant-junction-mixed-create-connect",
  "g1-variant-junction-coc-mixed",
  "g1-variant-junction-upsert-found",
  "g1-variant-junction-upsert-foreign-create",
  "g1-variant-junction-upsert-missing",
  "g1-variant-junction-connect-owned",
] as const;

export const variantJunctionScenarios: ScenarioDefinition[] = cases.map(
  (id) => ({
    id,
    family: "C02",
    contracts: ["C02", "C03", "C04"],
    sources: [
      "tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts",
      "tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior.ts",
      "tests/contracts/engine/write/depth-seam-behavior.ts",
    ],
    prepare() {
      const book = s
        .model({
          region: s.string(),
          isbn: s.string(),
          title: s.string(),
          shelves: s.toMany(() => shelf),
        })
        .id(["region", "isbn"])
        .map("g1_vj_books");
      const clip = s
        .model({
          id: s.int().id().increment(),
          label: s.string(),
          shelves: s.toMany(() => shelf),
        })
        .map("g1_vj_clips");
      const note = s
        .model({ id: s.int().id(), body: s.string() })
        .map("g1_vj_notes");
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
                table: "g1_vj_shelf_books",
                source: "holder",
                target: "entry",
              },
              clip: {
                table: "g1_vj_shelf_clips",
                source: "holder",
                target: "entry",
              },
              note: {
                table: "g1_vj_shelf_notes",
                source: "holder",
                target: "entry",
              },
            }),
        })
        .id(["tenantId", "code"])
        .map("g1_vj_shelves");
      const schema = { shelf, book, clip, note };
      const fresh = id === "g1-variant-junction-mixed-create-connect";
      const coc = id === "g1-variant-junction-coc-mixed";
      const found = id === "g1-variant-junction-upsert-found";
      const missing = id === "g1-variant-junction-upsert-missing";
      const foreign = id === "g1-variant-junction-upsert-foreign-create";
      const ownedConnect = id === "g1-variant-junction-connect-owned";
      const items = fresh
        ? {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
            create: [
              { type: "clip", data: { label: "Fresh clip" } },
              { type: "note", data: { id: 42, body: "Fresh note" } },
            ],
          }
        : coc
          ? {
              connectOrCreate: [
                {
                  type: "book",
                  where: { region_isbn: { region: "eu", isbn: "111" } },
                  create: {
                    region: "unused",
                    isbn: "unused",
                    title: "Must not publish",
                  },
                },
                {
                  type: "clip",
                  where: { id: 99 },
                  create: { label: "Fresh clip" },
                },
              ],
            }
          : ownedConnect
            ? {
                connect: [
                  {
                    type: "book",
                    where: { region_isbn: { region: "eu", isbn: "111" } },
                  },
                  {
                    type: "book",
                    where: { region_isbn: { region: "eu", isbn: "111" } },
                  },
                ],
              }
            : {
                upsert: [
                  {
                    type: "note",
                    where: { id: found ? 12 : missing ? 99 : 11 },
                    create: { id: 42, body: "Fresh note" },
                    update: { body: found ? "Changed" : "Must not publish" },
                  },
                ],
              };
      const select = { tenantId: true, code: true, label: true } as const;
      const createArgs = {
        data: { tenantId: "t1", code: "left", label: "Requested", items },
        select: { ...select, items: true },
      };
      const updateArgs = {
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items },
        select,
      };
      const initial = {
        shelves: [
          ...(!fresh
            ? [{ tenantId: "t1", code: "left", label: "Selected" }]
            : []),
          { tenantId: "t1", code: "right", label: "Foreign" },
          { tenantId: "t2", code: "left", label: "Crossed owner" },
        ],
        books: [
          { region: "eu", isbn: "111", title: "Exact" },
          { region: "eu", isbn: "222", title: "Crossed ISBN" },
          { region: "us", isbn: "111", title: "Crossed region" },
        ],
        clips: [{ id: 11, label: "Clip decoy" }],
        notes: [
          { id: 11, body: "Foreign note" },
          { id: 12, body: "Related note" },
        ],
        bookMembers: [
          ...(ownedConnect
            ? [
                {
                  holder_1: "t1",
                  holder_2: "left",
                  entry_1: "eu",
                  entry_2: "111",
                },
              ]
            : []),
          { holder_1: "t1", holder_2: "right", entry_1: "eu", entry_2: "222" },
        ],
        clipMembers: [{ holder_1: "t1", holder_2: "right", entry: 11 }],
        noteMembers: [
          ...(found ? [{ holder_1: "t1", holder_2: "left", entry: 12 }] : []),
          { holder_1: "t1", holder_2: "right", entry: 11 },
        ],
        sequences: [{ name: "g1_vj_clips", seq: 40 }],
      };
      const final = {
        shelves: fresh
          ? [
              { tenantId: "t1", code: "left", label: "Requested" },
              ...initial.shelves,
            ]
          : initial.shelves,
        books: initial.books,
        clips:
          fresh || coc
            ? [...initial.clips, { id: 41, label: "Fresh clip" }]
            : initial.clips,
        notes: found
          ? [initial.notes[0], { id: 12, body: "Changed" }]
          : coc || foreign || ownedConnect
            ? initial.notes
            : [...initial.notes, { id: 42, body: "Fresh note" }],
        bookMembers:
          fresh || coc
            ? [
                {
                  holder_1: "t1",
                  holder_2: "left",
                  entry_1: "eu",
                  entry_2: "111",
                },
                ...initial.bookMembers,
              ]
            : initial.bookMembers,
        clipMembers:
          fresh || coc
            ? [
                { holder_1: "t1", holder_2: "left", entry: 41 },
                ...initial.clipMembers,
              ]
            : initial.clipMembers,
        noteMembers:
          fresh || missing
            ? [
                { holder_1: "t1", holder_2: "left", entry: 42 },
                ...initial.noteMembers,
              ]
            : initial.noteMembers,
        sequences: [{ name: "g1_vj_clips", seq: fresh || coc ? 41 : 40 }],
      };
      return {
        publicInput: {
          model: "shelf",
          operation: fresh ? "create" : "update",
          args: fresh ? createArgs : updateArgs,
        },
        requiredCuts: [],
        seed(database) {
          // Compound through tokens expand to numbered components in declaration order.
          database.exec(`
          CREATE TABLE g1_vj_shelves(tenantId TEXT NOT NULL,code TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(tenantId,code));
          CREATE TABLE g1_vj_books(region TEXT NOT NULL,isbn TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(region,isbn));
          CREATE TABLE g1_vj_clips(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL);
          CREATE TABLE g1_vj_notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
          CREATE TABLE g1_vj_shelf_books(holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry_1 TEXT NOT NULL,entry_2 TEXT NOT NULL,PRIMARY KEY(holder_1,holder_2,entry_1,entry_2),FOREIGN KEY(holder_1,holder_2) REFERENCES g1_vj_shelves(tenantId,code),FOREIGN KEY(entry_1,entry_2) REFERENCES g1_vj_books(region,isbn));
          CREATE TABLE g1_vj_shelf_clips(holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry INTEGER NOT NULL,PRIMARY KEY(holder_1,holder_2,entry),FOREIGN KEY(holder_1,holder_2) REFERENCES g1_vj_shelves(tenantId,code),FOREIGN KEY(entry) REFERENCES g1_vj_clips(id));
          CREATE TABLE g1_vj_shelf_notes(holder_1 TEXT NOT NULL,holder_2 TEXT NOT NULL,entry INTEGER NOT NULL,PRIMARY KEY(holder_1,holder_2,entry),FOREIGN KEY(holder_1,holder_2) REFERENCES g1_vj_shelves(tenantId,code),FOREIGN KEY(entry) REFERENCES g1_vj_notes(id));
          INSERT INTO g1_vj_shelves VALUES('t1','right','Foreign'),('t2','left','Crossed owner');
          INSERT INTO g1_vj_books VALUES('eu','111','Exact'),('eu','222','Crossed ISBN'),('us','111','Crossed region');
          INSERT INTO g1_vj_clips VALUES(11,'Clip decoy');
          INSERT INTO g1_vj_notes VALUES(11,'Foreign note'),(12,'Related note');
          INSERT INTO g1_vj_shelf_books VALUES('t1','right','eu','222');
          INSERT INTO g1_vj_shelf_clips VALUES('t1','right',11);
          INSERT INTO g1_vj_shelf_notes VALUES('t1','right',11);
          UPDATE sqlite_sequence SET seq=40;
        `);
          if (!fresh)
            database.exec(
              "INSERT INTO g1_vj_shelves VALUES('t1','left','Selected');"
            );
          if (found)
            database.exec(
              "INSERT INTO g1_vj_shelf_notes VALUES('t1','left',12);"
            );
          if (ownedConnect)
            database.exec(
              "INSERT INTO g1_vj_shelf_books VALUES('t1','left','eu','111');"
            );
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "shelf",
              fresh ? "create" : "update",
              fresh ? createArgs : updateArgs
            );
          const client = createClient({ schema, driver });
          // Only the fixture's dynamically selected public argument bags cross this bridge.
          const publicShelf = client.shelf as unknown as {
            create(args: typeof createArgs): Promise<unknown>;
            update(args: typeof updateArgs): Promise<unknown>;
          };
          return fresh
            ? publicShelf.create(createArgs)
            : publicShelf.update(updateArgs);
        },
        inspect(database) {
          return {
            shelves: database
              .prepare("SELECT * FROM g1_vj_shelves ORDER BY tenantId,code")
              .all(),
            books: database
              .prepare("SELECT * FROM g1_vj_books ORDER BY region,isbn")
              .all(),
            clips: database
              .prepare("SELECT * FROM g1_vj_clips ORDER BY id")
              .all(),
            notes: database
              .prepare("SELECT * FROM g1_vj_notes ORDER BY id")
              .all(),
            bookMembers: database
              .prepare(
                "SELECT * FROM g1_vj_shelf_books ORDER BY holder_1,holder_2,entry_1,entry_2"
              )
              .all(),
            clipMembers: database
              .prepare(
                "SELECT * FROM g1_vj_shelf_clips ORDER BY holder_1,holder_2,entry"
              )
              .all(),
            noteMembers: database
              .prepare(
                "SELECT * FROM g1_vj_shelf_notes ORDER BY holder_1,holder_2,entry"
              )
              .all(),
            sequences: database
              .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
              .all(),
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
          if (foreign) {
            assert.deepEqual(observation.outcome, {
              kind: "failure",
              failure: {
                name: "NestedWriteError",
                code: "V7001",
                message:
                  "Cannot upsert relation 'items.note': target record was not found for this parent.",
                meta: Object.assign(Object.create(null), {
                  relation: "items.note",
                }),
              },
            });
            return;
          }
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: {
              tenantId: "t1",
              code: "left",
              label: fresh ? "Requested" : "Selected",
              ...(fresh
                ? {
                    items: [
                      {
                        type: "book",
                        data: { region: "eu", isbn: "111", title: "Exact" },
                      },
                      { type: "clip", data: { id: 41, label: "Fresh clip" } },
                      { type: "note", data: { id: 42, body: "Fresh note" } },
                    ],
                  }
                : {}),
            },
          });
        },
      };
    },
  })
);
