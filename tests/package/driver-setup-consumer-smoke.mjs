/** Supplied parser and D1 Session setup through real public package entries. */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

withPackedConsumer(
  "viborm-driver-setup-public",
  {
    "consumer.ts": `import type { D1Database } from '@cloudflare/workers-types';
import { D1Driver } from 'viborm/d1';
import { sqliteResultParser, type DriverResultParser } from 'viborm/driver';
import { vibormTypes } from 'viborm/postgres';
import postgres from 'postgres';
declare const database: D1Database;
export const driver = new D1Driver({ database: database.withSession('first-primary') });
// @ts-expect-error - arbitrary objects are not Sessions or Database bindings
new D1Driver({ database: {} });
export const parser: DriverResultParser = sqliteResultParser;
export const supplied = postgres('postgres://localhost/viborm_fixture', { types: vibormTypes });
`,
    "runtime.mjs": `import assert from 'node:assert/strict';
import { sqliteResultParser } from 'viborm/driver';
import { vibormTypes } from 'viborm/postgres';
const parsed = sqliteResultParser.parseField('{"answer":1}', 'json', value => value);
assert.deepEqual(parsed, { answer: 1 });
assert.equal(typeof vibormTypes.timestamp.parse, 'function');
console.log('driver-setup-public: pass');
`,
  },
  ({ root, run }) => {
    for (const name of [
      "postgres",
      "@cloudflare/workers-types",
      "@types/node",
    ]) {
      const target = join(root, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(
        realpathSync(join(repositoryRoot, "node_modules", name)),
        target,
        "dir"
      );
    }
    const project = join(root, "tsconfig.json");
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: ["node"],
          lib: ["ES2022", "DOM"],
        },
        files: ["consumer.ts"],
      })
    );
    for (const compiler of ["typescript-5-8", "typescript-native"]) {
      try {
        execFileSync(
          process.execPath,
          [
            join(repositoryRoot, "node_modules", compiler, "bin/tsc"),
            "--project",
            project,
          ],
          { cwd: root, stdio: "pipe", encoding: "utf8" }
        );
      } catch (error) {
        throw new Error(
          `${compiler} public driver setup failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`
        );
      }
    }
    run("runtime.mjs", "driver-setup-public");
  }
);
