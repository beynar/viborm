import { readFileSync } from "node:fs";
import { defineConfig, type Rolldown, type UserConfig } from "tsdown";
import ts from "typescript";

const runtime = {
  // Multiple entry points for tree-shaking
  entry: {
    // Main entry
    index: "./src/index.ts",
    cli: "./src/cli/index.ts",

    // Schema (viborm/schema)
    schema: "./src/schema/exports.ts",

    // JSON-defined schemas (viborm/schema/json)
    "schema/json": "./src/schema/json/index.ts",

    // Driver base (viborm/driver)
    driver: "./src/drivers/exports.ts",

    // Raw SQL helpers (viborm/sql) — also re-exported from the package root
    sql: "./src/sql/sql.ts",

    // PostgreSQL drivers (viborm/pg, viborm/postgres, etc.)
    pg: "./src/drivers/pg/index.ts",
    postgres: "./src/drivers/postgres/index.ts",
    pglite: "./src/drivers/pglite/index.ts",
    "neon-http": "./src/drivers/neon-http/index.ts",
    "bun-sql": "./src/drivers/bun-sql/index.ts",

    // MySQL drivers (viborm/mysql2, viborm/planetscale)
    mysql2: "./src/drivers/mysql2/index.ts",
    planetscale: "./src/drivers/planetscale/index.ts",

    // SQLite drivers (viborm/sqlite3, viborm/libsql, etc.)
    sqlite3: "./src/drivers/sqlite3/index.ts",
    libsql: "./src/drivers/libsql/index.ts",
    d1: "./src/drivers/d1/index.ts",
    "bun-sqlite": "./src/drivers/bun-sqlite/index.ts",

    // Cache (viborm/cache, viborm/cache/memory, etc.)
    cache: "./src/cache/exports.ts",
    "cache/memory": "./src/cache/drivers/memory.ts",
    "cache/cloudflare-kv": "./src/cache/drivers/cloudflare-kv.ts",

    // Migrations (viborm/migrations)
    migrations: "./src/migrations/index.ts",
    "migrations/storage/fs": "./src/migrations/storage/fs.ts",
    "migrations/storage/durable-object":
      "./src/migrations/storage/durable-object.ts",
    "migrations/storage/r2": "./src/migrations/storage/r2.ts",

    // Config helper (viborm/config)
    config: "./src/config.ts",

    // Client types (viborm/client)
    client: "./src/client/exports.ts",

    // Validation (viborm/validation)
    validation: "./src/validation/index.ts",

    // Instrumentation (viborm/instrumentation)
    instrumentation: "./src/instrumentation/exports.ts",

    // Soft delete (viborm/soft-delete): an extension built from public
    // capabilities only; the root entry never imports it.
    "soft-delete": "./src/soft-delete/index.ts",

    // Adapters (internal, but exposed for advanced usage)
    adapters: "./src/adapters/index.ts",

    // Built benchmark friend. Deliberately absent from package.json exports.
    "internal/benchmark-operation": "./benchmarks/internal/operation.ts",
  },

  // Output format - ESM only since you're "type": "module"
  // Add "cjs" if you need CommonJS support for older tooling
  format: ["esm"],

  // Runtime name preservation must not inject JavaScript helpers into declarations.

  // Clean output directory before build
  clean: true,

  // Generate sourcemaps for debugging
  sourcemap: true,

  // Target the oldest runtime promised by package.json.
  target: "node22",

  // Output directory
  outDir: "./dist",

  // Don't bundle dependencies - they should be installed by consumers
  external: [
    // Runtime dependencies
    "commander",
    "pg",
    "@clack/prompts",
    // Peer dependencies
    "@electric-sql/pglite",
    "@cloudflare/workers-types",
    "@opentelemetry/api",
    "@neondatabase/serverless",
    "@planetscale/database",
    "@libsql/client",
    "mysql2",
    "better-sqlite3",
    "postgres",
    // Bun built-ins (only available in Bun runtime). "bun" itself must be
    // listed too: the SQL driver does `await import("bun")`, and an unlisted
    // built-in is a bundler WARNING, which the CI build turns into a failure.
    "bun",
    "bun:sqlite",
    "bun:sql",
  ],

  // Shims for Node.js builtins when targeting edge runtimes
  shims: true,
  minify: true,
  outputOptions: { keepNames: true },
  dts: false,
  // Enable tree-shaking
  treeshake: true,
} satisfies UserConfig;

