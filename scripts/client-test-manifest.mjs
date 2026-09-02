import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientTestRoot = resolve(projectRoot, "tests/contracts/public-client");

const deterministicExtendedTests = Object.freeze([
  "geopoint-provider-limit.test.ts",
  "omit-builder-types.test.ts",
]);

export const CLIENT_COVERAGE_TESTS = Object.freeze(
  [
    ...readdirSync(clientTestRoot).filter((file) =>
      file.endsWith(".core.test.ts")
    ),
    ...deterministicExtendedTests,
  ]
    .sort()
    .map((file) => `tests/contracts/public-client/${file}`)
);
