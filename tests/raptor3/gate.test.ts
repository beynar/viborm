import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { z } from "zod";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import {
  assertRaptor3Identity,
  captureRaptor3Identity,
  G0_CAMPAIGN,
  G0_FALSIFIERS,
} from "../../scripts/raptor3-manifest.mjs";
import type { ScenarioId } from "./contracts";
import { runGeneratedBatch } from "./generation/campaign";
import type {
  ReplayRecord,
  RunObservation,
  ScenarioDefinition,
} from "./harness/protocol";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
  runG0Campaign,
  verifyG0Pair,
} from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { findReplayScenario as scenarioById } from "./scenarios";
import { fixedScenarios } from "./scenarios/contracts";
import type { ScriptedTransport } from "./transport/driver";
import { runTransportWorld } from "./transport/world";

const completedFalsifiers: string[] = [];
const cutEvidence: ReplayRecord[] = [];
const clockEvidence: ReplayRecord[] = [];
const envelopeSchema = z.strictObject({
  formatVersion: z.literal(1),
  identity: z.unknown(),
  records: z.unknown(),
});
const replayPath = process.env.VIBORM_RAPTOR3_REPLAY_PATH;
const specimen = process.env.VIBORM_RAPTOR3_SPECIMEN;

if (specimen) {
  it("fails closed for the requested command specimen", async () => {
    if (specimen === "missing-case") {
      await runG0Campaign({
        firstSeed: 0,
        seedCount: 1,
        scenarios: fixedScenarios.slice(1),
      });
      return;
    }
    if (specimen === "missing-profile") {
      await runG0Campaign({
        firstSeed: 0,
        seedCount: 1,
        profiles: G0_PROFILES.slice(1),
      });
      return;
    }
    if (specimen === "transport-nontermination") {
      await runTransportWorld(
        {
          seed: 1000,
          mode: "create",
          actors: 1,
          fault: "none",
          multiFault: false,
        },
        "scripted-returning-ack",
        {
          candidateFactory(config) {
            // This broken scheduler leaves the real dispatched provider promise pending.
            const driver = config.driver as ScriptedTransport;
            driver.drain = (work) => work;
            const record = driver.recorder.record.bind(driver.recorder);
            driver.recorder.record = (event) => {
              record(event);
              if (event.kind === "transport" && event.phase === "queued")
                console.log(
                  "G1 nontermination: public operation awaits queued provider reply"
                );
            };
            return createCommandEngine(config);
          },
        }
      );
      return;
    }
    if (specimen === "campaign-progress-nontermination") {
      const campaign = await runGeneratedBatch(2000, 1);
      const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY!;
      const progress = JSON.parse(
        await readFile(
          join(directory, "generated-campaign-progress.json"),
          "utf8"
        )
      );
      assert.deepEqual(progress.completed, campaign.completed);
      assert.equal(progress.completed.length, 2);
      assert.equal(progress.replays, 6);
      assertRaptor3Identity(progress.identity);
      console.log(
        `G2 nontermination: verified cells persisted at ${directory}`
      );
      await new Promise<never>(() => {});
      return;
    }
    assert.equal(specimen, "nontermination", "Unknown G0 specimen");
    const original = scenarioById("s3-grouped");
    const nonterminating: ScenarioDefinition = {
      ...original,
      prepare(controls) {
        const fixture = original.prepare(controls);
        return {
          ...fixture,
          async invoke(driver) {
            await fixture.invoke(driver);
            console.log("G0 nontermination: public operation completed");
            return new Promise<never>(() => {});
          },
        };
      },
    };
    await runSQLiteWorld(nonterminating, "sqlite-interactive", 0);
  }, 240_000);
} else if (replayPath) {
  it("replays the saved corpus against its exact executed-source identity", async () => {
    const envelope = envelopeSchema.parse(
      JSON.parse(await readFile(replayPath, "utf8"))
    );
    assertRaptor3Identity(envelope.identity);
    for (const record of decodeReplayRecords(envelope.records))
      await replayG0Run(record);
  }, 120_000);
} else {
  describe("G0 assembled oracle falsifiers", () => {
    it("rejects wrong rows, missing writes and changed public values", async () => {
      const world = await runSQLiteWorld(
        scenarioById("s1-parent-missing"),
        "sqlite-atomic-batch",
        7
      );
      const mutations: {
        name: string;
        apply(observation: RunObservation): void;
      }[] = [
        {
          name: "wrong-row",
          apply(observation) {
            observation.final.children = [
              { id: "decoy", producerId: 7 },
              { id: "new-a", producerId: 7 },
              { id: "new-b", producerId: 41 },
            ];
          },
        },
        {
          name: "missing-write",
          apply(observation) {
            observation.final.marks = [
              { id: "decoy-mark", producerTag: "decoy-tag" },
            ];
          },
        },
        {
          name: "changed-value",
          apply(observation) {
            observation.outcome = { kind: "success", value: { id: 999 } };
          },
        },
      ];
      for (const mutation of mutations) {
        const observation = structuredClone(world.observation);
        mutation.apply(observation);
        // Both differential sides receive the same defect: only the independent
        // fixture oracle can reject this mutually agreeing wrong answer.
        const corrupted = { ...world, observation };
        assert.throws(() => verifyG0Pair(corrupted, corrupted), mutation.name);
        completedFalsifiers.push(mutation.name);
      }
    });

    it("rejects changed errors and leaked rolled-back effects", async () => {
      const world = await runSQLiteWorld(
        scenarioById("s1-parent-rollback"),
        "sqlite-atomic-batch",
        8
      );
      const changedError = structuredClone(world.observation);
      assert.equal(changedError.outcome.kind, "failure");
      if (changedError.outcome.kind !== "failure")
        throw new Error("Expected public rollback failure");
      changedError.outcome.failure.code = "wrong-code";
      assert.throws(() =>
        verifyG0Pair(world, { ...world, observation: changedError })
      );
      const leaked = structuredClone(world.observation);
      leaked.final.holders?.push({ id: 1, producerId: 41 });
      assert.throws(() =>
        verifyG0Pair(world, { ...world, observation: leaked })
      );
      completedFalsifiers.push("changed-error", "rollback-leak");
    });

    it("accepts equivalent changed SQL executed by the real provider", async () => {
      const scenario = scenarioById("s1-parent-missing");
      const baseline = await runSQLiteWorld(scenario, "sqlite-atomic-batch", 9);
      const compared = await runSQLiteWorld(
        scenario,
        "sqlite-atomic-batch",
        9,
        {
          statementTransform: (statement) =>
            `/* equivalent G0 statement */ ${statement}`,
        }
      );
      assert.notDeepEqual(
        baseline.statements.map((statement) => statement.sql),
        compared.statements.map((statement) => statement.sql)
      );
      verifyG0Pair(baseline, compared);
      completedFalsifiers.push("equivalent-changed-sql");
    });

    it("round-trips success/failure records and rejects uncontrolled or missing events", async () => {
      for (const id of [
        "s1-parent-missing",
        "s1-parent-rollback",
      ] satisfies ScenarioId[]) {
        const world = await runSQLiteWorld(
          scenarioById(id),
          "sqlite-atomic-batch",
          10
        );
        const [decoded] = decodeReplayRecords(
          JSON.parse(JSON.stringify(encodeReplayRecords([world.record])))
        );
        assert(decoded);
        for (let replay = 0; replay < 3; replay += 1)
          await replayG0Run(decoded);
        const extraEvent = structuredClone(decoded);
        extraEvent.tape = {
          events: [
            { kind: "cut", name: "uncontrolled" },
            ...decoded.tape.events,
          ],
        };
        await assert.rejects(() => replayG0Run(extraEvent));
        const missingEvent = structuredClone(decoded);
        missingEvent.tape = { events: decoded.tape.events.slice(0, -1) };
        await assert.rejects(() => replayG0Run(missingEvent));
      }
      assert.throws(() => decodeReplayRecords(["array", []]));
      assert.throws(() => decodeReplayRecords(["unknown-wire-tag", []]));
      completedFalsifiers.push(
        "success-failure-replay",
        "corrupt-event-tape",
        "missing-event",
        "invalid-replay"
      );
    });

    it("controls public Date defaults and rejects a real uncontrolled clock source", async () => {
      const controlled = await runSQLiteWorld(
        scenarioById("g0-clock-controlled"),
        "sqlite-interactive",
        10
      );
      controlled.fixture.assert(controlled.observation);
      assert(
        controlled.record.tape.events.some((event) => event.kind === "clock")
      );
      const [decoded] = decodeReplayRecords(
        JSON.parse(JSON.stringify(encodeReplayRecords([controlled.record])))
      );
      assert(decoded);
      for (let replay = 0; replay < 3; replay += 1) await replayG0Run(decoded);
      clockEvidence.push(decoded);
      const uncontrolled = await runSQLiteWorld(
        scenarioById("g0-clock-uncontrolled"),
        "sqlite-interactive",
        10
      );
      uncontrolled.fixture.assert(uncontrolled.observation);
      // The fixture deliberately captured the native Date before control began.
      // Advance that actual wall clock, not a replay tape or observed answer.
      const afterRun = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      assert(
        Date.now() > afterRun,
        "Native clock did not advance for the bypass specimen"
      );
      await assert.rejects(
        () => replayG0Run(uncontrolled.record),
        /Uncontrolled or changed event/
      );
      completedFalsifiers.push(
        "controlled-default-clock",
        "uncontrolled-source"
      );
    });

    it("fails on fixture exceptions, swallowed failures and event exhaustion", async () => {
      const original = scenarioById("s1-parent-rollback");
      const brokenFixture: ScenarioDefinition = {
        ...original,
        prepare(controls) {
          const fixture = original.prepare(controls);
          return {
            ...fixture,
            afterStatement() {
              throw new Error("fixture observation failed");
            },
          };
        },
      };
      await assert.rejects(
        () => runSQLiteWorld(brokenFixture, "sqlite-interactive"),
        /fixture observation failed/
      );
      const swallowed: ScenarioDefinition = {
        ...original,
        prepare(controls) {
          const fixture = original.prepare(controls);
          return {
            ...fixture,
            async invoke(driver) {
              try {
                return await fixture.invoke(driver);
              } catch {
                return { silentlySwallowed: true };
              }
            },
          };
        },
      };
      const swallowedWorld = await runSQLiteWorld(
        swallowed,
        "sqlite-interactive"
      );
      assert.throws(() => verifyG0Pair(swallowedWorld, swallowedWorld));
      await assert.rejects(
        () =>
          runSQLiteWorld(scenarioById("s3-grouped"), "sqlite-interactive", 11, {
            eventLimit: 1,
          }),
        /event limit/
      );
      completedFalsifiers.push(
        "harness-exception",
        "swallowed-failure",
        "event-limit"
      );
    });

    it("distinguishes reached, atomically eliminated and unexpectedly missing cuts", async () => {
      const split = scenarioById("g0-cut-split");
      const atomic = scenarioById("g0-cut-atomic");
      const splitWorld = await runSQLiteWorld(split, "sqlite-interactive", 12);
      const atomicWorld = await runSQLiteWorld(
        atomic,
        "sqlite-interactive",
        12
      );
      splitWorld.fixture.assert(splitWorld.observation);
      atomicWorld.fixture.assert(atomicWorld.observation);
      assert.deepEqual(
        splitWorld.observation.final,
        atomicWorld.observation.final
      );
      assert(splitWorld.observation.reachedCuts.includes("between-effects"));
      assert(!atomicWorld.observation.reachedCuts.includes("between-effects"));
      // Actual SQLite statement success moved the atomic world directly from zero
      // rows to both rows. Initial and after-effects boundaries check the same
      // invariant; no interleaving is claimed inside that statement.
      assert(atomicWorld.observation.reachedCuts.includes("after-effects"));
      assert.equal(
        atomicWorld.statements.filter((statement) =>
          /INSERT\s+INTO\s+"g0_cut_rows"/i.test(statement.sql)
        ).length,
        1
      );
      const interrupted = await runSQLiteWorld(
        split,
        "sqlite-interactive",
        12,
        { fault: { kind: "at-cut", cut: "between-effects" } }
      );
      assert.equal(interrupted.observation.outcome.kind, "failure");
      assert.deepEqual(interrupted.observation.final, { rows: [{ id: 1 }] });
      const atomicBefore = await runSQLiteWorld(
        atomic,
        "sqlite-interactive",
        12,
        { fault: { kind: "before-dispatch" } }
      );
      assert.equal(atomicBefore.observation.outcome.kind, "failure");
      assert.deepEqual(atomicBefore.observation.final, { rows: [] });
      const atomicAfter = await runSQLiteWorld(
        atomic,
        "sqlite-interactive",
        12,
        { fault: { kind: "at-cut", cut: "after-effects" } }
      );
      assert.equal(atomicAfter.observation.outcome.kind, "failure");
      assert.deepEqual(atomicAfter.observation.final, {
        rows: [{ id: 1 }, { id: 2 }],
      });
      const specimens = decodeReplayRecords(
        JSON.parse(
          JSON.stringify(
            encodeReplayRecords([
              splitWorld.record,
              atomicWorld.record,
              interrupted.record,
              atomicBefore.record,
              atomicAfter.record,
            ])
          )
        )
      );
      for (const record of specimens) {
        for (let replay = 0; replay < 3; replay += 1) await replayG0Run(record);
        cutEvidence.push(record);
      }
      const missing = await runSQLiteWorld(
        scenarioById("g0-cut-missing"),
        "sqlite-interactive",
        12
      );
      assert.throws(
        () => missing.fixture.assert(missing.observation),
        /Missing semantic cut/
      );
      const savedMissing = decodeReplayRecords(
        encodeReplayRecords([missing.record])
      )[0]!;
      for (let replay = 0; replay < 3; replay++)
        await assert.rejects(
          () => replayG0Run(savedMissing),
          /Missing semantic cut/
        );
      completedFalsifiers.push(
        "split-atomic-cut",
        "missing-eligible-cut",
        "controlled-cut-failure",
        "atomic-surrounding-faults"
      );
    });

    it("refuses an empty campaign and stale executed-source identity", async () => {
      await assert.rejects(
        () => runG0Campaign({ firstSeed: 0, seedCount: 0 }),
        /requires 1–100/
      );
      const identity = captureRaptor3Identity();
      assert.throws(
        () =>
          assertRaptor3Identity({ ...identity, production: "stale" }, identity),
        /Stale Raptor/
      );
      completedFalsifiers.push("zero-case-selection", "stale-evidence");
    });
  });

  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory)
    it("records the complete fixed and 100-seed-per-profile G0 campaign", async () => {
      assert.deepEqual(
        [...completedFalsifiers].sort(),
        [...G0_FALSIFIERS].sort(),
        "A required falsifier did not complete"
      );
      const identity = captureRaptor3Identity();
      const campaign = await runG0Campaign({
        firstSeed: G0_CAMPAIGN.firstSeed,
        seedCount: G0_CAMPAIGN.seedCount,
      });
      assertRaptor3Identity(identity);
      await writeFile(
        join(directory, "corpus.json"),
        JSON.stringify({
          formatVersion: 1,
          identity,
          records: encodeReplayRecords(campaign.records),
        })
      );
      await writeFile(
        join(directory, "cut-evidence.json"),
        JSON.stringify({
          formatVersion: 1,
          identity,
          records: encodeReplayRecords(cutEvidence),
        })
      );
      await writeFile(
        join(directory, "clock-evidence.json"),
        JSON.stringify({
          formatVersion: 1,
          identity,
          records: encodeReplayRecords(clockEvidence),
        })
      );
      await writeFile(
        join(directory, "campaign.json"),
        JSON.stringify(
          {
            identity,
            campaign: G0_CAMPAIGN,
            ...campaign,
            records: undefined,
            falsifiers: completedFalsifiers,
            cutClassification: {
              cut: "between-effects",
              split: "reached",
              atomic: "eliminated by one native SQLite insert",
              surroundingFaults: ["before-dispatch", "after-effects"],
            },
          },
          null,
          2
        )
      );
    }, 120_000);
}
