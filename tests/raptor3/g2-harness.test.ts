import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { it } from "vitest";
import type { ScenarioDefinition } from "./harness/protocol";
import { Recorder, recordingEventLimit } from "./harness/recorder";
import { decodeReplayRecords, encodeReplayRecords } from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { findReplayScenario } from "./scenarios";

for (const profile of G0_PROFILES) {
  it(`records coincident cuts and injects at the non-final cut: ${profile}`, async () => {
    const original = findReplayScenario("g0-cut-split");
    const coincident: ScenarioDefinition = {
      ...original,
      prepare(controls) {
        const fixture = original.prepare(controls);
        return {
          ...fixture,
          afterStatement(database, completion) {
            const cut = fixture.afterStatement!(database, completion);
            return cut === "between-effects" ? [cut, "coincident-cut"] : cut;
          },
        };
      },
    };
    const fault = { kind: "at-cut" as const, cut: "between-effects" };
    const world = await runSQLiteWorld(coincident, profile, 2000, { fault });
    world.fixture.assert(world.observation);
    assert.deepEqual(world.observation.reachedCuts, [
      "between-effects",
      "coincident-cut",
    ]);
    assert.deepEqual(
      world.record.tape.events.filter(
        (event) => event.kind === "injected-failure"
      ),
      [{ kind: "injected-failure", cut: "between-effects" }]
    );
    for (let replay = 0; replay < 3; replay++) {
      const repeated = await runSQLiteWorld(coincident, profile, 2000, {
        fault,
        replay: world.record.tape,
      });
      assert.deepEqual(
        encodeReplayRecords([repeated.record]),
        encodeReplayRecords([world.record])
      );
      repeated.fixture.assert(repeated.observation);
    }
  });

  it(`preserves the first observer failure across later calls: ${profile}`, async () => {
    const original = findReplayScenario("g0-cut-split");
    const first = new Error("first observation failed");
    const second = new Error("later observation failed");
    let observations = 0;
    const broken: ScenarioDefinition = {
      ...original,
      prepare(controls) {
        const marker = s.model({ id: s.int().id() }).map("g0_cut_rows");
        return {
          ...original.prepare(controls),
          async invoke(driver) {
            const client = createClient({ schema: { marker }, driver });
            // This deliberate swallowed-observer specimen must not turn green.
            for (const id of [1, 2])
              await Promise.allSettled([
                client.marker.create({ data: { id } }),
              ]);
          },
          afterStatement() {
            throw ++observations === 1 ? first : second;
          },
        };
      },
    };
    await assert.rejects(
      () => runSQLiteWorld(broken, profile, 2000),
      (failure) => failure === first
    );
    assert.equal(observations, 2);
  });
}

for (const [scenarioId, limit] of [
  ["g0-cut-split", 2000],
  ["g2-generated-transitions", 5000],
] as const) {
  it(`keeps the runtime and replay admission ceiling at ${limit}: ${scenarioId}`, async () => {
    const world = await runSQLiteWorld(
      findReplayScenario("g0-cut-split"),
      "sqlite-interactive"
    );
    assert.equal(recordingEventLimit(scenarioId), limit);
    const recorder = new Recorder(
      2000,
      undefined,
      recordingEventLimit(scenarioId)
    );
    for (let event = 0; event < limit; event++)
      recorder.record({ kind: "cut", name: String(event) });
    const tape = recorder.finish();
    const record = { ...world.record, scenarioId, tape };
    decodeReplayRecords(encodeReplayRecords([record]));
    assert.throws(
      () => recorder.record({ kind: "cut", name: "over-budget" }),
      /Controlled event limit/
    );
    assert.throws(() => recorder.finish(), /Controlled event limit/);
    assert.throws(
      () =>
        decodeReplayRecords(
          encodeReplayRecords([
            {
              ...record,
              tape: {
                events: [...tape.events, { kind: "cut", name: "over-budget" }],
              },
            },
          ])
        ),
      /event|limit/i
    );
  });
}
