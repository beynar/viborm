import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import {
  captureRaptor3Identity,
  G3_GENERATED_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import type { ProfileId } from "../../profiles";
import type {
  ControlledFault,
  G0ReplayRecord,
  ScenarioDefinition,
} from "../../harness/protocol";
import { encodeReplayRecords, replayG0Run } from "../../harness/replay";
import { runSQLiteWorld } from "../../harness/sqlite-world";
import { generatedBulkScenario } from "./bulk-scenario";
import { minimizeG3Failure } from "./failure-minimization";
import { generateG3Recipe, type G3GeneratedRecipe } from "./recipe";
import { generatedRecurrenceScenario } from "./recurrence-scenario";
import { generatedSuppressionScenario } from "./suppression-scenario";
import { generatedTransactionArrayScenario } from "./transaction-array-scenario";

export function generatedSQLiteScenario(
  recipe: G3GeneratedRecipe
): ScenarioDefinition {
  if (recipe.contract === "C08") return generatedBulkScenario(recipe);
  if (recipe.contract === "C09") return generatedSuppressionScenario(recipe);
  if (recipe.contract === "C10")
    return generatedTransactionArrayScenario(recipe);
  return generatedRecurrenceScenario(recipe);
}

function sqliteFault(recipe: G3GeneratedRecipe): ControlledFault | undefined {
  return recipe.fault === "none" ? undefined : { kind: "before-dispatch" };
}

export async function verifyG3SQLiteCell(
  recipe: G3GeneratedRecipe,
  profile: ProfileId,
  captureRecord?: (record: G0ReplayRecord) => void
) {
  const world = await runSQLiteWorld(
    generatedSQLiteScenario(recipe),
    profile,
    recipe.seed,
    {
      candidateFactory: createCommandEngine,
      candidateName: "commands",
      fault: sqliteFault(recipe),
    }
  );
  captureRecord?.(world.record);
  world.fixture.assert(world.observation);
  for (let replay = 0; replay < G3_GENERATED_CAMPAIGN.replayCount; replay++)
    await replayG0Run(world.record);
  const actorOverlap = world.record.tape.events.some(
    (event) => event.kind === "cut" && event.name.endsWith("actors-overlapped")
  );
  const faults = world.record.tape.events.filter(
    (event) => event.kind === "injected-failure"
  ).length;
  assert.equal(
    actorOverlap,
    recipe.actors === 2,
    "G3 actor quota requires an observed pre-completion overlap cut"
  );
  assert.equal(
    faults > 0,
    recipe.fault !== "none",
    "G3 fault quota requires an actual legal injected failure"
  );
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

/** One child owns one bounded contiguous ID slice on both SQLite profiles. */
export async function runG3SQLiteBatch(firstSeed: number, seedCount = 100) {
  assert(
    Number.isInteger(firstSeed) &&
      Number.isInteger(seedCount) &&
      seedCount >= 1 &&
      seedCount <= G3_GENERATED_CAMPAIGN.batchSize &&
      firstSeed >= G3_GENERATED_CAMPAIGN.firstSeed &&
      firstSeed + seedCount <=
        G3_GENERATED_CAMPAIGN.firstSeed + G3_GENERATED_CAMPAIGN.seedCount,
    "G3 SQLite child must contain 1–100 contiguous IDs within 8000–17999"
  );
  const identity = captureRaptor3Identity();
  const records: G0ReplayRecord[] = [];
  const completed: Awaited<
    ReturnType<typeof verifyG3SQLiteCell>
  >["completion"][] = [];
  let activeCell:
    | {
        recipe: G3GeneratedRecipe;
        profile: ProfileId;
        record?: G0ReplayRecord;
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
      profiles: G3_GENERATED_CAMPAIGN.profiles,
      completed,
      replays: completed.length * G3_GENERATED_CAMPAIGN.replayCount,
      skipped: 0,
    });
  };
  await persist("incomplete");
  try {
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
      const recipe = generateG3Recipe(seed);
      for (const profile of G3_GENERATED_CAMPAIGN.profiles) {
        activeCell = { recipe, profile };
        const cell = await verifyG3SQLiteCell(recipe, profile, (record) => {
          activeCell = { recipe, profile, record };
        });
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
          "G3 SQLite original failure evidence could not be persisted",
          { cause: failure }
        );
      }
    }
    if (failingCell !== undefined) {
      try {
        const minimized = await minimizeG3Failure<G0ReplayRecord>(
          failingCell.recipe,
          failingCell.profile,
          failure,
          async (recipe, captureRecord) => {
            await verifyG3SQLiteCell(
              recipe,
              failingCell.profile,
              captureRecord
            );
          },
          replayG0Run,
          G3_GENERATED_CAMPAIGN.replayCount
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
          "G3 SQLite failure minimization failed",
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
          "G3 SQLite minimization evidence could not be persisted",
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
    profiles: G3_GENERATED_CAMPAIGN.profiles,
    completed,
    replays: completed.length * G3_GENERATED_CAMPAIGN.replayCount,
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
