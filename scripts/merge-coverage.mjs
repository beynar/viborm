import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { coverageSubsystems, coverageWaivers } from "./coverage-policy.mjs";

const coveragePackageRequire = createRequire(
  import.meta.resolve("@vitest/coverage-v8")
);
const { createCoverageMap } = coveragePackageRequire("istanbul-lib-coverage");
const { createContext } = coveragePackageRequire("istanbul-lib-report");
const reports = coveragePackageRequire("istanbul-reports");

const metrics = ["statements", "branches", "functions", "lines"];

function coverageCommit(projectRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function coverageWorkingTreeIsDirty(projectRoot) {
  return (
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim().length > 0
  );
}

function sourcePath(projectRoot, file) {
  const prefix = `${resolve(projectRoot)}/`;
  return resolve(file).startsWith(prefix)
    ? resolve(file).slice(prefix.length).split("\\").join("/")
    : undefined;
}

export function mergeSubsystemCoverageRuns({
  inputFiles,
  projectRoot,
  reportDirectory,
  reporterNames,
  subsystem,
}) {
  const merged = createCoverageMap({});
  for (const inputFile of inputFiles) {
    merged.merge(JSON.parse(readFileSync(inputFile, "utf8")));
  }

  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    resolve(reportDirectory, "coverage-final.json"),
    JSON.stringify(merged.toJSON())
  );
  if (reporterNames.length) {
    const context = createContext({
      coverageMap: merged,
      dir: reportDirectory,
    });
    for (const reporter of reporterNames) {
      reports.create(reporter).execute(context);
    }
  }

  const failures = [];
  const present = new Set(
    merged.files().map((file) => sourcePath(projectRoot, file))
  );
  for (const source of subsystem.sources) {
    if (!present.has(source)) {
      failures.push(
        `${subsystem.label}: missing ${source} from merged coverage.`
      );
    }
  }
  const summary = merged.getCoverageSummary().toJSON();
  // Always print the RESOLVED threshold beside the measured value. A subsystem
  // may carry a per-metric floor below its nominal target, and a reader must be
  // able to see the number actually enforced rather than infer it.
  process.stderr.write(
    `${subsystem.label} thresholds: ${metrics
      .map((metric) => {
        const target = subsystem.metricTargets?.[metric] ?? subsystem.target;
        return `${metric} ${summary[metric].pct}% (floor ${target}%)`;
      })
      .join(", ")}\n`
  );
  for (const metric of metrics) {
    // A subsystem may declare a lower floor for ONE metric without dropping the
    // others: branch coverage capped by unreachable defensive guards should not
    // drag its statement floor down with it.
    const target = subsystem.metricTargets?.[metric] ?? subsystem.target;
    if (summary[metric].pct < target) {
      failures.push(
        `${subsystem.label}: ${metric} ${summary[metric].pct}% is below ${target}%.`
      );
    }
  }
  if (failures.length) {
    throw new Error(`Coverage policy failed:\n${failures.join("\n")}`);
  }
  return merged;
}

export function mergeCoverageShards({
  projectRoot,
  shardDirectory,
  reportDirectory,
}) {
  const merged = createCoverageMap({});
  for (const subsystem of coverageSubsystems) {
    const shardPath = resolve(
      shardDirectory,
      subsystem.id,
      "coverage-final.json"
    );
    merged.merge(JSON.parse(readFileSync(shardPath, "utf8")));
  }

  const failures = [];
  for (const subsystem of coverageSubsystems) {
    const expected = new Set(subsystem.sources);
    const subsystemMap = createCoverageMap({});
    for (const file of merged.files()) {
      const source = sourcePath(projectRoot, file);
      if (source && expected.has(source))
        subsystemMap.addFileCoverage(merged.fileCoverageFor(file));
    }
    const present = new Set(
      subsystemMap.files().map((file) => sourcePath(projectRoot, file))
    );
    for (const source of expected) {
      if (!present.has(source))
        failures.push(
          `${subsystem.label}: missing ${source} from merged coverage.`
        );
    }
    const summary = subsystemMap.getCoverageSummary().toJSON();
    for (const metric of metrics) {
      // Same per-metric floors the focused lanes honour, so the aggregate gate
      // and `pnpm test:coverage:<lane>` cannot disagree about a subsystem.
      const target = subsystem.metricTargets?.[metric] ?? subsystem.target;
      if (summary[metric].pct < target) {
        failures.push(
          `${subsystem.label}: ${metric} ${summary[metric].pct}% is below ${target}%.`
        );
      }
    }
  }
  if (failures.length)
    throw new Error(`Coverage policy failed:\n${failures.join("\n")}`);

  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    resolve(reportDirectory, "coverage-final.json"),
    JSON.stringify(merged.toJSON())
  );
  const context = createContext({ coverageMap: merged, dir: reportDirectory });
  for (const reporter of ["text", "json-summary", "lcovonly", "html"]) {
    reports.create(reporter).execute(context);
  }

  const commit = coverageCommit(projectRoot);
  const dirty = coverageWorkingTreeIsDirty(projectRoot);
  writeFileSync(
    resolve(reportDirectory, "metadata.json"),
    `${JSON.stringify(
      {
        commit,
        dirty,
        generatedAt: new Date().toISOString(),
        subsystems: coverageSubsystems.map(({ id, target, metricTargets }) => ({
          id,
          target,
          metricTargets,
        })),
        waivers: coverageWaivers,
      },
      null,
      2
    )}\n`
  );
  return { commit, dirty, merged };
}