function namedExports(source: ts.SourceFile) {
  return source.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((member) => ({
          name: member.name.text,
          typeOnly: statement.isTypeOnly || member.isTypeOnly,
          position: member.getStart(source),
        }))
      : []
  );
}

// rolldown-plugin-dts restores type markers by final export name across modules.
// A renamed function can collide with an unrelated type export (defineExtension
// becomes V, also the validation namespace type). Its own declaration proves
// that the shared binding is a value; public entries retain explicit type intent.
function restoreSharedFunctionValues(source: ts.SourceFile, code: string) {
  const functions = new Set(
    source.statements.flatMap((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name
        ? [statement.name.text]
        : []
    )
  );
  const printer = ts.createPrinter();
  let repaired = code;
  for (const statement of [...source.statements].reverse()) {
    if (
      !(
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (member) =>
            (statement.isTypeOnly || member.isTypeOnly) &&
            functions.has((member.propertyName ?? member.name).text)
        )
      )
    )
      continue;
    const members = statement.exportClause.elements.map((member) =>
      ts.factory.updateExportSpecifier(
        member,
        (statement.isTypeOnly || member.isTypeOnly) &&
          !functions.has((member.propertyName ?? member.name).text),
        member.propertyName,
        member.name
      )
    );
    const replacement = ts.factory.updateExportDeclaration(
      statement,
      statement.modifiers,
      false,
      ts.factory.updateNamedExports(statement.exportClause, members),
      statement.moduleSpecifier,
      statement.attributes
    );
    repaired = `${repaired.slice(0, statement.getStart(source))}${printer.printNode(ts.EmitHint.Unspecified, replacement, source)}${repaired.slice(statement.end)}`;
  }
  return repaired;
}

// Shared declaration chunking loses explicit type-only class reexports.
// Recover only each public entry's own source declarations, including aliases.
const declarationExportKinds: Rolldown.Plugin = {
  name: "preserve-public-type-export-kinds",
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk" || !chunk.fileName.endsWith(".d.mts"))
        continue;
      const entry = Object.entries(runtime.entry).find(
        ([name]) => chunk.fileName === `${name}.d.mts`
      );
      const declaration = ts.createSourceFile(
        chunk.fileName,
        chunk.code,
        ts.ScriptTarget.Latest,
        true
      );
      if (!entry) {
        chunk.code = restoreSharedFunctionValues(declaration, chunk.code);
        continue;
      }
      const source = ts.createSourceFile(
        entry[1],
        readFileSync(entry[1], "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      const names = new Set(
        namedExports(source)
          .filter((member) => member.typeOnly)
          .map((member) => member.name)
      );
      const positions = namedExports(declaration)
        .filter((member) => !member.typeOnly && names.has(member.name))
        .map((member) => member.position)
        .sort((left, right) => right - left);
      for (const position of positions)
        chunk.code = `${chunk.code.slice(0, position)}type ${chunk.code.slice(position)}`;
    }
  },
};

const { "soft-delete": softDelete, ...runtimeEntries } = runtime.entry;

export default defineConfig([
  { ...runtime, entry: runtimeEntries },
  {
    ...runtime,
    entry: { "soft-delete": softDelete },
    clean: false,
    // This type-only consumer has no runtime imports. Preserve that boundary
    // instead of retaining a shared name-preservation helper after minification.
    outputOptions: { keepNames: false },
  },
  {
    ...runtime,
    clean: false,
    minify: false,
    sourcemap: false,
    outputOptions: { keepNames: false },
    dts: { emitDtsOnly: true },
    plugins: [declarationExportKinds],
  },
]);
