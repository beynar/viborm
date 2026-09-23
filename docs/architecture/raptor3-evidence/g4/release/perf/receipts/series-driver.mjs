/**
 * Release unit "perf": the frozen 20-cell series, shipped-engine tree against
 * the release tree.
 *
 * This is g4/cutover/receipts-stage2d/series-driver.mjs with FOUR mechanical
 * adaptations and NO change to its lock classification, its cell matrix, its
 * counts or its command shape:
 *   1. the two sides are the two release trees, not the two overlay worktrees
 *      (no phase adapter exists on either side: the 24 PROTOCOL_PATHS files are
 *      byte-identical between them, so neither arm carries an overlay commit
 *      and no --baseline-source-commit is passed);
 *   2. the receipts directory is this unit's;
 *   3. the cells are run in the order the brief requires — the cells the
 *      rulings (D-28 result seam, D-29 premise placement, D-58 boundary
 *      read-back) can touch first, then the rest. The SET of cells is g0.md's
 *      frozen 20, unchanged;
 *   4. TMPDIR: the integrator's /private/tmp/viborm-perf-tmp holds a STALE lock
 *      (PID 33729, dead since 2026-09-20T00:40Z) left by an earlier lane. No
 *      lock file is removed; this series runs under the subdirectory
 *      /private/tmp/viborm-perf-tmp/run so it takes a lock of its own.
 *
 * Lock classification, unchanged from stage 2d: a HELD lock is waited on
 * (30 s, up to 20 attempts); a STALE lock stops the series; no lock file is
 * ever removed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PASS = process.argv[2];
if (!/^pass[12]$/.test(PASS)) {
  process.stderr.write("usage: series-driver.mjs pass1|pass2\n");
  process.exit(2);
}

const BASELINE_DIR = "/private/tmp/viborm-perf-baseline";
const CANDIDATE_DIR = "/private/tmp/viborm-perf-cand";
const BASELINE_COMMIT = "5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062";
const CANDIDATE_COMMIT = "36c87710aa2526652867430f6e24f30005556394";
const RECEIPTS =
  "/private/tmp/viborm-perf/docs/architecture/raptor3-evidence/g4/release/perf/receipts/cells";
const TMP = process.env.VIBORM_SERIES_TMPDIR ?? "/private/tmp/viborm-perf-tmp/run";

mkdirSync(RECEIPTS, { recursive: true });
const journal = join(RECEIPTS, `${PASS}-journal.txt`);

/**
 * The frozen 20-cell matrix (g0.md, version 1), reordered: the twelve cells the
 * rulings can touch first (brief §1), then the remaining eight.
 */
const CELLS = [
  // D-29 (a queued premise rides the atomic unit it protects)
  ["flat-scalar-update", "prepare"],
  ["flat-scalar-update", "execute"],
  ["flat-scalar-update", "full"],
  // D-29 + D-28 (result seam) + D-58 (boundary read-back, candidate only)
  ["nested-conditional-found", "full"],
  ["nested-conditional-missing", "full"],
  ["key-transition-cascade", "full"],
  ["relation-series-2", "full"],
  ["bulk-update-returning-100", "full"],
  // D-28 only (the decode boundary)
  ["fixed-collection-rowref-1000", "parse"],
  ["scalar-find-unique", "full"],
  ["fixed-collection-rowref-20", "full"],
  ["fixed-collection-rowref-1000", "full"],
  // the rest of the frozen matrix
  ["scalar-find-unique", "cold-prepare"],
  ["scalar-find-unique", "prepare"],
  ["scalar-find-unique", "execute"],
  ["fixed-collection-rowref-20", "prepare"],
  ["fixed-collection-rowref-20", "execute"],
  ["bulk-update-returning-100", "prepare"],
  ["fixed-collection-rowref-1000", "prepare"],
  ["fixed-collection-rowref-1000", "execute"],
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
