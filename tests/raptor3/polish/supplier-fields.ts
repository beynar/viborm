import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

export const supplierFieldsScenario: ScenarioDefinition = {
  id: "g25-supplier-parent-fields",
  family: "C07",
  contracts: ["C03", "C04", "C05", "C07", "C10"],
  sources: [
    "tests/raptor3/transitions/supplier-continuations.ts",
    "tests/raptor3/transitions/keys.ts",
  ],
  prepare(controls) {
    const station = s
      .model({
        id: s.int().id(),
        count: s.int(),
        badge: s.toOne(() => badge),
        notes: s.toMany(() => note),
      })
      .map("g25_supplier_stations");
    const badge = s
      .model({
        id: s.int().id().increment(),
        tag: s.string().unique(),
        rank: s.int(),
        stationId: s.int().nullable().unique(),
        station: s
          .toOne(() => station)
          .fields("stationId")
          .references("id")
          .onUpdate("cascade"),
      })
      .map("g25_supplier_badges");
    const note = s
      .model({
        id: s.string().id(),
        stationId: s.int(),
        station: s
          .toOne(() => station)
          .fields("stationId")
          .references("id")
          .onUpdate("cascade"),
      })
      .map("g25_supplier_notes");
    const schema = { station, badge, note };
    const args = {
      where: { id: 1 },
      data: {
        id: { increment: 4 },
        count: { increment: 3 },
        badge: {
          connectOrCreate: {
            where: { tag: "Missing" },
            create: { tag: "minted", rank: 2 },
          },
          update: { rank: { increment: 3 } },
        },
        notes: { create: { id: "new-note" } },
      },
      select: { id: true, count: true },
    } as const;
    const initial = {
      stations: [
        { id: 1, count: 10 },
        { id: 9, count: 90 },
      ],
      badges: [{ id: 99, tag: "decoy", rank: 99, stationId: 9 }],
      notes: [{ id: "decoy-note", stationId: 9 }],
      sequences: [{ name: "g25_supplier_badges", seq: 140 }],
    };
    const prefix = {
      stations: [{ id: 5, count: 13 }, initial.stations[1]],
      badges: [
        ...initial.badges,
        { id: 141, tag: "minted", rank: 2, stationId: 5 },
      ],
      notes: initial.notes,
      sequences: [{ name: "g25_supplier_badges", seq: 141 }],
    };
    const final = {
      ...prefix,
      badges: [
        ...initial.badges,
        { id: 141, tag: "minted", rank: 5, stationId: 5 },
      ],
      notes: [...initial.notes, { id: "new-note", stationId: 5 }],
    };
    const inspect = (database: Database.Database) => ({
      stations: database
        .prepare("SELECT * FROM g25_supplier_stations ORDER BY id")
        .all(),
      badges: database
        .prepare("SELECT * FROM g25_supplier_badges ORDER BY id")
        .all(),
      notes: database
        .prepare("SELECT * FROM g25_supplier_notes ORDER BY id")
        .all(),
      sequences: database
        .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
        .all(),
    });
    const batch = controls.profile === "sqlite-atomic-batch";
    let prefixCommitted = false;
    return {
      publicInput: { model: "station", operation: "update", args },
      requiredCuts: batch ? ["parent-and-supplier-prefix-committed"] : [],
      seed(database) {
        database.exec(`
          CREATE TABLE g25_supplier_stations(id INTEGER PRIMARY KEY,count INTEGER NOT NULL);
          CREATE TABLE g25_supplier_badges(id INTEGER PRIMARY KEY AUTOINCREMENT,tag TEXT NOT NULL UNIQUE,rank INTEGER NOT NULL,stationId INTEGER UNIQUE REFERENCES g25_supplier_stations(id) ON UPDATE CASCADE);
          CREATE TABLE g25_supplier_notes(id TEXT PRIMARY KEY NOT NULL,stationId INTEGER NOT NULL REFERENCES g25_supplier_stations(id) ON UPDATE CASCADE);
          INSERT INTO g25_supplier_stations VALUES(1,10),(9,90);
          INSERT INTO g25_supplier_badges VALUES(99,'decoy',99,9);
          INSERT INTO g25_supplier_notes VALUES('decoy-note',9);
          UPDATE sqlite_sequence SET seq=140 WHERE name='g25_supplier_badges';
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "station",
            "update",
            args
          );
        return createClient({ schema, driver }).station.update(args);
      },
      inspect,
      afterTransaction(database, phase) {
        if (
          !batch ||
          prefixCommitted ||
          phase !== "commit" ||
          !isDeepStrictEqual(inspect(database), prefix)
        )
          return undefined;
        assert.equal(database.inTransaction, false);
        prefixCommitted = true;
        return "parent-and-supplier-prefix-committed";
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(
          observation.final,
          final,
          "The continuation and later sibling must retain the final parent fields across the supplier prefix"
        );
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(
          observation.reachedCuts,
          batch ? ["parent-and-supplier-prefix-committed"] : []
        );
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { id: 5, count: 13 },
        });
      },
    };
  },
};
