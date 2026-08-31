import packageMetadata from "@root/package.json";
import { VIBORM_VERSION } from "@src/version";
import { describe, expect, it } from "vitest";

describe("runtime version metadata", () => {
  it("uses package.json as the single version source", () => {
    expect(VIBORM_VERSION).toBe(packageMetadata.version);
  });
});
