import { describe, expect, it } from "vitest";
import { inventory } from "../../../scripts/closure-final-inventory.mjs";

/**
 * The qualification gate's registered inventory, pinned.
 *
 * The final local closure's gate enumerated its native MySQL lane with a
 * hand-written shell glob and ran eleven of the thirteen files
 * `vitest.workspace.ts` registers in `provider-mysql2`, then reported the
 * result as the project's. `scripts/closure-final-inventory.mjs` replaced the
 * glob with the workspace's own include patterns, expanded over the test tree.
 *
 * That repair was checked by hand, and a hand-checked parser stays repaired
 * only until it drifts. The two cells below are the standing oracle: the first
 * names the two files the glob missed, because those are the ones whose
 * absence was invisible; the second states that the only test files no project
 * registers are the review scratch suites
 * `scripts/credential-free-test-manifest.mjs` deliberately excludes — so a
 * witness landed outside every include pattern turns this red instead of
 * passing unrun.
 *
 * Both readings come from the inventory itself, so neither can agree with a
 * stale copy: there is no copy.
 *
 * Falsified: narrow a `providerProject("mysql2", …)` include pattern, break
 * the include-array parser or the glob expansion, or add a `.test.ts` under a
 * directory no project registers — each turns exactly one cell red and names
 * the file at fault.
 */

type RegisteredInventory = {
  readonly projects: ReadonlyArray<{
    readonly project: string;
    readonly files: readonly string[];
  }>;
  readonly unregistered: readonly string[];
};

/** The two `provider-mysql2` files the gate's glob could not reach. */
const OMITTED_BY_THE_GATE_GLOB = [
  "tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts",
  "tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts",
];

const REVIEW_SCRATCH_PREFIX = "tests/raptor3/g4/review/";

describe("the qualification gate's registered inventory", () => {
  it("registers both files the native MySQL glob missed in provider-mysql2", async () => {
    const current = (await inventory()) as RegisteredInventory;
    const files =
      current.projects.find((project) => project.project === "provider-mysql2")
        ?.files ?? [];

    expect(files).toEqual(expect.arrayContaining(OMITTED_BY_THE_GATE_GLOB));
  });

  it("registers every test file outside the review scratch directory", async () => {
    const current = (await inventory()) as RegisteredInventory;

    expect(
      current.unregistered.filter(
        (file) => !file.startsWith(REVIEW_SCRATCH_PREFIX)
      )
    ).toEqual([]);
  });
});
