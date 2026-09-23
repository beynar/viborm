import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  "g2-supplier-coc-found-modify",
  "g2-supplier-coc-missing-modify",
  "g2-supplier-modifier-unique-failure",
  "g2-supplier-wrapper-filter-miss",
  "g2-supplier-untaken-upsert",
] as const;

/** Child-held singular membership supplies the continuation's selected identity. */
export const supplierContinuationScenarios: ScenarioDefinition[] = cases.map(
  (id) => ({
    id,
    family: "C07",
    contracts: ["C06", "C07", "C10"],
    sources: [
      "tests/contracts/engine/write/supplier-continuation-behavior.ts",
      "tests/contracts/engine/write/supplier-continuation.test.ts",
      "src/query-engine/write-engine/OperationExecutor.ts",
      "src/errors/record-series-progress.ts",
    ],
    prepare(controls) {
      const found = id === "g2-supplier-coc-found-modify";
      const missing = id === "g2-supplier-coc-missing-modify";
      const uniqueFailure = id === "g2-supplier-modifier-unique-failure";
      const filterMiss = id === "g2-supplier-wrapper-filter-miss";
      const untaken = id === "g2-supplier-untaken-upsert";
      const failed = uniqueFailure || filterMiss;
      const committedPrefix =
        failed && controls.profile === "sqlite-atomic-batch";
      const station = s
        .model({
          id: s.string().id(),
          label: s.string(),
          badge: s.toOne(() => badge),
        })
        .map("g2_supplier_stations");
      const badge = s
        .model({
          id: s.string().id(),
          tag: s.string(),
          rank: s.int().default(0),
          stationId: s.string().nullable().unique(),
          station: s
            .toOne(() => station)
            .fields("stationId")
            .references("id"),
        })
        .map("g2_supplier_badges");
      const schema = { station, badge };
      const mutation =
        found || missing
          ? {
              disconnect: true,
              connectOrCreate: {
                where: { id: found ? "b-alt" : "b-new" },
                create: {
                  id: found ? "b-alt" : "b-new",
                  tag: found ? "never-minted" : "minted",
                  rank: found ? 99 : 7,
                },
              },
              update: { rank: { increment: 3 } },
            }
          : uniqueFailure
            ? {
                disconnect: true,
                create: { id: "b-new", tag: "fresh", rank: 2 },
                update: { id: "b-alt" },
              }
            : {
                create: { id: "b-new", tag: "fresh", rank: 2 },
                update: { where: { tag: "other" }, data: { rank: 9 } },
              };
      const updateArgs = {
        where: { id: filterMiss ? "s2" : "s1" },
        data: { badge: mutation },
        select: { id: true, label: true },
      } as const;
      const upsertArgs = {
        where: { id: "s-absent" },
        create: { id: "s-absent", label: "N" },
        update: {
          badge: {
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: { rank: { increment: 3 } },
          },
        },
        select: { id: true, label: true },
      } as const;
      const initial = {
        stations: [
          { id: "s1", label: "L" },
          { id: "s2", label: "M" },
          { id: "s9", label: "untouched" },
        ],
        badges: [
          { id: "b-alt", tag: "alt", rank: 5, stationId: null },
          { id: "b-decoy", tag: "other", rank: 99, stationId: "s9" },
          { id: "b1", tag: "incumbent", rank: 1, stationId: "s1" },
        ],
      };
      const supplier = found
        ? { id: "b-alt", tag: "alt", rank: 5, stationId: "s1" }
        : {
            id: "b-new",
            tag: missing ? "minted" : "fresh",
            rank: missing ? 7 : 2,
            stationId: filterMiss ? "s2" : "s1",
          };
      const incumbent = filterMiss
        ? initial.badges[2]!
        : { id: "b1", tag: "incumbent", rank: 1, stationId: null };
      const prefix = {
        stations: initial.stations,
        badges: found
          ? [supplier, initial.badges[1]!, incumbent]
          : [initial.badges[0]!, initial.badges[1]!, supplier, incumbent],
      };
      const final = untaken
        ? {
            stations: [{ id: "s-absent", label: "N" }, ...initial.stations],
            badges: initial.badges,
          }
        : failed
          ? committedPrefix
            ? prefix
            : initial
          : {
              stations: initial.stations,
              badges: found
                ? [{ ...supplier, rank: 8 }, initial.badges[1]!, incumbent]
                : [
                    initial.badges[0]!,
                    initial.badges[1]!,
                    { ...supplier, rank: 10 },
                    incumbent,
                  ],
            };
      const inspect = (database: Database.Database) => ({
        stations: database
          .prepare("SELECT * FROM g2_supplier_stations ORDER BY id")
          .all(),
        badges: database
          .prepare("SELECT * FROM g2_supplier_badges ORDER BY id")
          .all(),
      });
      let supplierSeen = false;
      let prefixCommitted = false;
      const requiredCuts = untaken
        ? []
        : [
            "supplier-visible",
            ...(committedPrefix ? ["supplier-prefix-committed"] : []),
          ];
      return {
        publicInput: untaken
          ? { model: "station", operation: "upsert", args: upsertArgs }
          : { model: "station", operation: "update", args: updateArgs },
        requiredCuts,
        seed(database) {
          database.exec(`
          CREATE TABLE g2_supplier_stations(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL);
          CREATE TABLE g2_supplier_badges(id TEXT PRIMARY KEY NOT NULL,tag TEXT NOT NULL,rank INTEGER NOT NULL DEFAULT 0,stationId TEXT UNIQUE REFERENCES g2_supplier_stations(id));
          INSERT INTO g2_supplier_stations VALUES('s1','L'),('s2','M'),('s9','untouched');
          INSERT INTO g2_supplier_badges VALUES('b-alt','alt',5,NULL),('b-decoy','other',99,'s9'),('b1','incumbent',1,'s1');
        `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "station",
              untaken ? "upsert" : "update",
              untaken ? upsertArgs : updateArgs
            );
          const client = createClient({ schema, driver });
          return untaken
            ? client.station.upsert(upsertArgs)
            : client.station.update(updateArgs);
        },
        inspect,
        afterStatement(database) {
          const state = inspect(database);
          if (untaken) {
            assert.deepEqual(
              state.badges,
              initial.badges,
              "An untaken supplier or modifier must not write a badge"
            );
            return undefined;
          }
          // Native state, including the unmodified supplier rank, identifies this
          // cut. In particular the found arm cannot publish its unused rank 99.
          if (!supplierSeen && isDeepStrictEqual(state, prefix)) {
            supplierSeen = true;
            return "supplier-visible";
          }
          return undefined;
        },
        afterTransaction(database, phase) {
          if (committedPrefix && phase === "commit" && !prefixCommitted) {
            assert.equal(database.inTransaction, false);
            assert.deepEqual(
              inspect(database),
              prefix,
              "The supplier prefix is committed before its failing continuation"
            );
            assert(
              supplierSeen,
              "A committed supplier was never observed at the statement boundary"
            );
            prefixCommitted = true;
            return "supplier-prefix-committed";
          }
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            final,
            JSON.stringify(observation.outcome)
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, requiredCuts);
          if (!failed) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: untaken
                ? { id: "s-absent", label: "N" }
                : { id: "s1", label: "L" },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          const failure = observation.outcome.failure;
          assert.equal(
            failure.name,
            uniqueFailure ? "UniqueConstraintError" : "NestedWriteError"
          );
          assert.equal(failure.code, uniqueFailure ? "V3001" : "V7001");
          assert.equal(
            failure.message,
            uniqueFailure
              ? "Unique constraint violation"
              : "Cannot update relation 'badge': target record was not found for this parent."
          );
          assert(failure.meta !== null && typeof failure.meta === "object");
          if (uniqueFailure)
            assert.deepEqual(
              "columns" in failure.meta ? failure.meta.columns : undefined,
              ["g2_supplier_badges.id"],
              "The modifier must fail on the requested target key, not on supplier occupancy"
            );
          const progress =
            "recordSeriesProgress" in failure.meta
              ? failure.meta.recordSeriesProgress
              : undefined;
          // A capability-false native batch proves commitment by successful
          // return, not by an invented pre-result ACK. Its failed next segment
          // cannot erase or replay the already committed supplier.
          assert.deepEqual(
            progress,
            committedPrefix
              ? {
                  atomicity: "segment",
                  phase: uniqueFailure ? "member" : "capture",
                  committedSegments: 1,
                  completedMembers: 0,
                  committedWriteMembers: 1,
                  ...(uniqueFailure
                    ? { memberPath: [0], totalMembers: 1 }
                    : {}),
                }
              : undefined
          );
        },
      };
    },
  })
);
