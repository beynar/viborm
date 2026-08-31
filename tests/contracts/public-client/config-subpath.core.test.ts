import { defineConfig as defineConfigFromCli } from "@src/cli/utils";
import { defineConfig as defineConfigFromSubpath } from "@src/config";

describe("configuration subpath", () => {
  it("reexports the documented configuration factory", () => {
    expect(defineConfigFromSubpath).toBe(defineConfigFromCli);
  });
});
