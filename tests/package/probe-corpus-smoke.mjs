/**
 * The probe-corpus runner through `pnpm probes`, against the packed package,
 * on its self-test probes (`probes/runner/`): a passing probe reaches viborm
 * and a linked driver in the consumer, one holding more than the ordinary
 * 1536 MiB process-group ceiling passes under its own allowance, a failing one
 * is reported as fail, one needing Postgres without its URL is skipped, a
 * hanging one is killed at the time limit and reported as error under its own
 * id, and `--expect pass` turns only the last two into a failed gate.
 * Interrupting `pnpm probes` kills the running probe, which has its own process
 * group, and writes no report.
 *
 * Run after `pnpm package:build`. `VIBORM_PACKAGE_TARBALL` names an existing
 * tarball instead of packing one.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseLiveProcessGroupMemberCount } from "../../scripts/bounded-process.mjs";
import {
  currentAncestors,
  parseProcessTable,
} from "../../scripts/test-run-lock.mjs";
import { repositoryRoot } from "./packed-consumer.mjs";

const { VIBORM_PROBE_PG_URL, VIBORM_PROBE_MYSQL_URL, ...env } = process.env;
const scratch = mkdtempSync(join(tmpdir(), "viborm-probe-corpus-smoke-"));
// Below package.test.ts's 30 s smoke limit, so a stalled interrupt case fails
// here rather than leaving its detached launcher group behind.
const DEADLINE_MS = 15_000;

const corpus = (...options) =>
  spawnSync(
    "pnpm",
    ["probes", "--timeout", "5000", "--expect", "pass", ...options],
    { cwd: repositoryRoot, encoding: "utf8", env }
  );
const ps = (format) =>
  execFileSync("ps", ["-ww", "-axo", format], { encoding: "utf8" });
const isLive = (pid) => {
  const row = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return row.status === 0 && !row.stdout.trim().startsWith("Z");
};
const check = (condition, message, run) => {
  if (!condition) {
    throw new Error(`${message}\n${run.stdout}${run.stderr}`);
  }
};

try {
  const report = join(scratch, "report.json");
  const all = corpus("--only", "runner/*", "--json", report);
  check(all.status === 1, "--expect pass must fail on fail and error", all);
  check(
    all.stderr.includes("RUNNER-FAIL fail, RUNNER-HANG error"),
    "--expect pass must name exactly the unmet probes",
    all
  );
  const statuses = Object.fromEntries(
    JSON.parse(readFileSync(report, "utf8")).probes.map((probe) => [
      probe.id,
      probe.status,
    ])
  );
  const expected = {
    "RUNNER-FAIL": "fail",
    "RUNNER-HANG": "error",
    "RUNNER-MEMORY": "pass",
    "RUNNER-NEEDS-PG": "skip",
    "RUNNER-PASS": "pass",
  };
  check(
    JSON.stringify(statuses) === JSON.stringify(expected),
    `Statuses ${JSON.stringify(statuses)}, expected ${JSON.stringify(expected)}`,
    all
  );

  const pass = corpus("--only", "runner/pass");
  check(pass.status === 0, "A passing selection must pass the gate", pass);

  // Ctrl-C reaches the launcher's process group, not the probe's.
  const interruptedReport = join(scratch, "interrupted.json");
  const launcher = spawn(
    "pnpm",
    [
      "probes",
      "--only",
      "runner/hang",
      "--timeout",
      String(DEADLINE_MS),
      "--json",
      interruptedReport,
    ],
    { cwd: repositoryRoot, detached: true, env, stdio: "ignore" }
  );
  const deadline = Date.now() + DEADLINE_MS;
  let probe;
  while (!probe && Date.now() < deadline) {
    await sleep(100);
    const processes = parseProcessTable(ps("pid=,ppid=,command="));
    probe = processes.find(
      (entry) =>
        entry.command.includes("--probe-child") &&
        entry.command.includes("hang.probe.mjs") &&
        currentAncestors(processes, entry.pid).has(launcher.pid)
    );
  }
  process.kill(-launcher.pid, "SIGINT");
  if (!probe) throw new Error("The hang probe never started.");
  while (
    parseLiveProcessGroupMemberCount(ps("pgid=,stat="), launcher.pid) > 0 &&
    Date.now() < deadline
  ) {
    await sleep(100);
  }
  if (isLive(probe.pid)) {
    process.kill(probe.pid, "SIGKILL");
    throw new Error(
      `Probe process ${probe.pid} outlived the interrupted pnpm probes.`
    );
  }
  if (parseLiveProcessGroupMemberCount(ps("pgid=,stat="), launcher.pid) > 0) {
    process.kill(-launcher.pid, "SIGKILL");
    throw new Error("The interrupted pnpm probes did not exit.");
  }
  if (existsSync(interruptedReport)) {
    throw new Error("An interrupted run must not write its report.");
  }
  console.log("probe corpus runner: pass");
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
