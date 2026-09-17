/** Read-only source accounting; optional in-memory bundles, never candidate code. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { calibrationSourceIdentity } from "../benchmarks/operation-pipeline-semantics.mjs";
import {
  RAPTOR3_WORKLOADS,
  RAPTOR3_WORKLOAD_VERSION,
  WORKLOADS,
} from "../benchmarks/operation-pipeline-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const bundle = argv.includes("--bundle");
const outputIndex = argv.indexOf("--output");
const output = outputIndex < 0 ? undefined : argv[outputIndex + 1];
const allowed = new Set(["--bundle", "--output", output]);
if (
  argv.some((argument) => !allowed.has(argument)) ||
  (outputIndex >= 0 && !output)
) {
  throw new Error(
    "Usage: measure-raptor3-baseline.mjs [--bundle] [--output file]"
  );
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const list = (directory, suffix) =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? list(resolve(directory, entry.name), suffix)
        : entry.name.endsWith(suffix)
          ? [resolve(directory, entry.name)]
          : []
    )
    .sort();

// Execute the existing census function itself, rather than a second LOC definition.
const censusPath = resolve(root, "scripts/query-engine-structure.mjs");
const censusSource = readFileSync(censusPath, "utf8");
const censusAst = ts.createSourceFile(
  censusPath,
  censusSource,
  ts.ScriptTarget.Latest,
  true
);
const censusFunction = censusAst.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "countTokenLines"
);
if (!censusFunction)
  throw new Error("Existing parser-token census owner is missing");
const censusFunctionSource = censusFunction.getText(censusAst);
const countTokenLines = runInNewContext(`(${censusFunctionSource})`, { ts });

const chargedClient = new Set([
  "array-transaction-failures.ts",
  "array-transaction-legacy.ts",
  "array-transaction-native-batch.ts",
  "array-transaction-native.ts",
  "array-transaction.ts",
  "client.ts",
  "decimal-provider-limits.ts",
  "geo-point-provider-limit.ts",
  "omit.ts",
  "raw.ts",
  "schema-introspection.ts",
  "typescript-type-renderer.ts",
]);
const chargedAdapter = new Set([
  "src/adapters/adapter-internals.ts",
  "src/adapters/shared/batch-refs.ts",
  "src/adapters/adapter-core-types.ts",
]);
const syntaxAdapters = new Set([
  "src/adapters/databases/postgres/postgres-adapter.ts",
  "src/adapters/databases/mysql/mysql-adapter.ts",
  "src/adapters/databases/sqlite/sqlite-adapter.ts",
]);
const chargedG3PrepShared = new Set([
  "src/adapters/adapter-internals.ts",
  "src/adapters/constraint-identity.ts",
  ...syntaxAdapters,
  "src/drivers/error-mapping.ts",
  "src/drivers/driver-instrumentation.ts",
  "src/query-engine/JunctionStatements.ts",
  "src/query-engine/unique-conflict-target.ts",
  "src/schema/model/keys.ts",
  "src/schema/model/model.ts",
  "src/schema/validation/rules/model.ts",
  "src/schema/validation/validator.ts",
]);

function classify(file) {
  if (file.startsWith("src/query-engine/raptor3/")) {
    return [
      "excluded-experiment",
      "Private G1 candidates, separately accounted below; not the public operation route",
    ];
  }
  if (chargedG3PrepShared.has(file)) {
    return [
      "charged-g3-prep-shared",
      "Whole shared owner changed by G3 preparation; charged without a proportional monolith discount",
    ];
  }
  if (file.startsWith("src/query-engine/")) {
    return [
      "charged-engine",
      "Whole current query/write owner, including types and mixed-file glue",
    ];
  }
  if (
    file.startsWith("src/client/") &&
    chargedClient.has(file.slice("src/client/".length))
  ) {
    return [
      "charged-integration",
      "Whole public operation/array/raw/admission/introspection composition owner; no proportional monolith discount",
    ];
  }
  if (chargedAdapter.has(file)) {
    return [
      "charged-adapter-integration",
      "Whole internal SELECT/batch scratch seam, protocol types and shared scratch implementation",
    ];
  }
  if (syntaxAdapters.has(file)) {
    return [
      "excluded-shared-boundary",
      "Unchanged dialect syntax, including dialect-specific scratch installation/configuration; same complete owner required by both engines",
    ];
  }
  return [
    "excluded-shared-boundary",
    "Unchanged external schema/validation/SQL/provider/extension/cache/public-type or unrelated migration/CLI owner; moving or rewriting engine semantics here must be charged to the candidate",
  ];
}

const sourceIdentity = calibrationSourceIdentity(root);
const files = list(resolve(root, "src"), ".ts").map((absolute) => {
  const file = relative(root, absolute);
  const source = readFileSync(absolute, "utf8");
  const ast = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const [classification, reason] = classify(file);
  const imports = ast.statements.flatMap((statement) => {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    )
      return [];
    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      return [];
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly === true ||
        (statement.importClause?.name === undefined &&
          statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings) &&
          statement.importClause.namedBindings.elements.every(
            (element) => element.isTypeOnly
          )) === true
      : statement.isTypeOnly === true ||
        (statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every(
            (element) => element.isTypeOnly
          )) === true;
    return [{ module: statement.moduleSpecifier.text, typeOnly }];
  });
  return {
    file,
    classification,
    reason,
    sha256: sha256(source),
    bytes: Buffer.byteLength(source),
    physicalLines: (source.match(/\n/g) ?? []).length,
    tokenLines: countTokenLines(ast),
    imports,
  };
});
const sum = (selected) =>
  selected.reduce(
    (total, file) => ({
      files: total.files + 1,
      bytes: total.bytes + file.bytes,
      physicalLines: total.physicalLines + file.physicalLines,
      tokenLines: total.tokenLines + file.tokenLines,
    }),
    { files: 0, bytes: 0, physicalLines: 0, tokenLines: 0 }
  );
const retainedCandidateOwners = new Set([
  "src/query-engine/bind-budget.ts",
  "src/query-engine/write-engine/parse-boundary.ts",
  "src/query-engine/types.ts",
  ...chargedAdapter,
  ...chargedG3PrepShared,
]);
const candidateRoot = "src/query-engine/raptor3/";
const candidateFiles = files.filter(({ file }) =>
  file.startsWith(candidateRoot)
);
const privateCandidates =
  candidateFiles.length === 0
    ? null
    : {
        scope:
          "Current private G1 source: commands selected and expanding; program remains the S1–S4 comparison specimen. Shared additions are charged whole to both. This is not whole-engine or candidate-only package coverage; the original G1-01 snapshot is archived separately.",
        candidates: Object.fromEntries(
          ["commands", "program"].map((name) => {
            const language = candidateFiles.filter(({ file }) =>
              file.startsWith(`${candidateRoot}${name}/`)
            );
            const shared = candidateFiles.filter(({ file }) =>
              file.startsWith(`${candidateRoot}shared/`)
            );
            const retained = files.filter(({ file }) =>
              retainedCandidateOwners.has(file)
            );
            const charged = [...language, ...shared, ...retained];
            return [
              name,
              {
                language: sum(language),
                shared: sum(shared),
                retained: sum(retained),
                total: sum(charged),
                files: charged.map(({ file }) => file),
              },
            ];
          })
        ),
        combinedNewProduction: sum(candidateFiles),
        retainedOwnerRule:
          "Whole admission, engine type, and every shared schema/adapter/driver/current-engine owner changed by G3 preparation are charged once per candidate without a proportional monolith discount. Unchanged schema/validation/Sql/driver/error boundaries remain excluded symmetrically with G0.",
        declarationDebt:
          "The retained types.ts contains unused declarations importing OperationFragment and its legacy series type closure. The consumed Operation union does not use that language. types.ts is charged whole, but those dormant implementation owners are not credited as candidate functionality. Candidate-only declaration independence is unproven and requires decoupling the shared operation-name leaf before adoption.",
      };
const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8")
);
const categories = [...new Set(files.map((file) => file.classification))];
const require = createRequire(import.meta.url);
const tsdownRequire = createRequire(require.resolve("tsdown"));
const externalByFixture = {
  engine: [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
  ].sort(),
  publicPostgres: [
    "@electric-sql/pglite",
    "@neondatabase/serverless",
    "@planetscale/database",
    "@libsql/client",
    "mysql2",
    "better-sqlite3",
    "postgres",
    "pg-native",
  ].sort(),
};

const bundleFixtures = {
  engine: [
    'export { QueryEngine, createModelRegistry } from "./src/query-engine/query-engine.ts";',
    'export { PendingOperation } from "./src/query-engine/pending-operation.ts";',
  ].join("\n"),
  "pg-simple": [
    'import { s } from "./src/index.ts";',
    'import { createClient } from "./src/drivers/pg/index.ts";',
    "const user = s.model({ id: s.int().id(), name: s.string() });",
    "export const client = createClient({ schema: { user } });",
    "export const read = () => client.user.findMany({ select: { id: true, name: true } });",
  ].join("\n"),
  "pg-relations": [
    'import { s } from "./src/index.ts";',
    'import { createClient } from "./src/drivers/pg/index.ts";',
    "const user = s.model({ id: s.int().id(), name: s.string(), posts: s.toMany(() => post) });",
    'const post = s.model({ id: s.int().id(), authorId: s.int(), title: s.string(), author: s.toOne(() => user).fields("authorId").references("id") });',
    "export const client = createClient({ schema: { user, post } });",
    'export const read = () => client.user.findMany({ include: { posts: { orderBy: { id: "asc" }, take: 1 } } });',
    'export const write = () => client.user.create({ data: { id: 1, name: "one", posts: { create: { id: 2, title: "two" } } } });',
  ].join("\n"),
};

const report = {
  version: 1,
  status: bundle
    ? "measured-source-and-bundles"
    : "source-accounted-bundle-pending",
  source: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    clean:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim().length === 0,
    sourceIdentity,
    includedProductionWorkingTreeChanges: [
      ...new Set(
        [
          execFileSync("git", ["diff", "--name-only", "HEAD", "--", "src"], {
            cwd: root,
            encoding: "utf8",
          }),
          execFileSync(
            "git",
            ["ls-files", "--others", "--exclude-standard", "--", "src"],
            { cwd: root, encoding: "utf8" }
          ),
        ]
          .join("\n")
          .trim()
          .split("\n")
          .filter(Boolean)
      ),
    ].sort(),
    workingTreeQualification:
      "All executable source/protocol file contents, including uncommitted and untracked files, are attested by sourceIdentity; the production-only diff list is not a clean-checkout claim",
  },
  accounting: {
    definition:
      "Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded",
    censusOwner: relative(root, censusPath),
    censusFunctionSha256: sha256(censusFunctionSource),
    wholeOwnerPolicy:
      "Every charged file is counted whole, including mixed files; no symbol-level or proportional line discounts",
    navigationSubtotal: sum(
      files.filter(
        (file) =>
          file.file.startsWith("src/query-engine/") &&
          !file.file.startsWith(candidateRoot)
      )
    ),
    charged: sum(
      files.filter((file) => file.classification.startsWith("charged-"))
    ),
    byClassification: Object.fromEntries(
      categories.map((category) => [
        category,
        sum(files.filter((file) => file.classification === category)),
      ])
    ),
    mixedOwners: [
      {
        file: "src/adapters/adapter-core-types.ts",
        disposition: "charged whole",
        reason:
          "Retained batch-reference protocol cohabits with generic arithmetic/cast types",
      },
    ],
    excludedNonProductionRoots: [
      "tests/",
      "benchmarks/",
      "scripts/",
      "docs/",
      "exa-results/",
    ],
    candidateChargeRule:
      "Apply the identical complete-owner scope; new/generated source, tables, declarations, glue, retained files and engine semantics moved into excluded boundaries are charged. Actual runtime/declaration bytes are reported separately.",
  },
  tools: {
    node: process.version,
    v8: process.versions.v8,
    typescript: ts.version,
    tsdown: JSON.parse(
      readFileSync(resolve(root, "node_modules/tsdown/package.json"), "utf8")
    ).version,
    biome: JSON.parse(
      readFileSync(
        resolve(root, "node_modules/@biomejs/biome/package.json"),
        "utf8"
      )
    ).version,
    platform: process.platform,
    arch: process.arch,
  },
  bundleProtocol: {
    fixtures: bundleFixtures,
    target: "node22",
    format: "esm",
    minify: true,
    treeshake: true,
    inlineDynamicImports: true,
    gzipLevel: 9,
    externalByFixture,
    extraExternal: ["Node built-ins", "node:*", "bun", "bun:*"],
    publicQualification:
      "Public PostgreSQL fixtures bundle runtime dependencies and pg; only platform built-ins and explicitly unselected optional provider packages remain external",
  },
  preAuditForecast: {
    wholeEngineTokenLines: [20200, 31000],
    s1ThroughS4TokenLines: [4100, 6650],
    provisionalNavigationDenominator: 47625,
    qualification:
      "Preimplementation prediction retained unchanged, not a candidate measurement",
  },
  frozenTargets: {
    productionTokenRatio: 0.6,
    productionPhysicalRatio: 0.7,
    engineGzipRatio: 0.75,
    everyPublicPostgresGzipRatio: 1.0,
    qualification:
      "Size targets require review on a miss, not automatic abandonment",
  },
  performanceProtocol: {
    workloadVersion: RAPTOR3_WORKLOAD_VERSION,
    workloads: Object.fromEntries(
      RAPTOR3_WORKLOADS.map((name) => [name, WORKLOADS[name]])
    ),
    comparison:
      "RunObservation equality between engines except alpha-renaming the outer observed error's valid correlation ID; causes remain exact. Exact physical witness/checksum repeatability within each engine",
    replicatesPerSide: 5,
    alternatingFreshProcesses: true,
    uncertainty: "E = 2 * max(MADbaseline, MADcandidate)",
    timeBudget:
      "(candidateMedian - baselineMedian) + E <= 0.05 * baselineMedian",
    peakMemoryBudget:
      "(candidateMedian - baselineMedian) + E <= 0.10 * baselineMedian",
    qualification:
      "Frozen G0 constants for the later milestone gate; semantic mode is evidence-only and does not use the legacy keep gate as a Raptor 3 adoption verdict",
  },
  declarationBytes: null,
  privateCandidates,
  bundles: null,
  evidenceFootprint: [
    ...list(resolve(root, "tests/raptor3"), ".ts"),
    ...list(resolve(root, "benchmarks"), ".mjs").filter((file) =>
      file.includes("operation-pipeline-")
    ),
    ...list(resolve(root, "scripts"), ".mjs").filter((file) =>
      /raptor3/.test(file)
    ),
  ].map((absolute) => {
    const source = readFileSync(absolute, "utf8");
    return {
      file: relative(root, absolute),
      bytes: Buffer.byteLength(source),
      physicalLines: (source.match(/\n/g) ?? []).length,
      tokenLines: countTokenLines(
        ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true)
      ),
      sha256: sha256(source),
    };
  }),
  files,
};

if (bundle) {
  const { rolldown } = await import(
    pathToFileURL(tsdownRequire.resolve("rolldown")).href
  );
  const rolldownPackage = JSON.parse(
    readFileSync(tsdownRequire.resolve("rolldown/package.json"), "utf8")
  );
  report.tools.rolldown = rolldownPackage.version;
  const bundled = {};
  for (const [name, fixture] of Object.entries(bundleFixtures)) {
    const externalPackages =
      name === "engine"
        ? externalByFixture.engine
        : externalByFixture.publicPostgres;
    const fixtureId = resolve(root, `__raptor3_${name}.ts`);
    const build = await rolldown({
      input: fixtureId,
      cwd: root,
      external: (id) =>
        builtinModules.includes(id) ||
        id.startsWith("node:") ||
        id === "bun" ||
        id.startsWith("bun:") ||
        externalPackages.some(
          (dependency) => id === dependency || id.startsWith(`${dependency}/`)
        ),
      tsconfig: resolve(root, "tsconfig.json"),
      platform: "node",
      transform: { target: "node22" },
      treeshake: true,
      plugins: [
        {
          name: "raptor3-frozen-fixture",
          resolveId(id) {
            if (id === fixtureId) return id;
          },
          load(id) {
            if (id === fixtureId) return fixture;
          },
        },
      ],
      onwarn(warning) {
        throw new Error(`Bundle ${name}: ${warning.message}`);
      },
    });
    try {
      const generated = await build.generate({
        format: "esm",
        minify: true,
        sourcemap: false,
        inlineDynamicImports: true,
      });
      if (generated.output.length !== 1 || generated.output[0].type !== "chunk")
        throw new Error(`${name} must be one comparable bundle`);
      const chunk = generated.output[0];
      bundled[name] = {
        externalPackages,
        runtimeBytes: Buffer.byteLength(chunk.code),
        gzipBytes: gzipSync(chunk.code, { level: 9 }).length,
        sha256: sha256(chunk.code),
        modules: Object.entries(chunk.modules).map(([file, value]) => ({
          file: relative(root, file),
          renderedLength: value.renderedLength,
          renderedExports: value.renderedExports,
          removedExports: value.removedExports,
        })),
      };
    } finally {
      await build.close();
    }
  }
  report.bundles = bundled;
  const allDeclarations = existsSync(resolve(root, "dist"))
    ? list(resolve(root, "dist"), ".d.mts")
    : [];
  const reachedDeclarations = new Set();
  function visitDeclaration(file) {
    if (reachedDeclarations.has(file)) return;
    reachedDeclarations.add(file);
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      const module =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
      if (module && ts.isStringLiteral(module) && module.text.startsWith(".")) {
        visitDeclaration(
          resolve(file, "..", module.text.replace(/\.mjs$/, ".d.mts"))
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  if (allDeclarations.length) {
    for (const entry of Object.values(manifest.exports)) {
      if (entry.types) visitDeclaration(resolve(root, entry.types));
    }
  }
  const declarations = allDeclarations.filter(
    (file) => !relative(root, file).startsWith("dist/internal/")
  );
  report.declarationBytes =
    declarations.length === 0
      ? null
      : {
          qualification:
            "Actual package files rule: every dist/**/*.d.mts except dist/internal/**, including any unreachable published shared chunks; source match must be established by the serial build receipt",
          files: declarations.map((file) => ({
            file: relative(root, file),
            bytes: readFileSync(file).length,
            sha256: sha256(readFileSync(file)),
          })),
          total: declarations.reduce(
            (total, file) => total + readFileSync(file).length,
            0
          ),
          publicExportReachableTotal: [...reachedDeclarations].reduce(
            (total, file) => total + readFileSync(file).length,
            0
          ),
          unreachableButPublished: declarations
            .filter((file) => !reachedDeclarations.has(file))
            .map((file) => ({
              file: relative(root, file),
              bytes: readFileSync(file).length,
            })),
          excludedInternalEntries: allDeclarations
            .filter((file) => !declarations.includes(file))
            .map((file) => ({
              file: relative(root, file),
              bytes: readFileSync(file).length,
            })),
        };
}
report.evidenceFootprintTotals = sum(report.evidenceFootprint);
if (calibrationSourceIdentity(root).sha256 !== sourceIdentity.sha256)
  throw new Error("Measured source changed during accounting");
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(resolve(root, output), serialized);
else process.stdout.write(serialized);
