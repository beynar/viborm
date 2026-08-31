import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { CLIENT_COVERAGE_TESTS } from "./client-test-manifest.mjs";
import {
  auditCoverageOwnership,
  COVERAGE_PROJECT_ROOT,
  cacheCoverageTests,
  coverageOptionsForSubsystem,
  coverageSubsystems,
  coverageWaivers,
  migrationCoverageTests,
  sourceFiles,
} from "./coverage-policy.mjs";
import {
  DRIVER_CORE_TESTS,
  DRIVER_COVERAGE_TEST_GROUPS,
  DRIVER_COVERAGE_TESTS,
} from "./driver-test-manifest.mjs";
import {
  QUERY_ENGINE_CORE_TESTS,
  WRITE_ENGINE_CORE_TESTS,
  WRITE_ENGINE_COVERAGE_TEST_GROUPS,
  WRITE_ENGINE_COVERAGE_TESTS,
  WRITE_ENGINE_EXTENDED_COVERAGE_TESTS,
} from "./query-engine-test-manifest.mjs";

const IMPORT_SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
const PGLITE_RESOURCE_PATTERN = /@drivers\/pglite|@electric-sql\/pglite/;
const PROVIDER_RESOURCE_SPECIFIERS = new Set([
  "@electric-sql/pglite",
  "@drivers/libsql",
  "@drivers/mysql2",
  "@drivers/pglite",
  "@drivers/pg",
  "@drivers/sqlite3",
  "@tests/fixtures/drivers/pglite",
  "@tests/fixtures/pglite-lifecycle",
  "@tests/fixtures/sync-schema",
  "better-sqlite3",
  "@libsql/client",
  "mysql2",
  "pg",
]);

function coreTests(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".core.test.ts"))
    .map((file) => `${directory}/${file}`);
}

function typeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return typeScriptFiles(file);
    return entry.isFile() && entry.name.endsWith(".ts") ? [file] : [];
  });
}

function localDependency(specifier, importer) {
  let base;
  if (specifier.startsWith("@tests/")) {
    base = resolve(COVERAGE_PROJECT_ROOT, "tests", specifier.slice(7));
  } else if (specifier.startsWith(".")) {
    base = resolve(COVERAGE_PROJECT_ROOT, dirname(importer), specifier);
  } else {
    return undefined;
  }
  for (const candidate of [base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(COVERAGE_PROJECT_ROOT, candidate);
    }
  }
  return undefined;
}

function importsProviderResource(file, visited = new Set()) {
  if (visited.has(file)) return false;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (PROVIDER_RESOURCE_SPECIFIERS.has(specifier)) return true;
    const dependency = localDependency(specifier, file);
    if (dependency && importsProviderResource(dependency, visited)) return true;
  }
  return false;
}

function resourceImportPattern(specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = `["']${escaped}(?:/[^"']*)?["']`;
  return new RegExp(
    `(?:\\bfrom\\s+|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)${quoted}`
  );
}

test("every TypeScript source has exactly one coverage owner", () => {
  assert.deepEqual(auditCoverageOwnership(), []);
  assert.deepEqual(
    coverageSubsystems.flatMap(({ sources }) => sources).sort(),
    sourceFiles().filter((source) => !source.endsWith(".d.ts"))
  );
});

test("subsystem configs derive includes and thresholds from the manifest", () => {
  for (const subsystem of coverageSubsystems) {
    const options = coverageOptionsForSubsystem(subsystem.id);
    assert.deepEqual(options.include, subsystem.sources);
    assert.deepEqual(
      options.thresholds,
      subsystem.target === 100
        ? { 100: true }
        : {
            statements: subsystem.target,
            branches: subsystem.target,
            functions: subsystem.target,
            lines: subsystem.target,
          }
    );
  }
});

test("waived sources remain owned and included", () => {
  const included = new Set(
    coverageSubsystems.flatMap(({ sources }) => sources)
  );
  for (const waiver of coverageWaivers) {
    assert.ok(waiver.reason.length > 0);
    for (const source of waiver.sources) assert.ok(included.has(source));
  }
});

test("test fixtures use the workspace alias instead of root-absolute imports", () => {
  for (const file of typeScriptFiles("tests")) {
    assert.ok(
      !readFileSync(file, "utf8").includes('from "/fixtures/'),
      `${file} imports a fixture from the filesystem root`
    );
  }
});

