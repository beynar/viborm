import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

/** Native SQLite statements establish the available observation cuts. */
function cutScenario(
  strategy: "split" | "atomic" | "missing"
): ScenarioDefinition {
  return {
    id: `g0-cut-${strategy}`,
    family: "S2",
    contracts: ["C10"],
    sources: [],
    prepare(controls) {
      const marker = s.model({ id: s.int().id() }).map("g0_cut_rows");
      const transitions: number[] = [];
      return {
        publicInput: {
          model: "marker",
          strategy,
          rows: [{ id: 1 }, { id: 2 }],
        },
        requiredCuts: strategy === "missing" ? ["missing-eligible"] : [],
        seed(database) {
          database.exec("CREATE TABLE g0_cut_rows (id INTEGER PRIMARY KEY)");
        },
        async invoke(driver) {
          const client = createClient({ schema: { marker }, driver });
          if (strategy === "atomic")
            return await client.marker.createMany({
              data: [{ id: 1 }, { id: 2 }],
            });
          await client.marker.create({ data: { id: 1 } });
          await client.marker.create({ data: { id: 2 } });
          return { count: 2 };
        },
        inspect(database) {
          return {
            rows: database
              .prepare("SELECT id FROM g0_cut_rows ORDER BY id")
              .all(),
          };
        },
        afterStatement(database) {
          const rows = database
            .prepare("SELECT id FROM g0_cut_rows ORDER BY id")
            .all();
          if (transitions.at(-1) === rows.length) return undefined;
          transitions.push(rows.length);
          if (rows.length === 1) return "between-effects";
          if (rows.length === 2) return "after-effects";
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, { rows: [] });
          if (controls.fault) {
            assert.equal(observation.outcome.kind, "failure");
            if (controls.fault.kind === "before-dispatch") {
              assert.deepEqual(observation.final, { rows: [] });
            } else if (controls.fault.kind === "at-cut") {
              if (controls.fault.cut === "between-effects") {
                assert.equal(strategy, "split");
                assert.deepEqual(observation.final, { rows: [{ id: 1 }] });
              } else {
                assert.equal(controls.fault.cut, "after-effects");
                assert.deepEqual(observation.final, {
                  rows: [{ id: 1 }, { id: 2 }],
                });
              }
            }
            return;
          }
          assert.deepEqual(observation.final, { rows: [{ id: 1 }, { id: 2 }] });
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { count: 2 },
          });
          assert.deepEqual(
            transitions.filter((count) => count > 0),
            strategy === "atomic" ? [2] : [1, 2]
          );
        },
      };
    },
  };
}

export const cutScenarios = [
  cutScenario("split"),
  cutScenario("atomic"),
  cutScenario("missing"),
];
