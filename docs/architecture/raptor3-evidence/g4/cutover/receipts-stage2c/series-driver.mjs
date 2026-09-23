/**
 * Stage-2c 20-cell performance series driver.
 *
 * Successor of run-series.mjs (kept unchanged as the predecessor's receipt).
 * One cell in one mode per command, five alternating fresh-process pairs per
 * side, run from the baseline overlay worktree as coordinator.
 *
 * Difference from run-series.mjs: the lock classification. run-series.mjs
 * matched /lock|another verification|is already running/i, which matches the
 * STALE-lock refusal ("the workspace lock is stale or unreadable") but NOT the
 * held-lock refusal that scripts/test-run-lock.mjs actually emits
 * ("... (PID N) already owns this workspace." / "workspace verification PID N
 * is still active"). It therefore retried in the one case where retrying is
 * wrong and gave up in the two cases protocol.md §9.6 says to wait on.
 * Here: a HELD lock is waited on (30 s) and retried up to 20 times; a STALE
 * lock stops the whole series so it is handled deliberately. No lock file is
 * ever removed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PASS = process.argv[2];
if (!/^pass[12]$/.test(PASS)) {
  process.stderr.write("usage: series2c.mjs pass1|pass2\n");
  process.exit(2);
}

const BASELINE_DIR = "/private/tmp/viborm-g4-perf-baseline";
const CANDIDATE_DIR = "/private/tmp/viborm-g4-perf-candidate";
const BASELINE_SOURCE = "e67b511b2c1e9db738b23ed5f6b6f1f16cd449b0";
const BASELINE_COMMIT = "e532bbec7667343fc5471929d5051dd15be1852b";
const CANDIDATE_COMMIT = "90d4bb4769e1746181633fa0eb76335d119f798a";
const RECEIPTS =
  "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/cutover/receipts-stage2c/cells";
const TMP = process.env.VIBORM_SERIES_TMPDIR ?? "/private/tmp/viborm-g4-cutover-tmp";

mkdirSync(RECEIPTS, { recursive: true });
const journal = join(RECEIPTS, `${PASS}-journal.txt`);

/** The frozen 20-cell matrix (g0.md, version 1). */
const CELLS = [
  ["scalar-find-unique", "cold-prepare"],
  ["scalar-find-unique", "prepare"],
  ["scalar-find-unique", "execute"],
  ["scalar-find-unique", "full"],
  ["flat-scalar-update", "prepare"],
  ["flat-scalar-update", "execute"],
  ["flat-scalar-update", "full"],
  ["fixed-collection-rowref-20", "prepare"],
  ["fixed-collection-rowref-20", "execute"],
  ["fixed-collection-rowref-20", "full"],
  ["nested-conditional-found", "full"],
  ["nested-conditional-missing", "full"],
  ["key-transition-cascade", "full"],
  ["bulk-update-returning-100", "prepare"],
  ["bulk-update-returning-100", "full"],
  ["relation-series-2", "full"],
  ["fixed-collection-rowref-1000", "prepare"],
  ["fixed-collection-rowref-1000", "execute"],
  ["fixed-collection-rowref-1000", "parse"],
  ["fixed-collection-rowref-1000", "full"],
];

const MODES = ["cpu", "retained"];
const HELD_LOCK =
  /already owns this workspace|workspace verification PID \d+ is still active/i;
const STALE_LOCK = /workspace lock is stale or unreadable/i;
const MAX_LOCK_ATTEMPTS = 20;

function sleep(seconds) {
  spawnSync(process.execPath, ["-e", `setTimeout(()=>{}, ${seconds * 1000})`], {
    stdio: "ignore",
  });
}

for (const [workload, stage] of CELLS) {
  for (const mode of MODES) {
    const name = `${PASS}__${workload}__${stage}__${mode}`;
    const output = join(RECEIPTS, `${name}.json`);
    const logPath = join(RECEIPTS, `${name}.log`);
    if (existsSync(`${output}.gz`) || existsSync(`${logPath}.done`)) {
      process.stdout.write(`skip (already present): ${name}\n`);
      continue;
    }
    const args = [
      "--max-old-space-size=512",
      "benchmarks/operation-pipeline-compare.mjs",
      "--baseline-dir",
      BASELINE_DIR,
      "--baseline-commit",
      BASELINE_COMMIT,
      "--baseline-source-commit",
      BASELINE_SOURCE,
      "--candidate-dir",
      CANDIDATE_DIR,
      "--candidate-commit",
      CANDIDATE_COMMIT,
      "--providers",
      "sqlite3",
      "--comparison",
      "semantic",
      "--workloads",
      workload,
      "--stages",
      stage,
      "--modes",
      mode,
    ];
    if (workload === "fixed-collection-rowref-1000" && mode === "cpu") {
      args.push("--iterations", "1000", "--warmup", "200");
    }
    args.push("--output", output);

    let attempts = 0;
    let result;
    const started = Date.now();
    for (;;) {
      attempts += 1;
      result = spawnSync(process.execPath, args, {
        cwd: BASELINE_DIR,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: TMP },
        maxBuffer: 256 * 1024 * 1024,
      });
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 0 && STALE_LOCK.test(combined)) {
        writeFileSync(logPath, combined);
        appendFileSync(
          journal,
          `${new Date().toISOString()} ${name} STOPPED stale workspace lock; no lock file removed\n`
        );
        process.stderr.write(
          `STOP: stale workspace lock refused ${name}. No lock file was removed. Handle deliberately.\n`
        );
        process.exit(3);
      }
      const lockHeld =
        result.status !== 0 &&
        HELD_LOCK.test(combined) &&
        attempts < MAX_LOCK_ATTEMPTS;
      if (!lockHeld) break;
      process.stdout.write(`lock held, waiting 30s: ${name}\n`);
      sleep(30);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(logPath, combined);
    if (existsSync(output)) {
      execFileSync("gzip", ["-9", "-f", output]);
    } else {
      writeFileSync(`${logPath}.done`, "refused; log retained\n");
    }
    appendFileSync(
      journal,
      `${new Date().toISOString()} ${name} exit=${result.status} ${seconds}s attempts=${attempts}\n`
    );
    process.stdout.write(
      `${name} exit=${result.status} ${seconds}s attempts=${attempts}\n`
    );
  }
}
process.stdout.write(`${PASS} complete\n`);
