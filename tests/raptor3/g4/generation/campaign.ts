/**
 * One G4 generated-read child: a bounded contiguous seed slice on one profile
 * family, verified against the independent oracle and replayed exactly.
 *
 * Subjects. `candidate` is the claim. `shipped` runs the identical worlds,
 * requests, oracle and replays against the shipped engine; it is how the
 * ORACLE is validated and how a complete child's cost is measured while the
 * candidate is still red. Only a `candidate` receipt can qualify.
 */
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Operations } from "@client/types";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { captureRaptor3Identity } from "../../../../scripts/raptor3-manifest.mjs";
import { cursorKeyFor, evaluateRecipe } from "./oracle";
import { buildRequest, generateG4Recipe, type G4ReadRecipe } from "./recipe";
import {
  createGeneratedWorld,
  generationSchema,
  type G4GenerationProfile,
} from "./world";

export type G4Subject = "candidate" | "shipped";

export interface G4Campaign {
  readonly firstSeed: number;
  readonly seedCount: number;
  readonly batchSize: number;
  readonly replayCount: number;
  readonly profiles: readonly string[];
}

export interface G4Cell {
  readonly seed: number;
  readonly profile: string;
  readonly family: string;
  readonly contract: string;
  readonly actors: 1;
  readonly faults: 0;
  readonly rows: number;
  readonly statements: number;
  /**
   * What the transport actually did for this cell, reported by the driver and
   * never derived from the profile name. `assertG4BatchShape` compares it with
   * the manifest's frozen `profile → model` expectation, so two profiles that
   * collapse into one behaviour fail the receipt instead of doubling the cost
   * of every child.
   */
  readonly transport: string;
}

export interface G4CellRecord {
  readonly seed: number;
  readonly profile: string;
  readonly recipe: G4ReadRecipe;
  readonly request: unknown;
  readonly observation: unknown;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === null || typeof value !== "object") return value;
  if (typeof (value as { toFixed?: unknown }).toFixed === "function")
    return { $decimal: String(value) };
  if (ArrayBuffer.isView(value))
    return { $bytes: [...(value as unknown as Uint8Array)] };
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : 1)
  );
  return Object.fromEntries(entries.map(([key, nested]) => [key, canonical(nested)]));
}

export async function verifyG4Cell(
  recipe: G4ReadRecipe,
  profile: G4GenerationProfile,
  campaign: G4Campaign,
  subject: G4Subject
): Promise<{ readonly cell: G4Cell; readonly record: G4CellRecord }> {
  const world = await createGeneratedWorld(recipe.seed, recipe.rowCount, profile);
  try {
    const request = buildRequest(recipe, cursorKeyFor(recipe, world.rows));
    const expected = canonical(evaluateRecipe(recipe, world.rows));
    const run = async (): Promise<unknown> => {
      if (subject === "shipped") {
        const model = world.client[request.model];
        assert.ok(model, `unknown model ${request.model}`);
        const operation = model[request.operation];
        assert.ok(operation, `unknown operation ${request.operation}`);
        return operation(request.args);
      }
      const engine = createCommandEngine({
        schema: generationSchema(),
        driver: world.driver,
      });
      return engine.execute(
        request.model,
        request.operation as Operations,
        request.args
      );
    };
    world.driver.statements.length = 0;
    world.driver.envelopes.length = 0;
    const first = canonical(await run());
    assert.deepStrictEqual(
      first,
      expected,
      `G4 cell ${profile}:${recipe.seed} (${recipe.contract}/${recipe.family}) diverged from the independent oracle`
    );
    const statements = world.driver.statements.length;
    const transport = world.driver.observedTransport();
    for (let replay = 0; replay < campaign.replayCount; replay++) {
      const again = canonical(await run());
      assert.deepStrictEqual(
        again,
        expected,
        `G4 cell ${profile}:${recipe.seed} replay ${replay} was not exact`
      );
    }
    assert.ok(statements >= 1, "a generated read must reach the provider");
    return {
      cell: {
        seed: recipe.seed,
        profile,
        family: recipe.family,
        contract: recipe.contract,
        actors: 1,
        faults: 0,
        rows: Array.isArray(first) ? first.length : 1,
        statements,
        transport,
      },
      record: {
        seed: recipe.seed,
        profile,
        recipe,
        request: canonical(request),
        observation: first,
      },
    };
  } finally {
    await world.close();
  }
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

export interface G4BatchOutcome {
  readonly receipt: Record<string, unknown>;
  readonly records: readonly G4CellRecord[];
}

export async function runG4Batch(
  firstSeed: number,
  seedCount: number,
  campaign: G4Campaign,
  subject: G4Subject = "candidate"
): Promise<G4BatchOutcome> {
  assert(
    Number.isInteger(firstSeed) &&
      Number.isInteger(seedCount) &&
      seedCount >= 1 &&
      seedCount <= campaign.batchSize &&
      firstSeed >= campaign.firstSeed &&
      firstSeed + seedCount <= campaign.firstSeed + campaign.seedCount,
    "a G4 child must hold 1–100 contiguous IDs inside its frozen campaign"
  );
  const identity = captureRaptor3Identity();
  const completed: G4Cell[] = [];
  const records: G4CellRecord[] = [];
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  const progressPath = directory
    ? join(directory, "generated-campaign-progress.json")
    : undefined;
  const receiptFor = (status: "incomplete" | "complete") => ({
    formatVersion: 1,
    qualifying: status === "complete" && subject === "candidate",
    status: status === "complete" && subject === "shipped"
      ? "oracle-validation"
      : status,
    subject,
    identity,
    firstSeed,
    seedCount,
    profiles: [...campaign.profiles],
    completed,
    replays: completed.length * campaign.replayCount,
    skipped: 0,
  });
  const persist = async (status: "incomplete" | "complete") => {
    if (progressPath) await replaceJson(progressPath, receiptFor(status));
  };
  await persist("incomplete");
  try {
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
      const recipe = generateG4Recipe(seed, campaign.firstSeed);
      for (const profile of campaign.profiles) {
        const outcome = await verifyG4Cell(
          recipe,
          profile as G4GenerationProfile,
          campaign,
          subject
        );
        completed.push(outcome.cell);
        records.push(outcome.record);
      }
      await persist("incomplete");
    }
  } catch (failure) {
    if (directory) {
      await replaceJson(join(directory, `generated-failure-${completed.length}.json`), {
        identity,
        subject,
        firstSeed,
        completed,
        failure: failure instanceof Error ? failure.stack : String(failure),
        records,
      });
    }
    throw failure;
  }
  const receipt = receiptFor("complete");
  if (directory) {
    await replaceJson(join(directory, "generated-campaign.json"), receipt);
    await replaceJson(join(directory, "generated-corpus.json"), {
      formatVersion: 1,
      identity,
      subject,
      records,
    });
  }
  return { receipt, records };
}
