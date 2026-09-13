import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * The `bun-sqlite` driver's other tests are `vi.fn()` fakes: they prove viborm
 * handles a well-formed response and prove nothing about what `bun:sqlite`
 * actually returns. This runs the real thing.
 *
 * vitest cannot load `bun:sqlite`, so the assertions live in a script Bun runs
 * (`bun-sqlite-runtime-probe.ts`) and this test only reports its exit code.
 * The probe drives the whole client — migrations, create, findUnique, include,
 * both raw forms — against an in-memory `bun:sqlite`, so it covers the driver
 * as it is actually used rather than the provider API in isolation. Two value
 * families cross it that no fake can settle: a big.js `Decimal`, and a natively
 * generated identifier in the 16-byte BLOB column its format chose.
 *
 * Skipped, not failed, when Bun is not installed.
 */

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });

const probePath = fileURLToPath(
  new URL("./bun-sqlite-runtime-probe.ts", import.meta.url)
);

test.runIf(bunVersion.status === 0)(
  "bun:sqlite proves fixed-decimal and identifier transport on the real runtime",
  () => {
    const result = spawnSync("bun", ["run", probePath], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("fixed-decimal evidence passed");
    expect(result.stdout).toContain("native identifier evidence passed");
  }
);
