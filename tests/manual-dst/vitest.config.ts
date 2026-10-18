import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config";

// Deliberately absent from vitest.workspace.ts and all CI manifests.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      workspace: [
        {
          extends: true,
          test: {
            name: "manual-dst",
            include: ["tests/manual-dst/campaign.ts"],
          },
        },
      ],
      include: ["tests/manual-dst/campaign.ts"],
      testTimeout: 30_000,
    },
  })
);
