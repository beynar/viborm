import { defineConfig } from "vitest/config";
import { coverageOptionsForSubsystem } from "./scripts/coverage-policy.mjs";
import { projects } from "./vitest.workspace";

const subsystem = process.env.VIBORM_COVERAGE_SUBSYSTEM;
if (!subsystem) {
  throw new Error("VIBORM_COVERAGE_SUBSYSTEM is required.");
}

export default defineConfig({
  // The root of a focused coverage run: its own coverage over the workspace's
  // projects (Vitest 4 takes projects from the root configuration only).
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    projects,
    coverage: coverageOptionsForSubsystem(subsystem, {
      mode: process.env.VIBORM_COVERAGE_MODE ?? "focused",
      reportsDirectory: process.env.VIBORM_COVERAGE_DIRECTORY,
    }),
  },
});
