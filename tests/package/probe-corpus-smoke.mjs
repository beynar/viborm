/**
 * The probe-corpus runner (`scripts/probe-corpus.mjs`) end to end, against the
 * packed package, on its self-test probes (`probes/runner/`): a passing probe
 * reaches viborm and a linked driver in the consumer, a failing one is
 * reported as fail, one needing Postgres without its URL is skipped, a hanging
 * one is killed at the time limit and reported as error under its own id, and
 * `--expect pass` turns only the last two into a failed gate.
 *
 * Run after `pnpm package:build`. `VIBORM_PACKAGE_TARBALL` names an existing
 * tarball instead of packing one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "./packed-consumer.mjs";

const runner = join(repositoryRoot, "scripts", "probe-corpus.mjs");
const { VIBORM_PROBE_PG_URL, VIBORM_PROBE_MYSQL_URL, ...env } = process.env;
const scratch = mkdtempSync(join(tmpdir(), "viborm-probe-corpus-smoke-"));

const corpus = (...options) =>
  spawnSync(
    process.execPath,
    [runner, "--timeout", "5000", "--expect", "pass", ...options],
    { cwd: repositoryRoot, encoding: "utf8", env }
  );
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
  console.log("probe corpus runner: pass");
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
