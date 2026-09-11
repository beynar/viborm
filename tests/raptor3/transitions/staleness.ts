import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

function capturedKeyScenario(
  id:
    | "g2-key-captured-missing-decoy"
    | "g2-key-captured-replaced"
    | "g2-key-captured-restored"
): ScenarioDefinition {
  return {
    id,
    family: "C05",
    contracts: ["C05"],
    sources: [
      "tests/contracts/engine/write/compiled-key-transition-behavior.ts",
      "tests/contracts/engine/write/staleness-injection-upsert-capture.test.ts",
    ],
    prepare(controls) {
      assert.equal(
        controls.profile,
        "sqlite-atomic-batch",
        "Captured-key mutation requires a committed observation, not an open interactive transaction"
      );
      const replaced = id === "g2-key-captured-replaced";
      const restoreAfterRollback = id === "g2-key-captured-restored";
      const counter = s
        .model({
          id: s.int().id(),
          tag: s.string().unique(),
          ticks: s.toMany(() => tick),
        })
        .map("g2_stale_counters");
      const tick = s
        .model({
          id: s.string().id(),
          counterId: s.int().nullable(),
          counter: s
            .toOne(() => counter)
            .fields("counterId")
            .references("id")
            .onUpdate("setNull"),
        })
        .map("g2_stale_ticks");
      const schema = { counter, tick };
      const args = {
        where: { tag: "selected" },
        data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
        select: { id: true, tag: true },
      } as const;
      const initial = {
        counters: [
          { id: 10, tag: "selected" },
          ...(!replaced ? [{ id: 15, tag: "final-key-decoy" }] : []),
          { id: 10000, tag: "untouched" },
        ],
        ticks: [{ id: "decoy-tick", counterId: 10000 }],
      };
      // These rows are the fixture's external committed work, not ORM effects.
      const afterExternalMove = {
        counters: [
          ...(replaced
            ? [{ id: 10, tag: "replacement" }]
            : [{ id: 15, tag: "final-key-decoy" }]),
          { id: 77, tag: "selected" },
          { id: 10000, tag: "untouched" },
        ],
        ticks: initial.ticks,
      };
      const inspect = (database: Database.Database) => ({
        counters: database
          .prepare("SELECT * FROM g2_stale_counters ORDER BY id")
          .all(),
        ticks: database
          .prepare("SELECT * FROM g2_stale_ticks ORDER BY id")
          .all(),
      });
      const cut = replaced ? "captured-key-replaced" : "captured-key-moved";
      const restoreCut = "captured-key-restored-after-rollback";
      const requiredCuts = restoreAfterRollback ? [cut, restoreCut] : [cut];
      let mutated = false;
      let restored = false;
      return {
        publicInput: {
          model: "counter",
          operation: "update",
          args,
          externalMutation: {
            after: "captured id 10 outside a transaction",
            move: { from: 10, to: 77, tag: "selected" },
            insert: replaced ? { id: 10, tag: "replacement" } : null,
            ...(restoreAfterRollback
              ? {
                  restore: {
                    after: "first successful native rollback",
                    from: 77,
                    to: 10,
                    tag: "selected",
                  },
                }
              : {}),
          },
        },
        requiredCuts,
        seed(database) {
          database.exec(`
            CREATE TABLE g2_stale_counters(id INTEGER PRIMARY KEY,tag TEXT NOT NULL UNIQUE);
            CREATE TABLE g2_stale_ticks(id TEXT PRIMARY KEY NOT NULL,counterId INTEGER REFERENCES g2_stale_counters(id) ON UPDATE SET NULL);
            INSERT INTO g2_stale_counters VALUES(10,'selected'),(10000,'untouched');
            INSERT INTO g2_stale_ticks VALUES('decoy-tick',10000);
          `);
          if (!replaced)
            database.exec(
              "INSERT INTO g2_stale_counters VALUES(15,'final-key-decoy');"
            );
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "counter",
              "update",
              args
            );
          return createClient({ schema, driver }).counter.update(args);
        },
        inspect,
        afterStatement(database, completion) {
          if (mutated) {
            assert.deepEqual(
              inspect(database),
              restored ? initial : afterExternalMove,
              "Captured-key refusal must precede ORM effects and preserve the external move"
            );
            return undefined;
          }
          // Stock typed SQLite rows carry bigint keys here. Extra captured fields
          // are immaterial; neither SQL text nor a private statement index identifies A.
          const captured =
            !completion.transactionOpen &&
            completion.rows.some(
              (row) =>
                row !== null &&
                typeof row === "object" &&
                "id" in row &&
                row.id === 10n
            );
          if (!captured) return undefined;
          assert.equal(
            database.inTransaction,
            false,
            "External mutation cannot enter an operation transaction"
          );
          assert.deepEqual(
            inspect(database),
            initial,
            "Capture must precede any ORM write"
          );
          const moved = database
            .prepare(
              "UPDATE g2_stale_counters SET id=77 WHERE id=10 AND tag='selected'"
            )
            .run();
          assert.equal(moved.changes, 1, "The exact captured source must move");
          if (replaced)
            database.exec(
              "INSERT INTO g2_stale_counters VALUES(10,'replacement');"
            );
          assert.deepEqual(inspect(database), afterExternalMove);
          mutated = true;
          return cut;
        },
        afterTransaction(database, phase) {
          if (!restoreAfterRollback || restored || phase !== "rollback")
            return undefined;
          assert(mutated, "Restoration requires the genuine captured-key move");
          assert.equal(
            database.inTransaction,
            false,
            "Restoration must follow a successful native rollback"
          );
          assert.deepEqual(
            inspect(database),
            afterExternalMove,
            "Rollback must preserve external work and remove all ORM effects"
          );
          const restoration = database
            .prepare(
              "UPDATE g2_stale_counters SET id=10 WHERE id=77 AND tag='selected'"
            )
            .run();
          assert.equal(
            restoration.changes,
            1,
            "The exact external source must be restored"
          );
          assert.deepEqual(inspect(database), initial);
          restored = true;
          return restoreCut;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            restoreAfterRollback ? initial : afterExternalMove,
            JSON.stringify(observation.outcome)
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, requiredCuts);
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          if (restoreAfterRollback) {
            assert.equal(
              observation.outcome.failure.name,
              "NestedWriteAssertionError"
            );
            assert.equal(observation.outcome.failure.code, "V7006");
            assert.equal(
              observation.outcome.failure.message,
              "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold."
            );
            return;
          }
          assert.equal(observation.outcome.failure.name, "NotFoundError");
          assert.equal(observation.outcome.failure.code, "V6001");
          assert.equal(
            observation.outcome.failure.message,
            "No counter record found for update"
          );
        },
      };
    },
  };
}

export const capturedKeyScenarios: ScenarioDefinition[] = [
  capturedKeyScenario("g2-key-captured-missing-decoy"),
  capturedKeyScenario("g2-key-captured-replaced"),
  capturedKeyScenario("g2-key-captured-restored"),
];
