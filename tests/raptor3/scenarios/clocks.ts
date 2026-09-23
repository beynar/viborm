import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

// Deliberately captured before a world's controls are installed: the negative
// specimen demonstrates an actual source that escapes the global Date boundary.
const NativeDate = Date;

function clockScenario(uncontrolled: boolean): ScenarioDefinition {
  return {
    id: uncontrolled ? "g0-clock-uncontrolled" : "g0-clock-controlled",
    family: "S2",
    contracts: ["C13"],
    sources: ["src/schema/scalars/datetime/scalar.ts"],
    prepare(controls) {
      let nativeTimestamp: string | undefined;
      const timestamp = uncontrolled
        ? s.dateTime().default(() => {
            nativeTimestamp = new NativeDate().toISOString();
            return nativeTimestamp;
          })
        : s.dateTime().now();
      const event = s
        .model({ id: s.int().id(), createdAt: timestamp })
        .map("g0_clock_events");
      return {
        publicInput: {
          model: "event",
          operation: "create",
          args: { data: { id: 1 } },
          source: uncontrolled ? "captured-native-Date" : "dateTime.now",
        },
        requiredCuts: [],
        seed(database) {
          database.exec(
            "CREATE TABLE g0_clock_events (id INTEGER PRIMARY KEY, createdAt TEXT NOT NULL)"
          );
        },
        async invoke(driver) {
          return await createClient({ schema: { event }, driver }).event.create(
            { data: { id: 1 } }
          );
        },
        inspect(database) {
          return {
            events: database
              .prepare("SELECT id,createdAt FROM g0_clock_events ORDER BY id")
              .all(),
          };
        },
        assert(observation) {
          const expected = uncontrolled
            ? nativeTimestamp
            : new NativeDate(controls.clockEpochMs).toISOString();
          assert(expected, "Default source did not execute");
          assert.deepEqual(observation.initial, { events: [] });
          assert.deepEqual(observation.final, {
            events: [{ id: 1, createdAt: expected }],
          });
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { id: 1, createdAt: new NativeDate(expected) },
          });
        },
      };
    },
  };
}

export const clockScenarios = [clockScenario(false), clockScenario(true)];
