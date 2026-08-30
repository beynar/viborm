import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { describe, it } from "vitest";

const scripts = [
  [
    "shares only genuine built operation identity with benchmark harnesses",
    "./benchmark-operation-smoke.mjs",
  ],
  [
    "imports every runtime export and resolves every type entry",
    "./exports-smoke.mjs",
  ],
  [
    "matches the reviewed packed public surface golden",
    "./public-surface-golden-smoke.mjs",
  ],
  ["preserves packaged error names", "./error-names-smoke.mjs"],
  ["works without the optional OpenTelemetry peer", "./otel-absent-smoke.mjs"],
  ["enforces the release artifact contract", "./release-contract-smoke.mjs"],
  [
    "resumes and verifies GitHub release publication",
    "./github-release-smoke.mjs",
  ],
  [
    "preserves the published consumer type floor",
    "../../scripts/consumer-type-floor.mjs",
  ],
  [
    "supports the documented TypeScript 5.8 consumer floor",
    "../../scripts/consumer-type-floor.mjs",
    { VIBORM_TYPESCRIPT_BIN: "node_modules/typescript-5-8/bin/tsc" },
  ],
] as const;

describe("built package", () => {
  for (const [name, relativeScript, scriptEnv] of scripts) {
    it(name, () => {
      const script = fileURLToPath(new URL(relativeScript, import.meta.url));
      execFileSync(process.execPath, [script], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          NODE_OPTIONS: "--max-old-space-size=768",
          ...scriptEnv,
        },
        stdio: "pipe",
      });
    });
  }
});
