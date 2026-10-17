/**
 * `viborm/migrations/<dialect>` registers its dialect, and only it, in a
 * bundled consumer.
 *
 * Wrangler's esbuild bundles the BUILT entries. A bare
 * `import "viborm/migrations/postgres"` (the tenant migrator's documented
 * form) must survive the package's `sideEffects`, and a bundle that imports
 * `createMigrationClient` from the PostgreSQL entry must plan a PostgreSQL
 * push and refuse a SQLite client: the SQLite migration driver is not there.
 * The SQLite and MySQL entries carry none of PostgreSQL's catalog reads: the
 * PostgreSQL driver owns its introspection and its catalog digest.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { repositoryRoot } from "./packed-consumer.mjs";

const esbuild = createRequire(
  createRequire(join(repositoryRoot, "package.json")).resolve(
    "wrangler/package.json"
  )
)("esbuild");
const bundle = (contents, options) =>
  esbuild.build({
    stdin: { contents, resolveDir: repositoryRoot, loader: "js" },
    bundle: true,
    format: "esm",
    external: ["@electric-sql/pglite", "better-sqlite3"],
    logLevel: "silent",
    ...options,
  });

// The package resolves itself by name, so its `sideEffects` applies.
const bare = await bundle(`import "viborm/migrations/postgres";`, {
  write: false,
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
});
if (bare.outputFiles[0].contents.length === 0) {
  throw new Error(
    "a bundler dropped a bare import of viborm/migrations/postgres"
  );
}

// Catalog SQL only PostgreSQL's introspection and digest spell, looked for in
// every built chunk an entry reaches, lazy ones included: what a bundler can
// keep, before tree-shaking, without another bundle in this process.
const POSTGRES_CATALOG = ["confdeltype", "indnullsnotdistinct"];
const CHUNK_IMPORT =
  /\bfrom\s*["'](\.[^"']+)["']|\bimport\s*\(?\s*["'](\.[^"']+)["']/g;
const reachedChunks = (entry) => {
  const reached = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const [, from, imported] of readFileSync(file, "utf8").matchAll(
      CHUNK_IMPORT
    )) {
      pending.push(resolve(dirname(file), from ?? imported));
    }
  }
  return reached;
};
const { exports } = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
for (const entry of ["./migrations/sqlite", "./migrations/mysql"]) {
  const chunks = reachedChunks(join(repositoryRoot, exports[entry].import));
  const carried = POSTGRES_CATALOG.filter((marker) =>
    [...chunks].some((chunk) => readFileSync(chunk, "utf8").includes(marker))
  );
  if (carried.length > 0) {
    throw new Error(
      `viborm${entry.slice(1)} carries PostgreSQL catalog code (${carried.join(", ")})`
    );
  }
}

const outDirectory = join(
  repositoryRoot,
  "node_modules/.cache/viborm-dialect-entries"
);
mkdirSync(outDirectory, { recursive: true });

// Each push's operation count, or the code it was refused with.
// The ORM owns these in-memory providers, so the push's finally disconnect
// releases them before the next bundled consumer opens another database.
const pushes = async (entry) => {
  const outfile = join(outDirectory, `${entry.replaceAll("/", "-")}.mjs`);
  await bundle(
    `import { createMigrationClient } from "${entry}";
import { createClient as createPgliteClient } from "viborm/pglite";
import { s } from "viborm/schema";
import { createClient as createSqliteClient } from "viborm/sqlite3";

const user = s.model({ id: s.string().id(), email: s.string() });
const push = (client) =>
  createMigrationClient(client)
    .push({ dryRun: true })
    .then((preview) => preview.operations.length, (error) => error.code)
    .finally(() => client.$disconnect());

const run = async () => [
  await push(createPgliteClient({ schema: { user } })),
  await push(
    createSqliteClient({ dataDir: ":memory:", schema: { user } })
  ),
];
console.log(JSON.stringify(await run()));
`,
    { outfile, platform: "node" }
  );
  // Closing PGlite releases its database, but the process may retain its Wasm
  // allocation. A finished consumer process releases that memory before the
  // next consumer starts, while also isolating their dialect registries.
  // This smoke checks SQL and dialect registration, not V8 tiering. Baseline
  // Wasm compilation avoids PGlite startup exceeding the shared RSS ceiling.
  return JSON.parse(
    execFileSync(process.execPath, ["--liftoff-only", outfile], {
      encoding: "utf8",
    })
  );
};

for (const [entry, sqlite] of [
  ["viborm/migrations", "planned"],
  ["viborm/migrations/postgres", "V8002"],
]) {
  const [postgresPush, sqlitePush] = await pushes(entry);
  const sqliteOutcome = typeof sqlitePush === "number" ? "planned" : sqlitePush;
  if (!(postgresPush > 0 && sqliteOutcome === sqlite)) {
    throw new Error(
      `${entry} registered the wrong migration drivers: PostgreSQL ${postgresPush}, SQLite ${sqlitePush}`
    );
  }
  console.log(`${entry}: PostgreSQL planned, SQLite ${sqliteOutcome}`);
}
