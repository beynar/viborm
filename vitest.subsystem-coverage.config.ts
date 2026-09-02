import { defineConfig } from "vitest/config";
import { coverageOptionsForSubsystem } from "./scripts/coverage-policy.mjs";

const subsystem = process.env.VIBORM_COVERAGE_SUBSYSTEM;
if (!subsystem) {
  throw new Error("VIBORM_COVERAGE_SUBSYSTEM is required.");
}

export default defineConfig({
  test: {
    coverage: coverageOptionsForSubsystem(subsystem, {
      mode: process.env.VIBORM_COVERAGE_MODE ?? "focused",
      reportsDirectory: process.env.VIBORM_COVERAGE_DIRECTORY,
    }),
  },
});