test("migration coverage admits every credential-free local contract", () => {
  const directory = "tests/unit/migrations";
  const resourceOwningImports = [
    "@electric-sql/pglite",
    "@drivers/pglite",
    "@tests/fixtures/drivers/pglite",
    "@tests/fixtures/pglite-lifecycle",
  ];
  const expected = readdirSync(directory)
    .filter(
      (file) =>
        (file.endsWith(".core.test.ts") || file.endsWith(".test.ts")) &&
        file !== "v1-cli-input.core.test.ts" &&
        !file.endsWith("-docker.test.ts")
    )
    .map((file) => `${directory}/${file}`)
    .filter((file) => {
      if (file.endsWith(".core.test.ts")) return true;
      const source = readFileSync(file, "utf8");
      return resourceOwningImports.every(
        (specifier) => !resourceImportPattern(specifier).test(source)
      );
    });

  assert.equal(
    new Set(migrationCoverageTests).size,
    migrationCoverageTests.length
  );
  assert.deepEqual([...migrationCoverageTests].sort(), expected.sort());
});

test("client coverage admits the core and audited deterministic contracts", () => {
  const expected = [
    ...coreTests("tests/contracts/public-client"),
    "tests/contracts/public-client/geopoint-provider-limit.test.ts",
    "tests/contracts/public-client/omit-builder-types.test.ts",
  ];

  assert.equal(
    new Set(CLIENT_COVERAGE_TESTS).size,
    CLIENT_COVERAGE_TESTS.length
  );
  assert.deepEqual([...CLIENT_COVERAGE_TESTS].sort(), expected.sort());
});

