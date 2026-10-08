/** Actual require(esm) consumer: flag-free on Node22.12+ and current24. */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

withPackedConsumer(
  "viborm-commonjs-consumer",
  {
    "app.cjs": `const assert = require("node:assert/strict");
const { createClient, sql, QueryError } = require("viborm");
const { s } = require("viborm/schema");
const { SQLite3Driver } = require("viborm/sqlite3");
async function main() {
  const entry = s.model({ id: s.string().id({ generate: false }), title: s.string() });
  const db = createClient({ schema: { entry }, driver: new SQLite3Driver() });
  try {
    await db.$executeRaw(sql\`CREATE TABLE entry (id TEXT PRIMARY KEY, title TEXT NOT NULL)\`);
    await db.entry.create({ data: { id: "one", title: "from CommonJS" } });
    const row = await db.entry.findUnique({ where: { id: "one" } });
    assert.equal(row.title, "from CommonJS");
    assert.equal((await db.$queryRaw(sql\`SELECT 1 AS value\`))[0].value, 1);
    assert.equal(new QueryError("fixture").name, "QueryError");
  } finally { await db.$disconnect(); }
  console.log("CommonJS consumer: pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`,
    "consumer.cts": `import { createClient, s, sql } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
export const db = createClient({ schema: { entry: s.model({ id: s.string().id(), title: s.string() }) }, driver: new SQLite3Driver() });
export const read = () => db.entry.findUnique({ where: { id: "one" } });
export const raw = () => db.$queryRaw<{ value: number }>(sql\`SELECT 1 AS value\`);
// @ts-expect-error - the genuine .cts consumer retains scalar input types
void db.entry.findUnique({ where: { id: 42 } });
`,
  },
  ({ run, root }) => {
    mkdirSync(join(root, "node_modules/@types"), { recursive: true });
    for (const peer of ["better-sqlite3", "node"])
      symlinkSync(
        realpathSync(join(repositoryRoot, "node_modules/@types", peer)),
        join(root, "node_modules/@types", peer),
        "dir"
      );
    const project = join(root, "tsconfig.json");
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: ["node"],
          lib: ["ES2022", "DOM"],
        },
        files: ["consumer.cts"],
      })
    );
    for (const compiler of ["typescript-5-8", "typescript-native"])
      try {
        execFileSync(
          process.execPath,
          [
            join(repositoryRoot, "node_modules", compiler, "bin/tsc"),
            "--project",
            project,
          ],
          { cwd: root, encoding: "utf8", stdio: "pipe" }
        );
      } catch (error) {
        throw new Error(
          `${compiler} CommonJS type consumer failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`
        );
      }
    run("app.cjs", "CommonJS consumer");
  }
);
