// The studio's CLI and server as one file. VibORM's own schema internals
// (relation resolution, the key catalog, config loading) are bundled from
// this repository's source through the root tsconfig's paths: the studio
// reads the models the application's client holds, which a matching
// `viborm` version builds (the peer range).
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "./src/bin.ts" },
  format: ["esm"],
  platform: "node",
  // TypeScript's syntax reader uses CommonJS filename globals at startup.
  shims: true,
  target: "node22",
  outDir: "./dist",
  clean: true,
  dts: false,
  sourcemap: false,
  minify: false,
  tsconfig: "../../tsconfig.json",
  external: ["jiti"],
});
