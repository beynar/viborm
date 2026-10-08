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
    "carries its published types on its own runtime dependencies",
    "./dependency-types-smoke.mjs",
  ],
  ["publishes exactly one Decimal constructor", "./decimal-identity-smoke.mjs"],
  [
    "matches the reviewed packed public surface golden",
    "./public-surface-golden-smoke.mjs",
  ],
  ["preserves packaged error names", "./error-names-smoke.mjs"],
  ["works without the optional OpenTelemetry peer", "./otel-absent-smoke.mjs"],
  [
    "lets a third party build soft delete from public exports alone",
    "./soft-delete-consumer-smoke.mjs",
  ],
  [
    "lets a third party build the guide's extension recipes from public exports alone",
    "./extension-recipes-consumer-smoke.mjs",
  ],
  ["enforces the release artifact contract", "./release-contract-smoke.mjs"],
  ["requires exact-main CI before release", "./release-ci-smoke.mjs"],
  [
    "keeps root/schema declarations independent of optional provider peers",
    "./optional-peer-declarations-smoke.mjs",
  ],
  [
    "supports genuine CommonJS runtime and typed consumers",
    "./commonjs-consumer-smoke.mjs",
  ],
  [
    "types and executes the documented provider setup contracts",
    "./driver-setup-consumer-smoke.mjs",
  ],
  [
    "loads installed CLI TypeScript configuration and environment files",
    "./cli-config-consumer-smoke.mjs",
  ],
  [
    "preserves dependency security regressions",
    "./security-dependencies-smoke.mjs",
  ],
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
  ...(["chain100", "chain200", "ring10"] as const).map(
    (fixture) =>
      [
        `retains TS5.9 public query inference for ${fixture}`,
        "./declaration-consumer-smoke.mjs",
        {
          VIBORM_DECLARATION_COMPILER: "TS5.9",
          VIBORM_DECLARATION_CASE: fixture,
        },
      ] as const
  ),
  ...(["TS5.8", "native"] as const).flatMap((compiler) =>
    (
      [
        "db",
        "chain2",
        "chain5",
        "chain30",
        "chain100",
        "chain200",
        "ring10",
      ] as const
    ).map(
      (fixture) =>
        [
          `retains ${compiler} public declarations for ${fixture}`,
          "./declaration-consumer-smoke.mjs",
          {
            VIBORM_DECLARATION_COMPILER: compiler,
            VIBORM_DECLARATION_CASE: fixture,
          },
        ] as const
    )
  ),
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
        timeout: 30_000,
        killSignal: "SIGKILL",
      });
    });
  }
});
