/**
 * Runner for the G4-02 author checks.
 *
 * `scripts/credential-free-test-manifest.mjs` excludes
 * `tests/raptor3/g4/unit02/` from `extended-local` ("still its author's, with
 * no registered mode; promoting it is that stream's request to make"), so these
 * files belong to no registered project. This workspace exists only so the
 * checks run through the ordinary bounded runner and the workspace lock:
 *
 *   node scripts/run-vitest-safe.mjs run \
 *     --config=tests/raptor3/g4/unit02/unit02.workspace.ts \
 *     tests/raptor3/g4/unit02/
 *
 * The registration request (a `g4-unit02-author` mode beside `g4-unit01-author`)
 * is recorded in `g4/unit02/note.md`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.config.ts",
        test: {
          name: "g4-unit02-author",
          include: ["tests/raptor3/g4/unit02/*.test.ts"],
        },
      },
    ],
  },
});
