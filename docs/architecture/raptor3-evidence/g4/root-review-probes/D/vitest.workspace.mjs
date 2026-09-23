// Root review, area D — probe workspace. Extends the repository vitest config
// and includes only this directory. `.mjs` rather than `.ts` because
// `docs/tsconfig.json` extends an Astro preset that is not installed, so vite's
// esbuild transform cannot process a `.ts` file under `docs/`.
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "../../../../../../vitest.config.ts",
    test: {
      name: "root-review-D",
      include: [
        "docs/architecture/raptor3-evidence/g4/root-review-probes/D/**/*.test.mjs",
      ],
      setupFiles: [],
    },
  },
]);
