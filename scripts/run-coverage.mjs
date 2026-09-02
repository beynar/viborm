import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_PROJECT_ROOT,
  coverageSubsystem,
  coverageSubsystems,
  waiversForSubsystem,
} from "./coverage-policy.mjs";
import {
  mergeCoverageShards,
  mergeSubsystemCoverageRuns,
} from "./merge-coverage.mjs";
import { acquireTestRunLock } from "./test-run-lock.mjs";

const requested = process.argv[2];
if (!requested) {
  process.stderr.write("Usage: run-coverage.mjs <all|subsystem>\n");
  process.exit(2);
}
const selected =
  requested === "all" ? coverageSubsystems : [coverageSubsystem(requested)];
const shardRoot = resolve(COVERAGE_PROJECT_ROOT, "coverage/.shards");
const vitestRunner = fileURLToPath(
  new URL("./run-vitest-safe.mjs", import.meta.url)
);
let activeChild;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = true;
    activeChild?.kill(signal);
  });
}

function runSubsystem(subsystem, mode) {
  const reportDirectory =
    mode === "shard"
      ? resolve(shardRoot, subsystem.id)
      : resolve(COVERAGE_PROJECT_ROOT, `coverage/${subsystem.id}`);
  rmSync(reportDirectory, { force: true, recursive: true });
  mkdirSync(reportDirectory, { recursive: true });
  process.stdout.write(
    `Coverage ${subsystem.label}: ${subsystem.sources.length} source files, ${subsystem.target}% target.\n`
  );
  for (const waiver of waiversForSubsystem(subsystem.id)) {
    process.stdout.write(
      `Coverage waiver ${waiver.id}: ${waiver.reason} Sources remain in the denominator: ${waiver.sources.join(", ")}\n`
    );
  }
  return (async () => {
    const partRoot = resolve(reportDirectory, ".parts");
    const inputFiles = [];
    let runs;
    if (subsystem.testGroups?.length) {
      runs = subsystem.testGroups.map((tests) => ({
        project: subsystem.projects[0],
        tests,
      }));
    } else if (!subsystem.tests?.length) {
      runs = subsystem.projects.map((project) => ({ project, tests: [] }));
    } else if (subsystem.chunkSize) {
      runs = [];
      for (
        let offset = 0;
        offset < subsystem.tests.length;
        offset += subsystem.chunkSize
      ) {
        runs.push({
          project: subsystem.projects[0],
          tests: subsystem.tests.slice(offset, offset + subsystem.chunkSize),
        });
      }
    } else {
      runs = [{ project: subsystem.projects[0], tests: subsystem.tests }];
    }
    for (const [index, run] of runs.entries()) {
      const { project, tests } = run;
      const partDirectory = resolve(
        partRoot,
        `${String(index + 1).padStart(2, "0")}-${project}`
      );
      mkdirSync(partDirectory, { recursive: true });
      const selection = tests.length ? ` (${tests.length} explicit tests)` : "";
      process.stdout.write(
        `Coverage ${subsystem.label} part ${index + 1}/${runs.length}: ${project}${selection}.\n`
      );
      activeChild = spawn(
        process.execPath,
        [
          vitestRunner,
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
      const exitCode = await new Promise((resolvePromise) => {
        activeChild.once("error", () => resolvePromise(1));
        activeChild.once("close", (code, signal) => {
          activeChild = undefined;
          resolvePromise(code ?? (signal ? 1 : 0));
        });
      });
      if (exitCode !== 0) return exitCode;
      inputFiles.push(resolve(partDirectory, "coverage-final.json"));
    }

    mergeSubsystemCoverageRuns({
      inputFiles,
      projectRoot: COVERAGE_PROJECT_ROOT,
      reportDirectory,
      reporterNames:
        mode === "focused" ? ["text", "json-summary", "lcovonly", "html"] : [],
      subsystem,
    });
    rmSync(partRoot, { force: true, recursive: true });
    return 0;
  })();
}

let releaseTestRunLock;
try {
  releaseTestRunLock = acquireTestRunLock(`coverage-${requested}`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}

let failed = false;
try {
  if (requested === "all") {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: COVERAGE_PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
    process.stdout.write(`Global coverage shards for Git commit ${commit}.\n`);
    rmSync(resolve(COVERAGE_PROJECT_ROOT, "coverage"), {
      force: true,
      recursive: true,
    });
  }

  for (const subsystem of selected) {
    if (interrupted) {
      failed = true;
      break;
    }
    const exitCode = await runSubsystem(
      subsystem,
      requested === "all" ? "shard" : "focused"
    );
    if (exitCode !== 0) {
      failed = true;
      break;
    }
  }

  if (requested === "all" && !failed && !interrupted) {
    const reportDirectory = resolve(COVERAGE_PROJECT_ROOT, "coverage");
    const { commit, dirty } = mergeCoverageShards({
      projectRoot: COVERAGE_PROJECT_ROOT,
      reportDirectory,
      shardDirectory: shardRoot,
    });
    process.stdout.write(
      `Merged global coverage for Git commit ${commit}${dirty ? " with uncommitted changes" : ""}. Report: coverage/index.html\n`
    );
  }
} finally {
  releaseTestRunLock();
}

if (failed || interrupted) process.exitCode = 1;
