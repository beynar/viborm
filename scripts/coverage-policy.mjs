import { readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_COVERAGE_TESTS } from "./client-test-manifest.mjs";
import {
  DRIVER_COVERAGE_TEST_GROUPS,
  DRIVER_COVERAGE_TESTS,
} from "./driver-test-manifest.mjs";
import { MIGRATION_COVERAGE_TESTS } from "./migration-test-manifest.mjs";
import {
  WRITE_ENGINE_COVERAGE_TEST_GROUPS,
  WRITE_ENGINE_COVERAGE_TESTS,
} from "./query-engine-test-manifest.mjs";

export const COVERAGE_PROJECT_ROOT = resolve(
  fileURLToPath(new URL("..", import.meta.url))
);
const publicFiles = new Set([
  "src/clock.ts",
  "src/config.ts",
  "src/index.ts",
  "src/standard-schema-spec.d.ts",
  "src/standardSchema.ts",
  "src/version.ts",
]);
export const migrationCoverageTests = MIGRATION_COVERAGE_TESTS;
export const cacheCoverageTests = Object.freeze([
  ...readdirSync(resolve(COVERAGE_PROJECT_ROOT, "tests/unit/cache"))
    .filter((file) => file.endsWith(".core.test.ts"))
    .sort()
    .map((file) => `tests/unit/cache/${file}`),
  "tests/contracts/public-client/official-cache-extension.core.test.ts",
  "tests/contracts/public-client/official-cache-instrumentation.core.test.ts",
  "tests/contracts/public-client/official-cache-swr.core.test.ts",
  "tests/contracts/public-client/protected-cache-observers.core.test.ts",
]);
export const driverCoverageTests = DRIVER_COVERAGE_TESTS;
export const extensionCoverageTests = Object.freeze([
  "tests/contracts/architecture/extension-system-census.core.test.ts",
  "tests/contracts/public-client/default-omit-extension.core.test.ts",
  "tests/contracts/public-client/extensions-foundation.core.test.ts",
  "tests/contracts/public-client/official-cache-extension.core.test.ts",
  "tests/contracts/public-client/official-instrumentation-extension.core.test.ts",
  "tests/contracts/engine/query/operation-program-read-contracts.core.test.ts",
  "tests/contracts/engine/query/pending-operation-contracts.core.test.ts",
  "tests/contracts/public-client/extensions/array-admission.core.test.ts",
  "tests/contracts/public-client/query-interceptors-array.core.test.ts",
  "tests/contracts/public-client/query-interceptors-integration.core.test.ts",
  "tests/contracts/public-client/query-interceptors.core.test.ts",
  "tests/contracts/public-client/request-transforms.core.test.ts",
  "tests/contracts/public-client/statement-transforms-integration.core.test.ts",
  "tests/contracts/drivers/statement-transforms.core.test.ts",
  "tests/contracts/drivers/protected-observers.core.test.ts",
  "tests/unit/instrumentation/official-observer-provider-failures.core.test.ts",
  "tests/unit/instrumentation/official-observer.core.test.ts",
]);
const definitions = [
  {
    id: "public",
    label: "public",
    target: 100,
    files: publicFiles,
    projects: ["coverage-public"],
  },
  {
    id: "schema",
    label: "schema",
    target: 100,
    root: "src/schema/",
    projects: [
      "layer-scalars",
      "layer-relations",
      "layer-schema-validation",
      "coverage-schema",
    ],
  },
  {
    id: "validation",
    label: "validation",
    target: 100,
    root: "src/validation/",
    projects: [
      "layer-validation",
      "layer-scalars",
      "layer-operation-schemas",
      "layer-relations",
    ],
  },
  {
    id: "sql",
    label: "sql",
    target: 100,
    root: "src/sql/",
    projects: ["layer-adapters"],
  },
  {
    id: "instrumentation",
    label: "instrumentation",
    target: 100,
    root: "src/instrumentation/",
    projects: ["layer-instrumentation"],
  },
  {
    id: "extensions",
    label: "extensions",
    target: 100,
    root: "src/extensions/",
    projects: ["coverage-extensions"],
    tests: extensionCoverageTests,
  },
  {
    id: "errors",
    label: "errors",
    target: 100,
    root: "src/errors/",
    files: new Set(["src/errors.ts"]),
    projects: ["coverage-errors"],
  },
  {
    id: "adapters",
    label: "adapters",
    target: 100,
    root: "src/adapters/",
    projects: ["layer-adapters"],
  },
  {
    id: "cli",
    label: "CLI",
    target: 100,
    root: "src/cli/",
    projects: ["coverage-cli"],
    tests: [
      "tests/contracts/public-client/cli/index.test.ts",
      "tests/contracts/public-client/cli/migrate.test.ts",
      "tests/contracts/public-client/cli/push.test.ts",
      "tests/contracts/public-client/cli/utils.test.ts",
    ],
  },
  {
    id: "query-engine-core",
    label: "query-engine core",
    target: 98,
    root: "src/query-engine/",
    exceptRoot: "src/query-engine/write-engine/",
    projects: ["layer-query-engine", "coverage-write-engine-core"],
  },
  {
    id: "write-engine",
    label: "write-engine",
    target: 98,
    root: "src/query-engine/write-engine/",
    projects: ["coverage-write-engine"],
    tests: WRITE_ENGINE_COVERAGE_TESTS,
    testGroups: WRITE_ENGINE_COVERAGE_TEST_GROUPS,
    heapLimitMb: 512,
  },
  {
    id: "drivers",
    label: "drivers",
    target: 98,
    root: "src/drivers/",
    projects: ["coverage-drivers"],
    tests: driverCoverageTests,
    testGroups: DRIVER_COVERAGE_TEST_GROUPS,
  },
  {
    id: "client",
    label: "client",
    target: 98,
    root: "src/client/",
    projects: ["coverage-client"],
    tests: CLIENT_COVERAGE_TESTS,
  },
  {
    id: "cache",
    label: "cache",
    target: 98,
    root: "src/cache/",
    projects: ["coverage-cache"],
    tests: cacheCoverageTests,
  },
  {
    id: "migrations",
    label: "migrations",
    target: 98,
    root: "src/migrations/",
    projects: ["coverage-migrations"],
    tests: migrationCoverageTests,
  },
];

