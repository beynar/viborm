import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

function childHeldScenario(
  id:
    | "g2-child-disconnect-connect"
    | "g2-child-create-modify"
    | "g2-child-occupied-supply-modify"
    | "g2-child-delete-connect"
    | "g2-child-delete-connect-modify-refused"
): ScenarioDefinition {
  return {
    id,
    family: "C06",
    contracts: ["C06", "C07"],
    sources: [
      "tests/contracts/engine/write/vacate-then-supply-behavior.ts",
      "tests/contracts/engine/write/vacate-then-supply-pair-lattice.test.ts",
      "tests/contracts/engine/write/supplier-continuation-behavior.ts",
    ],
    prepare() {
      const producing = id === "g2-child-create-modify";
      const occupiedFailure = id === "g2-child-occupied-supply-modify";
      const deleting =
        id === "g2-child-delete-connect" ||
        id === "g2-child-delete-connect-modify-refused";
      const dependencyRefused = id === "g2-child-delete-connect-modify-refused";
      const station = s
        .model({
          id: s.string().id(),
          label: s.string(),
          badge: s.toOne(() => badge),
        })
        .map("g2_child_stations");
      const badge = s
        .model({
          id: s.string().id(),
          tag: s.string(),
          rank: s.int(),
          stationId: s.string().nullable().unique(),
          station: s
            .toOne(() => station)
            .fields("stationId")
            .references("id"),
        })
        .map("g2_badges");
      const schema = { station, badge };
      const relation = deleting
        ? {
            connect: { id: "b-alt" },
            delete: true,
            ...(dependencyRefused ? { update: { tag: "never" } } : {}),
          }
        : producing
          ? {
              // Deliberately not vacate-first spelling: the public composition owns order.
              update: { rank: { increment: 3 } },
              create: { id: "b-new", tag: "fresh", rank: 2 },
              disconnect: true,
            }
          : occupiedFailure
            ? { connect: { id: "b-alt" }, update: { tag: "moved" } }
            : { connect: { id: "b-alt" }, disconnect: true };
      const args = {
        where: { id: "s1" },
        data: { badge: relation },
        select: { id: true, label: true },
      };
      const initial = {
        stations: [
          { id: "s1", label: "selected" },
          { id: "s2", label: "decoy" },
        ],
        badges: [
          { id: "b-alt", tag: "alternate", rank: 5, stationId: null },
          { id: "b-decoy", tag: "untouched", rank: 9, stationId: "s2" },
          { id: "b1", tag: "incumbent", rank: 1, stationId: "s1" },
        ],
      };
      return {
        publicInput: { model: "station", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_child_stations(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL);
            CREATE TABLE g2_badges(id TEXT PRIMARY KEY NOT NULL,tag TEXT NOT NULL,rank INTEGER NOT NULL,stationId TEXT UNIQUE REFERENCES g2_child_stations(id));
            INSERT INTO g2_child_stations VALUES('s1','selected'),('s2','decoy');
            INSERT INTO g2_badges VALUES('b1','incumbent',1,'s1'),('b-alt','alternate',5,NULL),('b-decoy','untouched',9,'s2');
          `);
          if (producing)
            database.exec(`
            CREATE TRIGGER g2_supplied_rank BEFORE INSERT ON g2_badges
            WHEN NEW.id='b-new' AND NEW.rank<>2
            BEGIN SELECT RAISE(ABORT,'fixture: supplier must store rank 2 before modify'); END;
          `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "station",
              "update",
              args
            );
          // The fixture chooses a public mutation union at runtime. Admission still
          // belongs to the actual client method; this is not a contextual typing probe.
          const stationClient = createClient({ schema, driver })
            .station as unknown as {
            update(input: typeof args): Promise<unknown>;
          };
          return stationClient.update(args);
        },
        inspect(database) {
          return {
            stations: database
              .prepare("SELECT * FROM g2_child_stations ORDER BY id")
              .all(),
            badges: database
              .prepare("SELECT * FROM g2_badges ORDER BY id")
              .all(),
          };
        },
        afterStatement(database) {
          if (dependencyRefused)
            assert.deepEqual(
              database.prepare("SELECT * FROM g2_badges ORDER BY id").all(),
              initial.badges,
              "The dependent modifier must refuse before deletion or supplier adoption"
            );
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            occupiedFailure || dependencyRefused
              ? initial
              : {
                  stations: initial.stations,
                  badges: [
                    {
                      id: "b-alt",
                      tag: "alternate",
                      rank: 5,
                      stationId: producing ? null : "s1",
                    },
                    initial.badges[1],
                    ...(producing
                      ? [
                          {
                            id: "b-new",
                            tag: "fresh",
                            rank: 5,
                            stationId: "s1",
                          },
                        ]
                      : []),
                    ...(!deleting
                      ? [
                          {
                            id: "b1",
                            tag: "incumbent",
                            rank: 1,
                            stationId: null,
                          },
                        ]
                      : []),
                  ],
                },
            JSON.stringify(observation.outcome)
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (dependencyRefused) {
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind !== "failure") return;
            assert.equal(observation.outcome.failure.name, "NestedWriteError");
            assert.equal(observation.outcome.failure.code, "V7001");
            assert.equal(
              observation.outcome.failure.message,
              "Nested operation 'update' on relation 'badge' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
            );
            return;
          }
          if (occupiedFailure) {
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind !== "failure") return;
            assert.equal(
              observation.outcome.failure.name,
              "UniqueConstraintError"
            );
            assert.equal(observation.outcome.failure.code, "V3001");
            return;
          }
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { id: "s1", label: "selected" },
          });
        },
      };
    },
  };
}

function parentHeldScenario(
  id:
    | "g2-parent-delete-create"
    | "g2-parent-disconnect-connect"
    | "g2-parent-connect-modify"
    | "g2-parent-delete-connect-refused"
    | "g2-parent-create-modify-refused"
): ScenarioDefinition {
  return {
    id,
    family: "C06",
    contracts: ["C06", "C07"],
    sources: [
      "tests/contracts/engine/write/vacate-then-supply-parent-held-composed.test.ts",
      "tests/contracts/engine/write/vacate-then-supply-parent-held-refused.test.ts",
      "docs/content/docs/client/nested-writes.mdx",
    ],
    prepare() {
      const replacement = id === "g2-parent-delete-create";
      const modify = id === "g2-parent-connect-modify";
      const dependencyRefused = id === "g2-parent-delete-connect-refused";
      const validationRefused = id === "g2-parent-create-modify-refused";
      const refused = dependencyRefused || validationRefused;
      const depot = s
        .model({
          id: s.string().id(),
          note: s.string(),
          stations: s.toMany(() => station),
        })
        .map("g2_depots");
      const station = s
        .model({
          id: s.string().id(),
          label: s.string(),
          depotId: s.string().nullable(),
          depot: s
            .toOne(() => depot)
            .fields("depotId")
            .references("id"),
        })
        .map("g2_parent_stations");
      const schema = { station, depot };
      const relation = replacement
        ? { create: { id: "d-new", note: "fresh" }, delete: true }
        : modify
          ? { update: { note: "moved" }, connect: { id: "d-alt" } }
          : dependencyRefused
            ? { delete: true, connect: { id: "d-alt" } }
            : validationRefused
              ? {
                  create: { id: "d-new", note: "fresh" },
                  update: { note: "moved" },
                }
              : { connect: { id: "d-alt" }, disconnect: true };
      const args = {
        where: { id: "s1" },
        data: { depot: relation },
        select: { id: true, label: true, depotId: true },
      };
      const initial = {
        stations: [
          { id: "s1", label: "selected", depotId: "d1" },
          { id: "s2", label: "untouched", depotId: "d-decoy" },
        ],
        depots: [
          { id: "d-alt", note: "alternate" },
          { id: "d-decoy", note: "untouched" },
          { id: "d1", note: "incumbent" },
        ],
      };
      const inspect = (database: Database.Database) => ({
        stations: database
          .prepare("SELECT * FROM g2_parent_stations ORDER BY id")
          .all(),
        depots: database.prepare("SELECT * FROM g2_depots ORDER BY id").all(),
      });
      let completedStatements = 0;
      const selected = {
        id: "s1",
        label: "selected",
        depotId: replacement ? "d-new" : "d-alt",
      };
      return {
        publicInput: { model: "station", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_depots(id TEXT PRIMARY KEY NOT NULL,note TEXT NOT NULL);
            CREATE TABLE g2_parent_stations(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL,depotId TEXT REFERENCES g2_depots(id));
            INSERT INTO g2_depots VALUES('d1','incumbent'),('d-alt','alternate'),('d-decoy','untouched');
            INSERT INTO g2_parent_stations VALUES('s1','selected','d1'),('s2','untouched','d-decoy');
            CREATE TRIGGER g2_no_transient_null BEFORE UPDATE OF depotId ON g2_parent_stations
            WHEN OLD.depotId IS NOT NULL AND NEW.depotId IS NULL
            BEGIN SELECT RAISE(ABORT,'fixture: parent-held replacement must not publish NULL'); END;
          `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "station",
              "update",
              args
            );
          // Includes the intentionally unadmitted create+update pair; the bridge
          // delivers that exact fixture-owned input to real public validation.
          const stationClient = createClient({ schema, driver })
            .station as unknown as {
            update(input: typeof args): Promise<unknown>;
          };
          return stationClient.update(args);
        },
        inspect,
        afterStatement(database) {
          completedStatements++;
          if (refused)
            assert.deepEqual(
              inspect(database),
              initial,
              "refused composition must precede effects"
            );
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            refused
              ? initial
              : {
                  stations: [selected, initial.stations[1]],
                  depots: [
                    { id: "d-alt", note: modify ? "moved" : "alternate" },
                    initial.depots[1],
                    replacement
                      ? { id: "d-new", note: "fresh" }
                      : initial.depots[2],
                  ],
                },
            JSON.stringify(observation.outcome)
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!refused) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: selected,
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(
            observation.outcome.failure.name,
            validationRefused ? "ValidationError" : "NestedWriteError"
          );
          assert.equal(
            observation.outcome.failure.code,
            validationRefused ? "V4001" : "V7001"
          );
          assert.equal(
            observation.outcome.failure.message,
            validationRefused
              ? "Validation failed for update: Unsupported to-one operation combination: create, update"
              : "Nested operation 'connect' on relation 'depot' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
          );
          if (validationRefused)
            assert.equal(
              completedStatements,
              0,
              "public validation precedes provider work"
            );
        },
      };
    },
  };
}

export const singularTransitionScenarios: ScenarioDefinition[] = [
  childHeldScenario("g2-child-disconnect-connect"),
  parentHeldScenario("g2-parent-delete-create"),
  parentHeldScenario("g2-parent-disconnect-connect"),
  parentHeldScenario("g2-parent-connect-modify"),
  childHeldScenario("g2-child-create-modify"),
  childHeldScenario("g2-child-occupied-supply-modify"),
  childHeldScenario("g2-child-delete-connect"),
  childHeldScenario("g2-child-delete-connect-modify-refused"),
  parentHeldScenario("g2-parent-delete-connect-refused"),
  parentHeldScenario("g2-parent-create-modify-refused"),
];
