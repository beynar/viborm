import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const driverContractRoot = resolve(projectRoot, "tests/contracts/drivers");

export const DRIVER_CORE_TESTS = Object.freeze(
  readdirSync(driverContractRoot)
    .filter((file) => file.endsWith(".core.test.ts"))
    .sort()
    .map((file) => `tests/contracts/drivers/${file}`)
);

const localProviderContracts = Object.freeze([
  "tests/contracts/drivers/consumable-result-rows.provider.test.ts",
  "tests/contracts/drivers/sqlite-binary-values.provider.test.ts",
  "tests/contracts/drivers/sqlite-integer-safety.provider.test.ts",
  "tests/contracts/drivers/sqlite-native-datetime.provider.test.ts",
  "tests/contracts/drivers/sqlite-statement-execution.provider.test.ts",
]);

const localProviderSuites = Object.freeze([
  "tests/providers/local/libsql.test.ts",
  "tests/providers/local/sqlite3.test.ts",
]);

const DRIVER_CORE_COVERAGE_CHUNK_SIZE = 8;

const providerHeavyCoreContracts = new Set([
  "tests/contracts/drivers/bind-parameter-capacity.core.test.ts",
  "tests/contracts/drivers/driver-export-surface.core.test.ts",
  "tests/contracts/drivers/namespace-execution-target.core.test.ts",
  "tests/contracts/drivers/namespace-options.core.test.ts",
  "tests/contracts/drivers/pglite-controlled-transport-coverage.core.test.ts",
  "tests/contracts/drivers/provider-result-contracts.core.test.ts",
  "tests/contracts/drivers/sqlite-binary-values.core.test.ts",
  "tests/contracts/drivers/supplied-pool-ownership.core.test.ts",
  "tests/contracts/drivers/transaction-lifecycle.core.test.ts",
  "tests/contracts/drivers/transaction-options-behavior.core.test.ts",
  "tests/contracts/drivers/transaction-portability.core.test.ts",
]);

function coreCoverageGroups() {
  const groups = [];
  let providerFree = [];
  const flushProviderFree = () => {
    if (providerFree.length === 0) return;
    groups.push(Object.freeze(providerFree));
    providerFree = [];
  };

  for (const test of DRIVER_CORE_TESTS) {
    if (providerHeavyCoreContracts.has(test)) {
      flushProviderFree();
      groups.push(Object.freeze([test]));
      continue;
    }
    providerFree.push(test);
    if (providerFree.length === DRIVER_CORE_COVERAGE_CHUNK_SIZE) {
      flushProviderFree();
    }
  }
  flushProviderFree();
  return groups;
}

export const DRIVER_COVERAGE_TESTS = Object.freeze([
  ...DRIVER_CORE_TESTS,
  ...localProviderContracts,
  ...localProviderSuites,
]);

/**
 * Keep provider-free contracts in bounded deterministic groups. Every contract or
 * suite that owns a coverage-safe local provider gets a fresh process so provider
 * heaps and native resources cannot accumulate. PGlite integration remains in
 * `test:all`: even a single V8-instrumented PGlite file exceeds the fixed process
 * ceiling before test execution, so focused coverage uses its deterministic core
 * contracts instead.
 */
export const DRIVER_COVERAGE_TEST_GROUPS = Object.freeze([
  ...coreCoverageGroups(),
  ...localProviderContracts.map((test) => Object.freeze([test])),
  ...localProviderSuites.map((test) => Object.freeze([test])),
]);
