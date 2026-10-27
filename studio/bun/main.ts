// VibORM Studio as one Bun executable (proof of concept, see studio/bun/README.md):
//   bun build --compile --bytecode --minify studio/bun/main.ts --outfile viborm-studio
// The app is embedded as text; the user's TypeScript config is imported by
// Bun's own runtime transpiler, and its imports (viborm, the driver) resolve
// from the config's directory, i.e. the user's node_modules.
import { parseArgs } from "node:util";
import { DEFAULT_STUDIO_PORT } from "../../src/studio/port";
import { runStudio } from "../../src/studio/run";
import html from "../ui/dist/index.html" with { type: "text" };

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    open: { type: "boolean", default: true },
    "no-open": { type: "boolean", default: false },
  },
});

await runStudio({
  config: values.config,
  html,
  importer: (path) => import(path),
  port: values.port === undefined ? undefined : Number(values.port),
  defaultPort: DEFAULT_STUDIO_PORT,
  open: values.open && !values["no-open"],
});
