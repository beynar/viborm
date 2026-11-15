import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientTestRoot = resolve(projectRoot, "tests/contracts/public-client");

const deterministicExtendedTests = Object.freeze([
  "geopoint-provider-limit.test.ts",
  "omit-builder-types.test.ts",
]);

const contracts = [
  ...readdirSync(clientTestRoot).filter((file) =>
    file.endsWith(".core.test.ts")
  ),
  ...deterministicExtendedTests,
]
  .sort()
  .map((file) => `tests/contracts/public-client/${file}`);

/**
 * In-memory SQLite suites that hold client code no contract reaches: a
 * model's `$rows()` and `$sql`, and a `$through` hop on a governed client.
 */
const localProviders = [
  "tests/providers/local/sqlite3-raw-rows.test.ts",
  "tests/providers/local/sqlite3-through-model-governed.test.ts",
];

export const CLIENT_COVERAGE_TESTS = Object.freeze([
  ...contracts,
  ...localProviders,
]);

/**
 * One bounded process for the contracts (they peak near 1,300 MiB
 * instrumented), one for each local suite; the parts merge under the floors.
 */
export const CLIENT_COVERAGE_TEST_GROUPS = Object.freeze([
  contracts,
  ...localProviders.map((test) => [test]),
]);
