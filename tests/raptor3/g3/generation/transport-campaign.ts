import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureRaptor3Identity,
  G3_GENERATED_TRANSPORT_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import type { TransportReplayRecord } from "../../harness/protocol";
import { encodeReplayRecords, replayG0Run } from "../../harness/replay";
import type { TransportProfileId } from "../../profiles";
import { generateG3Recipe, type G3GeneratedRecipe } from "./recipe";
import { minimizeG3Failure } from "./failure-minimization";
import { runG3TransportWorld } from "./transport-scenario";

export async function verifyG3TransportCell(
  recipe: G3GeneratedRecipe,
  profile: TransportProfileId,
  captureRecord?: (record: TransportReplayRecord) => void,
  campaign: typeof G3_GENERATED_TRANSPORT_CAMPAIGN = G3_GENERATED_TRANSPORT_CAMPAIGN
) {
  const world = await runG3TransportWorld(recipe, profile);
  captureRecord?.(world.record);
  world.fixture.assert(world.observation);
  for (let replay = 0; replay < campaign.replayCount; replay++)
    await replayG0Run(world.record);
  const actorOverlap = world.record.tape.events.some(
    (event) => event.kind === "cut" && event.name.endsWith("actors-overlapped")
  );
  const faults = world.record.tape.events.filter(
    (event) => event.kind === "injected-failure"
  ).length;
  assert.equal(actorOverlap, recipe.actors === 2);
  assert.equal(faults > 0, recipe.fault !== "none");
  return {
    record: world.record,
    completion: {
      seed: recipe.seed,
      profile,
      contract: recipe.contract,
      actors: recipe.actors,
      actorOverlap,
      faults,
      operations: recipe.operations,
      completions: world.record.tape.events.filter(
        (event) => event.kind === "completion"
      ).length,
    },
  };
}

async function replaceJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

/**
 * One child owns one bounded contiguous ID slice on both transport profiles.
 *
 * `campaign` names which frozen campaign that slice belongs to.
 *
 * Defaults to G3's own, so every existing G3 receipt and self-test is
 * unchanged. A later milestone that runs THIS generator and THIS runner on its
 * own frozen disjoint range passes its campaign constant instead; the range
 * guard, the profile list, the replay count and the receipt then all come from
 * one place rather than from four.
 */
export async function runG3TransportBatch(
  firstSeed: number,
  seedCount = 100,
  campaign: typeof G3_GENERATED_TRANSPORT_CAMPAIGN = G3_GENERATED_TRANSPORT_CAMPAIGN
) {
  assert(
    Number.isInteger(firstSeed) &&
      Number.isInteger(seedCount) &&
      seedCount >= 1 &&
      seedCount <= campaign.batchSize &&
      firstSeed >= campaign.firstSeed &&
      firstSeed + seedCount <= campaign.firstSeed + campaign.seedCount,
    `Transport child must contain 1–${campaign.batchSize} contiguous IDs within ${campaign.firstSeed}–${campaign.firstSeed + campaign.seedCount - 1}`
  );
  const identity = captureRaptor3Identity();
  const records: TransportReplayRecord[] = [];
  const completed: Awaited<
    ReturnType<typeof verifyG3TransportCell>
  >["completion"][] = [];
  let activeCell:
    | {
        recipe: G3GeneratedRecipe;
        profile: TransportProfileId;
        record?: TransportReplayRecord;
      }
    | undefined;
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  const progressPath = directory
    ? join(directory, "generated-campaign-progress.json")
    : undefined;
  const persist = async (status: "incomplete" | "complete") => {
    if (!progressPath) return;
    await replaceJson(progressPath, {
      formatVersion: 1,
      qualifying: status === "complete",
      status,
      identity,
      firstSeed,
      seedCount,
      profiles: campaign.profiles,
      completed,
      replays: completed.length * campaign.replayCount,
      skipped: 0,
    });
  };
  await persist("incomplete");
  try {
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
      const recipe = generateG3Recipe(seed);
      for (const profile of campaign.profiles) {
        activeCell = { recipe, profile };
        const cell = await verifyG3TransportCell(
          recipe,
          profile,
          (record) => {
            activeCell = { recipe, profile, record };
          },
          campaign
        );
        records.push(cell.record);
        completed.push(cell.completion);
        activeCell = undefined;
        await persist("incomplete");
      }
    }
  } catch (failure) {
    const failingCell = activeCell;
    let minimization: unknown =
      failingCell === undefined
        ? { status: "not-minimized", reason: "No active generated cell" }
        : { status: "pending" };
    let terminalFailure = failure;
    const failureEvidence = {
      identity,
      firstSeed,
      completed,
      ...(failingCell === undefined
        ? {}
        : {
            failingCell: {
              recipe: failingCell.recipe,
              profile: failingCell.profile,
              ...(failingCell.record === undefined
                ? {}
                : { record: encodeReplayRecords([failingCell.record]) }),
            },
          }),
      failure: failure instanceof Error ? failure.stack : String(failure),
      records: encodeReplayRecords(records),
    };
    const failurePath = directory
      ? join(directory, `generated-failure-${completed.length}.json`)
      : undefined;
    if (failurePath !== undefined) {
      try {
        await replaceJson(failurePath, { ...failureEvidence, minimization });
      } catch (evidenceFailure) {
        throw new AggregateError(
          [failure, evidenceFailure],
          "G3 transport original failure evidence could not be persisted",
          { cause: failure }
        );
      }
    }
    if (failingCell !== undefined) {
      try {
        const minimized = await minimizeG3Failure<TransportReplayRecord>(
          failingCell.recipe,
          failingCell.profile,
          failure,
          async (recipe, captureRecord) => {
            await verifyG3TransportCell(
              recipe,
              failingCell.profile,
              captureRecord,
              campaign
            );
          },
          replayG0Run,
          campaign.replayCount
        );
        if ("record" in minimized && minimized.record !== undefined) {
          const { record, ...details } = minimized;
          minimization = {
            ...details,
            record: encodeReplayRecords([record]),
          };
        } else minimization = minimized;
      } catch (minimizerFailure) {
        minimization = {
          status: "failed",
          failure:
            minimizerFailure instanceof Error
              ? minimizerFailure.stack
              : String(minimizerFailure),
        };
        terminalFailure = new AggregateError(
          [failure, minimizerFailure],
          "G3 transport failure minimization failed",
          { cause: failure }
        );
      }
    }
    if (failurePath !== undefined) {
      try {
        await replaceJson(failurePath, { ...failureEvidence, minimization });
      } catch (evidenceFailure) {
        terminalFailure = new AggregateError(
          [terminalFailure, evidenceFailure],
          "G3 transport minimization evidence could not be persisted",
          { cause: failure }
        );
      }
    }
    throw terminalFailure;
  }
  await persist("complete");
  const receipt = {
    formatVersion: 1,
    qualifying: true,
    status: "complete",
    identity,
    firstSeed,
    seedCount,
    profiles: campaign.profiles,
    completed,
    replays: completed.length * campaign.replayCount,
    skipped: 0,
  };
  if (directory) {
    await replaceJson(join(directory, "generated-campaign.json"), receipt);
    await replaceJson(join(directory, "generated-corpus.json"), {
      formatVersion: 1,
      identity,
      records: encodeReplayRecords(records),
    });
  }
  return { receipt, records };
}
