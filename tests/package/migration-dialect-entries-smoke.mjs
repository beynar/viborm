/**
 * `viborm/migrations/<dialect>` registers its dialect, and only it, in a
 * bundled consumer.
 *
 * Wrangler's esbuild bundles the BUILT entries. A bare
 * `import "viborm/migrations/postgres"` (the tenant migrator's documented
 * form) must survive the package's `sideEffects`, and a bundle that imports
 * `createMigrationClient` from the PostgreSQL entry must plan a PostgreSQL
 * push and refuse a SQLite client: the SQLite migration driver is not there.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

const outDirectory = join(
  repositoryRoot,
  "node_modules/.cache/viborm-dialect-entries"
);
mkdirSync(outDirectory, { recursive: true });

// Each push's operation count, or the code it was refused with.
const pushes = async (entry) => {
  const outfile = join(outDirectory, `${entry.replaceAll("/", "-")}.mjs`);
  await bundle(
    `import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { createMigrationClient } from "${entry}";
import { createClient as createPgliteClient } from "viborm/pglite";
import { s } from "viborm/schema";
import { createClient as createSqliteClient } from "viborm/sqlite3";

const user = s.model({ id: s.string().id(), email: s.string() });
const push = (client) =>
  createMigrationClient(client)
    .push({ dryRun: true })
    .then((preview) => preview.operations.length, (error) => error.code)
    .finally(() => client.$disconnect());

export const run = async () => [
  await push(createPgliteClient({ client: new PGlite(), schema: { user } })),
  await push(
    createSqliteClient({ client: new Database(":memory:"), schema: { user } })
  ),
];
`,
    { outfile, platform: "node" }
  );
  return (await import(pathToFileURL(outfile).href)).run();
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
