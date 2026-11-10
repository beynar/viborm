// VibORM Studio as one Bun executable (proof of concept, see bun/README.md):
//   pnpm --filter @viborm/studio compile
// The app is embedded as text; the user's TypeScript config is imported by
// Bun's own runtime transpiler, and its imports (viborm, the driver) resolve
// from the config's directory, i.e. the user's node_modules. Bun caches what
// it imports, so the binary does not watch for changes.
import { parseArgs } from "node:util";
import { runStudio } from "../src/run";
import html from "../ui/dist/index.html" with { type: "text" };

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    open: { type: "boolean", default: true },
  },
  allowNegative: true,
});

await runStudio({
  cwd: process.cwd(),
  config: values.config,
  html,
  port: values.port === undefined ? undefined : Number(values.port),
  open: values.open,
  watch: false,
  importer: (path) => import(path),
});
