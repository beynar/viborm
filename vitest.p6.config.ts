import baseConfig from "./vitest.config";
import { mergeConfig } from "vitest/config";

export default mergeConfig(baseConfig, {
  test: {
    setupFiles: ["tests/cli/_clack.ts", "tests/_p6-probe.setup.ts"],
  },
});