export const coverageWaivers = Object.freeze([
  {
    id: "bun-runtime",
    sources: [
      "src/drivers/bun-sql/index.ts",
      "src/drivers/bun-sqlite/index.ts",
    ],
    reason: "These provider branches execute only under the Bun runtime.",
  },
  {
    id: "cloudflare-runtime",
    sources: ["src/drivers/d1/index.ts"],
    reason:
      "The D1 binding executes only inside the Cloudflare Workers runtime.",
  },
  {
    id: "hosted-provider",
    sources: [
      "src/drivers/neon-http/index.ts",
      "src/drivers/planetscale/index.ts",
      "src/drivers/planetscale/response-contract.ts",
    ],
    reason: "Hosted provider transport branches require service credentials.",
  },
  {
    id: "docker-provider",
    sources: [
      "src/drivers/mysql2/index.ts",
      "src/drivers/pg/index.ts",
      "src/drivers/postgres/index.ts",
    ],
    reason: "Live provider branches require the corresponding Docker service.",
  },
]);

function normalizedPath(path) {
  return path.split(sep).join("/");
}

function readTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...readTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(normalizedPath(relative(COVERAGE_PROJECT_ROOT, path)));
    }
  }
  return files;
}

export function sourceFiles() {
  return readTypeScriptFiles(resolve(COVERAGE_PROJECT_ROOT, "src")).sort();
}

function owns(definition, source) {
  if (definition.files?.has(source)) return true;
  return Boolean(
    definition.root &&
      source.startsWith(definition.root) &&
      !(definition.exceptRoot && source.startsWith(definition.exceptRoot))
  );
}

export function auditCoverageOwnership(files = sourceFiles()) {
  const errors = [];
  for (const source of files) {
    const owners = definitions.filter((definition) => owns(definition, source));
    if (owners.length !== 1) {
      errors.push(
        `${source} has ${owners.length} coverage owners${owners.length ? ` (${owners.map(({ id }) => id).join(", ")})` : ""}.`
      );
    }
  }
  for (const waiver of coverageWaivers) {
    if (!waiver.reason.trim())
      errors.push(`Coverage waiver ${waiver.id} has no reason.`);
    for (const source of waiver.sources) {
      if (!files.includes(source))
        errors.push(
          `Coverage waiver ${waiver.id} names missing source ${source}.`
        );
    }
  }
  return errors;
}

const ownershipErrors = auditCoverageOwnership();
if (ownershipErrors.length) {
  throw new Error(
    `Invalid coverage ownership manifest:\n${ownershipErrors.join("\n")}`
  );
}

export const coverageSubsystems = Object.freeze(
  definitions.map((definition) =>
    Object.freeze({
      id: definition.id,
      label: definition.label,
      projects: Object.freeze([...definition.projects]),
      tests: definition.tests
        ? Object.freeze([...definition.tests])
        : undefined,
      testGroups: definition.testGroups
        ? Object.freeze(
            definition.testGroups.map((group) => Object.freeze([...group]))
          )
        : undefined,
      chunkSize: definition.chunkSize,
      heapLimitMb: definition.heapLimitMb,
      sources: Object.freeze(
        sourceFiles().filter(
          (source) => owns(definition, source) && !source.endsWith(".d.ts")
        )
      ),
      target: definition.target,
    })
  )
);

export function coverageSubsystem(id) {
  const subsystem = coverageSubsystems.find((candidate) => candidate.id === id);
  if (!subsystem) throw new Error(`Unknown coverage subsystem: ${id}`);
  return subsystem;
}

export function waiversForSubsystem(id) {
  const sources = new Set(coverageSubsystem(id).sources);
  return coverageWaivers.filter((waiver) =>
    waiver.sources.some((source) => sources.has(source))
  );
}

function coverageReporters(mode) {
  return mode === "shard" || mode === "part"
    ? ["json"]
    : ["text", "json", "json-summary", "lcov", "html"];
}

export function coverageOptionsForSubsystem(
  id,
  { mode = "focused", reportsDirectory } = {}
) {
  const subsystem = coverageSubsystem(id);
  const thresholds =
    subsystem.target === 100
      ? { 100: true }
      : {
          statements: subsystem.target,
          branches: subsystem.target,
          functions: subsystem.target,
          lines: subsystem.target,
        };
  return {
    provider: "v8",
    include: [...subsystem.sources],
    processingConcurrency: 1,
    reporter: coverageReporters(mode),
    reportsDirectory: reportsDirectory ?? `coverage/${id}`,
    thresholds: mode === "focused" ? thresholds : undefined,
  };
}

export function coverageOptionsForAll() {
  return {
    provider: "v8",
    include: coverageSubsystems.flatMap(({ sources }) => sources),
    processingConcurrency: 1,
    reporter: ["text", "json", "json-summary", "lcov", "html"],
  };
}
