import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json";
import { VIBORM_VERSION } from "../../src/version";

describe("runtime version metadata", () => {
  it("uses package.json as the single version source", () => {
    expect(VIBORM_VERSION).toBe(packageMetadata.version);
  });
});
