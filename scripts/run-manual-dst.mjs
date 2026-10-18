// biome-ignore-all lint/suspicious/noMisplacedAssertion: CLI admission and evidence validation use node:assert.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseEvidenceReport } from "../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity, RAPTOR3_ROOT } from "./raptor3-manifest.mjs";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    count: { type: "string", default: "100" },
    steps: { type: "string", default: "48" },
    replay: { type: "string" },
  },
});
const saved = values.replay
  ? parseEvidenceReport(readFileSync(resolve(values.replay), "utf8"))
  : undefined;
if (values.replay) {
  assert(
    saved && typeof saved === "object" && !Array.isArray(saved),
    "invalid replay receipt"
  );
  assert(saved.extensions && saved.identity, "incomplete replay receipt");
}
const first = saved?.seed ?? Number(values.seed);
const count = saved ? 1 : Number(values.count);
const steps = saved?.steps ?? Number(values.steps);
assert(
  Number.isSafeInteger(first) && first >= 0 && first < 1_000_000,
  "invalid seed"
);
assert(
  Number.isSafeInteger(count) && count > 0 && count <= 1000,
  "count must be 1..1000"
);
assert(
  Number.isSafeInteger(steps) && steps >= 18 && steps <= 200,
  "steps must be 18..200"
);
assert(first + count <= 1_000_000, "seed range exceeds 999999");
const hash = createHash("sha256");
for (const file of [
  ...readdirSync(resolve(RAPTOR3_ROOT, "tests/manual-dst"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `tests/manual-dst/${name}`),
  "tests/fixtures/sync-schema.ts",
])
  hash
    .update(file)
    .update("\0")
    .update(readFileSync(resolve(RAPTOR3_ROOT, file)))
    .update("\0");
const identity = { ...captureRaptor3Identity(), manual: hash.digest("hex") };
if (saved)
  assert.deepEqual(
    saved.identity,
    identity,
    "receipt source/runtime differs; rerun its seed without --replay to investigate changed code"
  );
const directory = mkdtempSync(resolve(tmpdir(), "viborm-manual-dst-"));
writeFileSync(
  resolve(directory, "campaign.json"),
  JSON.stringify({ first, count, steps, identity }, null, 2)
);
process.stdout.write(
  `Manual DST: ${count} seeds × ${steps} operations, exact replay, two migration worlds per seed.\nReceipts: ${directory}\n`
);
let child;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
const coverage = {};
for (let seed = first; seed < first + count; seed += 100) {
  const size = Math.min(100, first + count - seed);
  const code = await new Promise((resolveExit, reject) => {
    child = spawn(
      process.execPath,
      [
        "scripts/run-vitest-safe.mjs",
        "run",
        "--config",
        "tests/manual-dst/vitest.config.ts",
      ],
      {
        cwd: RAPTOR3_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          VIBORM_DST_SEED: String(seed),
          VIBORM_DST_COUNT: String(size),
          VIBORM_DST_STEPS: String(steps),
          VIBORM_DST_OUTPUT: directory,
          VIBORM_DST_IDENTITY: JSON.stringify(identity),
          VIBORM_DST_REPLAY: values.replay ? resolve(values.replay) : "",
        },
      }
    );
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code));
  });
  if (code !== 0 || interrupted) {
    process.stderr.write(
      `Campaign stopped; failure trace and completed receipts: ${directory}\n`
    );
    process.exitCode = 1;
    break;
  }
  for (let current = seed; current < seed + size; current++) {
    const receipt = parseEvidenceReport(
      readFileSync(resolve(directory, `seed-${current}.json`), "utf8")
    );
    assert.equal(receipt.extensions.trace.length, steps);
    for (const { operation } of receipt.extensions.trace)
      coverage[operation] = (coverage[operation] ?? 0) + 1;
  }
}
if (!process.exitCode) {
  writeFileSync(
    resolve(directory, "summary.json"),
    JSON.stringify({ first, count, steps, coverage, identity }, null, 2)
  );
  process.stdout.write(
    `Passed: ${count} seeds, ${count * steps} generated operations + exact replay, ${count * 2} migration worlds.\n${JSON.stringify(coverage)}\n`
  );
}
