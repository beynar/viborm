#!/usr/bin/env node

/**
 * Instrumentation bundle and public-member measurement.
 *
 * `scripts/measure-bundle.mjs` weighs the four committed fixtures against the
 * built `dist/`. The instrumentation encapsulation plan
 * (`docs/architecture/instrumentation-encapsulation-plan.md`) needs three more
 * bundles and a per-source-module attribution, so this script:
 *
 *  - bundles each fixture below against BOTH `<root>/dist` (the headline bytes,
 *    same esbuild options as `measure-bundle.mjs`) and `<root>/src` (esbuild
 *    resolves the tsconfig paths, so the metafile's `bytesInOutput` attributes
 *    the minified bytes to each source module);
 *  - templates its fixtures inline and writes them to a throwaway directory
 *    beside the output file — never to `scripts/bundle-fixtures/`, which owns
 *    the committed fixtures of `measure-bundle.mjs`.
 *
 * `pg-instrumented` is `pg-representative` plus the installed extension, so
 * their difference is what installing `instrumentation()` costs. `s-only` is the
 * schema-only bundle that must not move. The `src` rows attribute bytes per
 * module; the plan's structural check reads the `src/instrumentation/` keys of
 * the src-mode `pg-representative` inputs.
 *
 * `--members` prints, from `<root>/dist/*.d.mts`, one line per declared member
 * of the five public driver/cache classes, comments stripped and whitespace
 * collapsed. Class members are invisible to the export-name golden
 * (`tests/package/public-surface-golden.mjs`), so a diff of this output between
 * two builds is the check that the public class surface changed only as
 * approved.
 *
 * Usage (after `node node_modules/tsdown/dist/run.mjs`):
 *   node scripts/measure-instrumentation-bundles.mjs <repoRoot> <out.json>
 *   node scripts/measure-instrumentation-bundles.mjs --members <repoRoot>
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { brotliCompressSync, gzipSync, constants as Z } from "node:zlib";

const ESBUILD_STORE_DIRECTORY = /^esbuild@0\.28\.1$/;
const SOURCE_OR_DIST_PREFIX = /^.*?\/(src|dist)\//;
const DECLARATION_FILE = /\.d\.mts$/;
const WHITESPACE_RUN = /\s+/g;
const MEMBER_CLASSES = [
  "DriverInstrumentationBase",
  "DriverTransactionBase",
  "Driver",
  "TransactionBoundDriver",
  "CacheDriver",
];

const EXTERNAL = [
  "pg",
  "postgres",
  "mysql2",
  "better-sqlite3",
  "@libsql/client",
  "@neondatabase/serverless",
  "@planetscale/database",
  "@electric-sql/pglite",
  "@cloudflare/workers-types",
  "@opentelemetry/api",
  "commander",
  "@clack/prompts",
  "bun",
  "bun:sqlite",
  "bun:sql",
];
const OPTS = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  minify: true,
  treeShaking: true,
  external: EXTERNAL,
  write: false,
  legalComments: "none",
  logLevel: "silent",
  metafile: true,
};
const ENTRIES = {
  index: ["index.mjs", "src/index.ts"],
  schema: ["schema.mjs", "src/schema/exports.ts"],
  pg: ["pg.mjs", "src/drivers/pg/index.ts"],
  instrumentation: ["instrumentation.mjs", "src/instrumentation/exports.ts"],
  cache: ["cache.mjs", "src/cache/exports.ts"],
  cacheMemory: ["cache/memory.mjs", "src/cache/drivers/memory.ts"],
  sqlite3: ["sqlite3.mjs", "src/drivers/sqlite3/index.ts"],
  adapters: ["adapters.mjs", "src/adapters/index.ts"],
  client: ["client.mjs", "src/client/exports.ts"],
  config: ["config.mjs", "src/config.ts"],
  driver: ["driver.mjs", "src/drivers/exports.ts"],
  migrations: ["migrations.mjs", "src/migrations/index.ts"],
  migrationsFs: ["migrations/storage/fs.mjs", "src/migrations/storage/fs.ts"],
  schemaJson: ["schema/json.mjs", "src/schema/json/index.ts"],
  sql: ["sql.mjs", "src/sql/sql.ts"],
  validation: ["validation.mjs", "src/validation/index.ts"],
};
const MODEL = `const user = s.model({ id: s.string().id(), email: s.string().unique(), posts: s.toMany(() => post) });
const post = s.model({ id: s.string().id(), title: s.string(), authorId: s.string(), author: s.toOne(() => user).fields("authorId").references("id") });`;
const RUN = `export async function run() {
  const users = await client.user.findMany({ where: { email: { contains: "@example.com" } }, include: { posts: true } });
  return client.post.create({ data: { title: "hello", authorId: users[0].id } });
}`;
const FULL_ENTRIES = [
  "adapters",
  "cacheMemory",
  "cache",
  "client",
  "config",
  "driver",
  "instrumentation",
  "migrationsFs",
  "migrations",
  "pg",
  "schemaJson",
  "schema",
  "sql",
  "validation",
];
const FIXTURES = {
  "ids-only": (e) => `import { s } from ${e("schema")};
export const generated = [s.string().uuid(), s.string().ulid(), s.string().nanoid(), s.string().cuid(), s.string().id()].map((f) => f["~"].state.default());`,
  "s-only": (e) =>
    `import { s } from ${e("index")};\n${MODEL}\nexport { user, post };`,
  "pg-representative": (
    e
  ) => `import { createClient } from ${e("pg")};\nimport { s } from ${e("schema")};\n${MODEL}
export const client = createClient({ schema: { user, post }, databaseUrl: "postgres://localhost:5432/app" });\n${RUN}`,
  "pg-instrumented": (
    e
  ) => `import { createClient } from ${e("pg")};\nimport { s } from ${e("schema")};\nimport { instrumentation } from ${e("instrumentation")};\n${MODEL}
export const client = createClient({ schema: { user, post }, databaseUrl: "postgres://localhost:5432/app" }).$extends(instrumentation({ tracing: true, logging: { query: true, error: true } }));\n${RUN}`,
  "sqlite3-representative": (
    e
  ) => `import { createClient } from ${e("sqlite3")};\nimport { s } from ${e("schema")};\n${MODEL}
export const client = createClient({ schema: { user, post }, databaseUrl: ":memory:" });\n${RUN}`,
  full: (e) =>
    `${FULL_ENTRIES.map((k) => `export * as ${k} from ${e(k)};`).join("\n")}\nexport * from ${e("index")};`,
};

const loadEsbuild = async (root) => {
  const store = join(root, "node_modules/.pnpm");
  const directory = readdirSync(store).find((name) =>
    ESBUILD_STORE_DIRECTORY.test(name)
  );
  if (directory === undefined) {
    throw new Error("esbuild@0.28.1 is not in node_modules/.pnpm");
  }
  const entry = join(store, directory, "node_modules/esbuild/lib/main.js");
  return (await import(`file://${entry}`)).default;
};

const inputKey = (name) => {
  if (!name.includes("node_modules/")) {
    return name.replace(SOURCE_OR_DIST_PREFIX, "$1/");
  }
  const tail = name.split("node_modules/").pop();
  const depth = tail.startsWith("@") ? 2 : 1;
  return `node_modules:${tail.split("/").slice(0, depth).join("/")}`;
};

const measureFixtures = async (root, out) => {
  const esbuild = await loadEsbuild(root);
  const fixDir = join(
    dirname(out),
    `fixtures-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(fixDir, { recursive: true });
  const result = { root, fixtures: {} };
  try {
    for (const [name, template] of Object.entries(FIXTURES)) {
      const row = {};
      for (const mode of ["dist", "src"]) {
        const e = (k) =>
          JSON.stringify(
            join(
              root,
              mode === "dist" ? `dist/${ENTRIES[k][0]}` : ENTRIES[k][1]
            )
          );
        const file = join(fixDir, `${name}.${mode}.mjs`);
        writeFileSync(file, template(e));
        let built;
        try {
          built = await esbuild.build({
            ...OPTS,
            absWorkingDir: root,
            entryPoints: [file],
            ...(mode === "src"
              ? { tsconfig: join(root, "tsconfig.json") }
              : {}),
          });
        } catch (error) {
          row[mode] = { error: String(error.message).slice(0, 2000) };
          continue;
        }
        const bytes = built.outputFiles[0].contents;
        const output = Object.values(built.metafile.outputs)[0];
        const inputs = {};
        // The throwaway fixture path is random; key it by role so two runs diff.
        const fixtureInput = relative(root, file);
        for (const [inputName, input] of Object.entries(output.inputs)) {
          const key =
            inputName === fixtureInput ? "fixture" : inputKey(inputName);
          inputs[key] = (inputs[key] ?? 0) + input.bytesInOutput;
        }
        row[mode] = {
          raw: bytes.byteLength,
          gzip: gzipSync(bytes, { level: 9 }).byteLength,
          brotli: brotliCompressSync(bytes, {
            params: { [Z.BROTLI_PARAM_QUALITY]: Z.BROTLI_MAX_QUALITY },
          }).byteLength,
          inputs,
        };
      }
      result.fixtures[name] = row;
    }
  } finally {
    rmSync(fixDir, { recursive: true, force: true });
  }
  writeFileSync(out, JSON.stringify(result, null, 1));
  for (const [name, row] of Object.entries(result.fixtures)) {
    process.stdout.write(
      `${[
        name.padEnd(24),
        "dist",
        row.dist.raw ?? row.dist.error,
        row.dist.gzip,
        "| src",
        row.src.raw ?? row.src.error,
        row.src.gzip,
      ].join(" ")}\n`
    );
  }
};

const printMembers = (root) => {
  const ts = createRequire(join(root, "package.json"))("typescript");
  const printer = ts.createPrinter({ removeComments: true });
  const distDir = join(root, "dist");
  const lines = new Set();
  const files = readdirSync(distDir)
    .filter((name) => DECLARATION_FILE.test(name))
    .sort();
  for (const name of files) {
    const text = readFileSync(join(distDir, name), "utf8");
    const source = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const className = statement.name?.text;
      if (className === undefined || !MEMBER_CLASSES.includes(className)) {
        continue;
      }
      for (const member of statement.members) {
        const printed = printer
          .printNode(ts.EmitHint.Unspecified, member, source)
          .replace(WHITESPACE_RUN, " ")
          .trim();
        lines.add(`${className}: ${printed}`);
      }
    }
  }
  for (const className of MEMBER_CLASSES) {
    for (const line of lines) {
      if (line.startsWith(`${className}: `)) process.stdout.write(`${line}\n`);
    }
  }
};

const args = process.argv.slice(2);
if (args[0] === "--members") {
  if (args[1] === undefined) {
    throw new Error(
      "usage: node scripts/measure-instrumentation-bundles.mjs --members <repoRoot>"
    );
  }
  printMembers(resolve(args[1]));
} else {
  if (args[0] === undefined || args[1] === undefined) {
    throw new Error(
      "usage: node scripts/measure-instrumentation-bundles.mjs <repoRoot> <out.json>"
    );
  }
  await measureFixtures(resolve(args[0]), resolve(args[1]));
}
