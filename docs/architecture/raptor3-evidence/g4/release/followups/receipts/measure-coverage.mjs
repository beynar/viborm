// Support file for follow-up F-3: measure a coverage subsystem's four metrics
// WITHOUT aborting on a failing test.
//
// `scripts/run-coverage.mjs` returns the first part's non-zero exit code before
// it merges, so a pre-existing red anywhere in a part's project (here: the
// inventory cell of `tests/contracts/architecture/contract-matrix.core.test.ts`,
// which another lane owns) yields no numbers at all. F-3 needs the numbers to
// SET the floors. This runs the same parts, the same way, keeps every part's
// `coverage-final.json` regardless of the exit code, and merges them through the
// estate's own `mergeSubsystemCoverageRuns`, which prints each measured metric
// beside the floor it enforces.
//
// It is a MEASUREMENT tool, not a gate: it never decides pass or fail.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  COVERAGE_PROJECT_ROOT,
  coverageSubsystem,
} from "../../../../../../../scripts/coverage-policy.mjs";
import { mergeSubsystemCoverageRuns } from "../../../../../../../scripts/merge-coverage.mjs";

const id = process.argv[2];
if (!id) {
  process.stderr.write("Usage: measure-coverage.mjs <subsystem>\n");
  process.exit(2);
}
const subsystem = coverageSubsystem(id);
const reportDirectory = resolve(
  COVERAGE_PROJECT_ROOT,
  `coverage/measure-${id}`
);
rmSync(reportDirectory, { force: true, recursive: true });
mkdirSync(reportDirectory, { recursive: true });
const partRoot = resolve(reportDirectory, ".parts");

const runs = subsystem.testGroups?.length
  ? subsystem.testGroups.map((tests) => ({
      project: subsystem.projects[0],
      tests,
    }))
  : subsystem.tests?.length
    ? [{ project: subsystem.projects[0], tests: [...subsystem.tests] }]
    : subsystem.projects.map((project) => ({ project, tests: [] }));

process.stdout.write(
  `Measuring ${subsystem.label}: ${subsystem.sources.length} sources, ${runs.length} parts.\n`
);
const inputFiles = [];
for (const [index, { project, tests }] of runs.entries()) {
  const partDirectory = resolve(
    partRoot,
    `${String(index + 1).padStart(2, "0")}-${project}`
  );
  mkdirSync(partDirectory, { recursive: true });
  process.stdout.write(
    `Part ${index + 1}/${runs.length}: ${project}${tests.length ? ` (${tests.length} tests)` : ""}\n`
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(COVERAGE_PROJECT_ROOT, "scripts/run-vitest-safe.mjs"),
      ...(subsystem.heapLimitMb
        ? [`--heap-limit-mb=${subsystem.heapLimitMb}`]
        : []),
      "--wall-limit-ms=600000",
      "run",
      ...tests,
      "--config",
      "vitest.subsystem-coverage.config.ts",
      "--workspace",
      "vitest.workspace.ts",
      "--project",
      project,
      "--reporter=dot",
      "--coverage",
      // A failing part must still write its coverage: the whole point is to
      // measure the estate that DID run.
      "--coverage.reportOnFailure",
    ],
    {
      cwd: COVERAGE_PROJECT_ROOT,
      env: {
        ...process.env,
        VIBORM_COVERAGE_DIRECTORY: partDirectory,
        VIBORM_COVERAGE_MODE: "part",
        VIBORM_COVERAGE_SUBSYSTEM: subsystem.id,
      },
      stdio: "inherit",
    }
  );
  const partFile = resolve(partDirectory, "coverage-final.json");
  if (!existsSync(partFile)) {
    process.stderr.write(`Part ${index + 1} produced no coverage-final.json.\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(
      `Part ${index + 1} exited ${result.status} (tests red); its coverage is still counted.\n`
    );
  }
  inputFiles.push(partFile);
}
try {
  mergeSubsystemCoverageRuns({
    inputFiles,
    projectRoot: COVERAGE_PROJECT_ROOT,
    reportDirectory,
    reporterNames: ["json-summary"],
    subsystem,
  });
  process.stdout.write("Every metric is at or above its current floor.\n");
} catch (error) {
  process.stdout.write(
    `Measured below a current floor: ${error instanceof Error ? error.message : String(error)}\n`
  );
}
