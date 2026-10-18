import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import {
  parseEvidenceReport,
  serializeEvidenceReport,
} from "../../benchmarks/operation-pipeline-evidence.mjs";
import { runExtensionSeed } from "./extensions";
import { runMigrationSeed } from "./migrations";

const first = Number(process.env.VIBORM_DST_SEED ?? 1);
const count = Number(process.env.VIBORM_DST_COUNT ?? 10);
const steps = Number(process.env.VIBORM_DST_STEPS ?? 48);
assert(Number.isSafeInteger(first) && first >= 0 && first < 1_000_000);
assert(Number.isSafeInteger(count) && count > 0 && count <= 100);
assert(Number.isSafeInteger(steps) && steps >= 18 && steps <= 200);
const directory = resolve(
  process.env.VIBORM_DST_OUTPUT ?? "/tmp/viborm-manual-dst"
);
mkdirSync(directory, { recursive: true });
const identity = JSON.parse(process.env.VIBORM_DST_IDENTITY ?? "null");
const saved = process.env.VIBORM_DST_REPLAY
  ? parseEvidenceReport(readFileSync(process.env.VIBORM_DST_REPLAY, "utf8"))
  : undefined;
for (let seed = first; seed < first + count; seed++) {
  test(`manual DST seed ${seed}`, async () => {
    try {
      const firstRun = await runExtensionSeed(seed, steps);
      writeFileSync(
        resolve(directory, `seed-${seed}.json`),
        serializeEvidenceReport({ identity, seed, steps, extensions: firstRun })
      );
      const replay = await runExtensionSeed(seed, steps, firstRun.tape);
      assert.deepEqual(replay, firstRun, "exact extension replay diverged");
      if (saved)
        assert.deepEqual(
          firstRun,
          saved.extensions,
          "saved extension receipt diverged"
        );
      const migrations = await runMigrationSeed(seed);
      writeFileSync(
        resolve(directory, `seed-${seed}.json`),
        serializeEvidenceReport({
          identity,
          seed,
          steps,
          extensions: firstRun,
          migrations,
        })
      );
    } catch (error) {
      writeFileSync(
        resolve(directory, `failure-${seed}.txt`),
        errorDetails(error)
      );
      throw error;
    }
  });
}

function errorDetails(error: unknown): string {
  return error instanceof Error
    ? `${error.stack}\n${error.cause ? errorDetails(error.cause) : ""}`
    : String(error);
}
