// Reviewer-only config: the registered `raptor3` project admits an explicit
// file list, so an unregistered review probe needs its own selection. It
// extends the repository config unchanged (aliases, pool, setup files) and
// only narrows `include` to this directory.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../../../vitest.config";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      name: "review-cutover",
      root: new URL("../../../../../", import.meta.url).pathname,
      include: ["tests/raptor3/g4/review/cutover/**/*.review.test.ts"],
    },
  })
);
