import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";

const scripts = [
  [
    "imports every runtime export and resolves every type entry",
    "./exports-smoke.mjs",
  ],
  ["preserves packaged error names", "./error-names-smoke.mjs"],
  ["works without the optional OpenTelemetry peer", "./otel-absent-smoke.mjs"],
  [
    "preserves the published consumer type floor",
    "../../scripts/consumer-type-floor.mjs",
  ],
] as const;

describe("built package", () => {
  for (const [name, relativeScript] of scripts) {
    it(name, () => {
      const script = fileURLToPath(new URL(relativeScript, import.meta.url));
      execFileSync(process.execPath, [script], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          NODE_OPTIONS: "--max-old-space-size=768",
        },
        stdio: "pipe",
      });
    });
  }
});
