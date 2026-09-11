import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import { assertEquivalentRunObservations } from "../../benchmarks/operation-pipeline-semantics.mjs";
import type { TransportReplayRecord } from "./harness/protocol";
import { encodeReplayRecords, replayG0Run } from "./harness/replay";
import { TRANSPORT_PROFILES, type TransportProfileId } from "./profiles";
import { generateTransportRecipe, runTransportWorld } from "./transport/world";

it("completes the exact admitted transport seed batch", async () => {
  const firstSeed = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED ?? 1000
  );
  assert(
    Number.isInteger(firstSeed) &&
      ((firstSeed >= 1000 && firstSeed <= 6900 && firstSeed % 100 === 0) ||
        firstSeed === 7000)
  );
  const records: TransportReplayRecord[] = [];
  const completed: {
    seed: number;
    profile: TransportProfileId;
    actors: 1 | 2;
    faults: number;
  }[] = [];
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  const identity = directory ? captureRaptor3Identity() : undefined;
  const persistProgress = async () => {
    if (!directory) return;
    const path = join(directory, "generated-campaign-progress.json");
    await writeFile(
      `${path}.tmp`,
      JSON.stringify(
        {
          formatVersion: 1,
          qualifying: false,
          status: "incomplete",
          identity,
          firstSeed,
          seedCount: 100,
          profiles: TRANSPORT_PROFILES,
          completed,
          replays: completed.length * 3,
          skipped: 0,
        },
        null,
        2
      )
    );
    await rename(`${path}.tmp`, path);
  };
  await persistProgress();
  for (let seed = firstSeed; seed < firstSeed + 100; seed++) {
    const recipe = generateTransportRecipe(seed);
    for (const profile of TRANSPORT_PROFILES) {
      let phase = "execute";
      try {
        const baseline =
          firstSeed >= 2000
            ? await runTransportWorld(recipe, profile, {
                candidateName: "legacy",
              })
            : undefined;
        if (baseline) {
          records.push(baseline.record);
          phase = "baseline independent oracle";
          baseline.fixture.assert(baseline.observation);
        }
        phase = "commands execute";
        const world = await runTransportWorld(recipe, profile);
        records.push(world.record);
        phase = "independent oracle";
        world.fixture.assert(world.observation);
        if (baseline) {
          phase = "semantic comparison";
          // Both route-specific physical scripts passed their own oracle. Their
          // request tape is not database state or an across-engine schedule law.
          assertEquivalentRunObservations(
            "g2-transport",
            { ...baseline.observation, final: {} },
            { ...world.observation, final: {} }
          );
        }
        phase = "exact replay";
        for (let replay = 0; replay < 3; replay++)
          await replayG0Run(world.record);
        completed.push({
          seed,
          profile,
          actors: recipe.actors,
          faults: world.record.tape.events.filter(
            (event) => event.kind === "injected-failure"
          ).length,
        });
        await persistProgress();
      } catch (failure) {
        if (directory) {
          const identity = captureRaptor3Identity();
          await writeFile(
            join(directory, `failure-${seed}-${profile}.json`),
            JSON.stringify(
              {
                identity,
                recipe,
                profile,
                phase,
                failure:
                  failure instanceof Error ? failure.stack : String(failure),
              },
              null,
              2
            )
          );
          if (records.length)
            await writeFile(
              join(directory, `failure-${seed}-${profile}-corpus.json`),
              JSON.stringify({
                formatVersion: 1,
                identity,
                records: encodeReplayRecords(records),
              })
            );
        }
        throw new Error(`Transport seed ${seed}, ${profile}, ${phase} failed`, {
          cause: failure,
        });
      }
    }
  }
  for (const profile of TRANSPORT_PROFILES) {
    const cells = completed.filter((cell) => cell.profile === profile);
    assert.equal(cells.length, 100);
    assert(cells.filter((cell) => cell.actors === 2).length >= 20);
    assert(cells.filter((cell) => cell.faults > 0).length >= 20);
  }
  if (directory) {
    await writeFile(
      join(directory, "corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(records),
      })
    );
    await writeFile(
      join(directory, "generated-campaign.json"),
      JSON.stringify(
        {
          firstSeed,
          seedCount: 100,
          profiles: TRANSPORT_PROFILES,
          completed,
          replays: completed.length * 3,
          skipped: 0,
        },
        null,
        2
      )
    );
  }
}, 120_000);