test("driver coverage isolates provider resources and admits only audited local providers", () => {
  const core = coreTests("tests/contracts/drivers");
  const providerContracts = [
    "tests/contracts/drivers/consumable-result-rows.provider.test.ts",
    "tests/contracts/drivers/sqlite-binary-values.provider.test.ts",
    "tests/contracts/drivers/sqlite-integer-safety.provider.test.ts",
    "tests/contracts/drivers/sqlite-native-datetime.provider.test.ts",
    "tests/contracts/drivers/sqlite-statement-execution.provider.test.ts",
  ];
  const localProviders = [
    "tests/providers/local/libsql.test.ts",
    "tests/providers/local/sqlite3.test.ts",
  ];
  const expectedCoverage = [...core, ...providerContracts, ...localProviders];

  assert.deepEqual([...DRIVER_CORE_TESTS].sort(), core.sort());
  assert.equal(new Set(DRIVER_CORE_TESTS).size, DRIVER_CORE_TESTS.length);
  assert.deepEqual([...DRIVER_COVERAGE_TESTS].sort(), expectedCoverage.sort());
  assert.equal(
    new Set(DRIVER_COVERAGE_TESTS).size,
    DRIVER_COVERAGE_TESTS.length
  );
  const providerHeavyCore = new Set([
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
  const expectedCoreGroups = [];
  let providerFreeGroup = [];
  const flushProviderFreeGroup = () => {
    if (providerFreeGroup.length === 0) return;
    expectedCoreGroups.push(providerFreeGroup);
    providerFreeGroup = [];
  };
  for (const file of [...core].sort()) {
    if (providerHeavyCore.has(file)) {
      flushProviderFreeGroup();
      expectedCoreGroups.push([file]);
      continue;
    }
    providerFreeGroup.push(file);
    if (providerFreeGroup.length === 8) flushProviderFreeGroup();
  }
  flushProviderFreeGroup();
  const isolatedProviderTests = [
    ...providerContracts.sort(),
    ...localProviders,
  ];
  assert.deepEqual(DRIVER_COVERAGE_TEST_GROUPS, [
    ...expectedCoreGroups,
    ...isolatedProviderTests.map((file) => [file]),
  ]);
  assert.deepEqual(DRIVER_COVERAGE_TEST_GROUPS.flat(), DRIVER_COVERAGE_TESTS);
  assert.deepEqual(
    coverageSubsystems.find(({ id }) => id === "drivers")?.testGroups,
    DRIVER_COVERAGE_TEST_GROUPS
  );
  for (const file of DRIVER_CORE_TESTS) {
    if (importsProviderResource(file)) {
      assert.ok(
        providerHeavyCore.has(file),
        `${file} imports a provider resource but is not isolated`
      );
    }
  }
  for (const group of expectedCoreGroups) {
    assert.ok(group.length <= 8);
    if (group.some((file) => providerHeavyCore.has(file))) {
      assert.equal(group.length, 1);
    }
  }
  for (const file of isolatedProviderTests) {
    assert.ok(
      importsProviderResource(file),
      `${file} must own a provider resource to require singleton isolation`
    );
  }
  const pgliteCoverageExclusions = [
    "tests/contracts/drivers/consumable-result-rows-pglite.provider.test.ts",
    "tests/contracts/drivers/error-mapping.provider.test.ts",
    "tests/contracts/drivers/pinned-session-condemned.provider.test.ts",
    "tests/contracts/drivers/transaction-options-behavior.provider.test.ts",
    "tests/contracts/drivers/transaction-scope-scheduler.provider.test.ts",
    "tests/providers/local/pglite-vector.test.ts",
    "tests/providers/local/pglite.test.ts",
  ];
  for (const file of pgliteCoverageExclusions) {
    assert.ok(!DRIVER_COVERAGE_TESTS.includes(file));
    assert.match(readFileSync(file, "utf8"), PGLITE_RESOURCE_PATTERN);
  }
  for (const file of DRIVER_COVERAGE_TESTS) {
    assert.ok(!file.includes("/docker/"));
    assert.ok(!file.includes("/hosted/"));
    assert.ok(!file.includes("bun-runtime"));
    assert.ok(!file.includes("d1-worker"));
  }
});

test("query coverage admits every core contract exactly once", () => {
  const assignments = [...QUERY_ENGINE_CORE_TESTS, ...WRITE_ENGINE_CORE_TESTS];
  const expected = [
    ...coreTests("tests/contracts/architecture"),
    ...coreTests("tests/contracts/engine/query"),
    ...coreTests("tests/contracts/engine/write"),
  ];

  assert.equal(new Set(assignments).size, assignments.length);
  assert.deepEqual([...assignments].sort(), expected.sort());

  const resourceOwningImports = [
    "@electric-sql/pglite",
    "@tests/fixtures/drivers/pglite",
    "@tests/fixtures/sync-schema",
    "@drivers/pglite",
    "better-sqlite3",
    "@libsql/client",
  ];
  for (const file of assignments) {
    const source = readFileSync(file, "utf8");
    for (const imported of resourceOwningImports) {
      assert.ok(
        !resourceImportPattern(imported).test(source),
        `${file} imports resource-owning ${imported}`
      );
    }
  }
});

test("write coverage admits the core and audited high-signal local contracts", () => {
  const expectedExtended = [
    "tests/contracts/engine/write/neon-committed-segments-capability.test.ts",
  ];
  const expected = [...WRITE_ENGINE_CORE_TESTS, ...expectedExtended];

  assert.equal(
    new Set(WRITE_ENGINE_COVERAGE_TESTS).size,
    WRITE_ENGINE_COVERAGE_TESTS.length
  );
  assert.deepEqual([...WRITE_ENGINE_EXTENDED_COVERAGE_TESTS], expectedExtended);
  assert.deepEqual([...WRITE_ENGINE_COVERAGE_TESTS], expected);
  assert.deepEqual(WRITE_ENGINE_COVERAGE_TEST_GROUPS.flat(), expected);
  assert.ok(
    WRITE_ENGINE_COVERAGE_TEST_GROUPS.every(
      (group) => group.length > 0 && group.length <= 8
    )
  );
  assert.deepEqual(WRITE_ENGINE_COVERAGE_TEST_GROUPS.at(-1), expectedExtended);
  for (const file of expectedExtended) {
    assert.ok(readFileSync(file, "utf8"));
    assert.ok(
      !importsProviderResource(file),
      `${file} transitively imports a provider resource`
    );
  }

  const admitted = new Set(WRITE_ENGINE_COVERAGE_TESTS);
  const omitted = readdirSync("tests/contracts/engine/write")
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `tests/contracts/engine/write/${file}`)
    .filter((file) => !admitted.has(file));
  for (const file of omitted) {
    assert.ok(
      file.endsWith("-docker.test.ts") || importsProviderResource(file),
      `${file} is omitted without a Docker or transitive provider-resource dependency`
    );
  }
  assert.equal(
    coverageSubsystems.find(({ id }) => id === "write-engine")?.heapLimitMb,
    512
  );
});

test("cache coverage admits every deterministic cache contract exactly once", () => {
  const expected = [
    ...coreTests("tests/unit/cache"),
    "tests/contracts/public-client/official-cache-extension.core.test.ts",
    "tests/contracts/public-client/official-cache-instrumentation.core.test.ts",
    "tests/contracts/public-client/official-cache-swr.core.test.ts",
    "tests/contracts/public-client/protected-cache-observers.core.test.ts",
  ];

  assert.equal(new Set(cacheCoverageTests).size, cacheCoverageTests.length);
  assert.deepEqual([...cacheCoverageTests].sort(), expected.sort());

  const resourceOwningImports = [
    "@electric-sql/pglite",
    "@tests/fixtures/drivers/pglite",
    "@tests/fixtures/sync-schema",
    "@drivers/pglite",
    "better-sqlite3",
    "@libsql/client",
  ];
  for (const file of cacheCoverageTests) {
    const source = readFileSync(file, "utf8");
    for (const imported of resourceOwningImports) {
      assert.ok(
        !resourceImportPattern(imported).test(source),
        `${file} imports resource-owning ${imported}`
      );
    }
  }
});
