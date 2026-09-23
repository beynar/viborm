import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = "/private/tmp/viborm-n4";
const probes = "/private/tmp/viborm-n4-A4-tmp";

export default {
  root,
  cacheDir: resolve(root, "node_modules/.vite-a4-probe"),
  server: { fs: { allow: [root, realpathSync(tmpdir()), probes] } },
  test: {
    root,
    globals: true,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    sequence: { hooks: "stack" },
    include: [`${probes}/*.probe.test.ts`],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@src": resolve(root, "src"),
      "@tests": resolve(root, "tests"),
      "@root": root,
      "@schema": resolve(root, "src/schema"),
      "@types": resolve(root, "src/types"),
      "@adapters": resolve(root, "src/adapters"),
      "@sql": resolve(root, "src/sql/sql.ts"),
      "@drivers": resolve(root, "src/drivers"),
      "@client": resolve(root, "src/client"),
      "@extensions": resolve(root, "src/extensions"),
      "@validation": resolve(root, "src/validation"),
      "@query-engine": resolve(root, "src/query-engine"),
      "@migrations": resolve(root, "src/migrations"),
      "@errors": resolve(root, "src/errors"),
      "@instrumentation": resolve(root, "src/instrumentation"),
      "@cache": resolve(root, "src/cache"),
    },
  },
};
