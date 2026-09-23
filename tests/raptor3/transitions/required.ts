import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import { G2_REQUIRED_CASE_IDS } from "../contracts";
import type { ScenarioDefinition } from "../harness/protocol";

function requiredMembership(
  id: (typeof G2_REQUIRED_CASE_IDS)[number]
): ScenarioDefinition {
  return {
    id,
    family: "C06",
    contracts: ["C05", "C06", "C13"],
    sources: [
      "tests/contracts/engine/write/post-transition-adopt-behavior.ts",
      "tests/contracts/engine/write/nested-mutation-behavior.ts",
      "tests/contracts/engine/write/shared-pk-supply-modify.test.ts",
    ],
    prepare() {
      const adopt = id === "g2-key-required-set";
      const depart = id === "g2-required-set-depart";
      const disconnect = id === "g2-required-disconnect-refused";
      const refused = depart || disconnect;
      const crate = s
        .model({
          id: s.int().id(),
          label: s.string(),
          boxes: s.toMany(() => box),
        })
        .map("g2_required_crates");
      const box = s
        .model({
          id: s.int().id(),
          tag: s.string(),
          crateId: s.int(),
          crate: s
            .toOne(() => crate)
            .fields("crateId")
            .references("id")
            .onUpdate("cascade"),
        })
        .map("g2_required_boxes");
      const schema = { crate, box };
      const setArgs = {
        where: { id: 1 },
        data: {
          ...(adopt ? { id: 5 } : {}),
          boxes: { set: depart ? [] : [{ id: adopt ? 100 : 10 }] },
        },
        select: { id: true, label: true },
      } as const;
      const disconnectArgs = {
        where: { id: 10 },
        data: { crate: { disconnect: true, connect: { id: 9 } } },
        select: { id: true, tag: true, crateId: true },
      } as const;
      const initial = {
        crates: [
          { id: 1, label: "selected" },
          { id: 9, label: "other" },
          { id: 99, label: "decoy" },
        ],
        boxes: [
          ...(!adopt ? [{ id: 10, tag: "retained", crateId: 1 }] : []),
          { id: 100, tag: "adoptable", crateId: 9 },
          { id: 900, tag: "untouched", crateId: 99 },
        ],
      };
      const expected = adopt
        ? {
            crates: [{ id: 5, label: "selected" }, ...initial.crates.slice(1)],
            boxes: [
              { id: 100, tag: "adoptable", crateId: 5 },
              initial.boxes[initial.boxes.length - 1],
            ],
          }
        : initial;
      const inspect = (database: Database.Database) => ({
        crates: database
          .prepare("SELECT * FROM g2_required_crates ORDER BY id")
          .all(),
        boxes: database
          .prepare("SELECT * FROM g2_required_boxes ORDER BY id")
          .all(),
      });
      let completedStatements = 0;
      return {
        publicInput: {
          model: disconnect ? "box" : "crate",
          operation: "update",
          args: disconnect ? disconnectArgs : setArgs,
        },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_required_crates(id INTEGER PRIMARY KEY NOT NULL,label TEXT NOT NULL);
            CREATE TABLE g2_required_boxes(id INTEGER PRIMARY KEY NOT NULL,tag TEXT NOT NULL,crateId INTEGER NOT NULL REFERENCES g2_required_crates(id) ON UPDATE CASCADE);
            INSERT INTO g2_required_crates VALUES(1,'selected'),(9,'other'),(99,'decoy');
            INSERT INTO g2_required_boxes VALUES(100,'adoptable',9),(900,'untouched',99);
          `);
          if (!adopt)
            database.exec(
              "INSERT INTO g2_required_boxes VALUES(10,'retained',1)"
            );
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              disconnect ? "box" : "crate",
              "update",
              disconnect ? disconnectArgs : setArgs
            );
          const db = createClient({ schema, driver });
          if (!disconnect) return db.crate.update(setArgs);
          // Intentionally unadmitted input still enters the real public validator.
          const publicBox = db.box as unknown as {
            update(input: typeof disconnectArgs): Promise<unknown>;
          };
          return publicBox.update(disconnectArgs);
        },
        inspect,
        afterStatement(database) {
          completedStatements++;
          if (refused)
            assert.deepEqual(
              inspect(database),
              initial,
              "A required-membership refusal must precede effects"
            );
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, expected);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!refused) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: { id: adopt ? 5 : 1, label: "selected" },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(
            observation.outcome.failure.name,
            disconnect ? "ValidationError" : "NestedWriteError"
          );
          assert.equal(
            observation.outcome.failure.code,
            disconnect ? "V4001" : "V7001"
          );
          assert.equal(
            observation.outcome.failure.message,
            disconnect
              ? "Validation failed for update: Unknown key: disconnect"
              : "Cannot set relation 'boxes' because foreign key field(s) crateId are required: rows removed from the set cannot be disconnected. Delete them instead."
          );
          if (disconnect) assert.equal(completedStatements, 0);
        },
      };
    },
  };
}

export const requiredMembershipScenarios =
  G2_REQUIRED_CASE_IDS.map(requiredMembership);
