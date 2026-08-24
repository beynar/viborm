/** Commit-bound identity for every executable part of the comparison protocol. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PROTOCOL_PATHS = Object.freeze([
  "benchmarks/operation-pipeline-batch-workloads.mjs",
  "benchmarks/operation-pipeline-catalog.mjs",
  "benchmarks/operation-pipeline-compare.mjs",
  "benchmarks/operation-pipeline-fixtures.mjs",
  "benchmarks/operation-pipeline-harness.mjs",
  "benchmarks/operation-pipeline-mutation-workloads.mjs",
  "benchmarks/operation-pipeline-provider-fixtures.mjs",
  "benchmarks/operation-pipeline-provider-workloads.mjs",
  "benchmarks/operation-pipeline-protocol.mjs",
  "benchmarks/operation-pipeline-read-workloads.mjs",
  "benchmarks/operation-pipeline-report.mjs",
  "benchmarks/operation-pipeline-semantics.mjs",
  "benchmarks/operation-pipeline-worker.mjs",
  "benchmarks/operation-pipeline-workloads.mjs",
  "scripts/test-run-lock.mjs",
]);

export function protocolSha256(readContents) {
  const hash = createHash("sha256");
  for (const path of PROTOCOL_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(readContents(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function protocolIdentity(repositoryDirectory) {
  return {
    sha256: protocolSha256((path) =>
      readFileSync(join(repositoryDirectory, path))
    ),
    paths: PROTOCOL_PATHS,
  };
}

export function gitCommonDirectory(repositoryDirectory) {
  return resolve(
    execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: repositoryDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim()
  );
}
