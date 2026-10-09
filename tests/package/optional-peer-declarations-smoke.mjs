/** Root/schema declarations require only declared runtime dependencies. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

withPackedConsumer(
  "viborm-no-peer-declarations",
  {
    "consumer.ts": `import { s } from "viborm";
import { s as schema } from "viborm/schema";
export const user = s.model({ id: s.string(), name: schema.string() });
`,
  },
  ({ root }) => {
    // The general consumer helper supplies SQLite; this boundary intentionally does not.
    rmSync(join(root, "node_modules/better-sqlite3"));
    const typeRoots = join(root, "empty-types");
    mkdirSync(typeRoots);
    for (const compiler of ["typescript", "typescript-native"]) {
      try {
        execFileSync(
          process.execPath,
          [
            join(repositoryRoot, "node_modules", compiler, "bin/tsc"),
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "false",
            "--target",
            "ES2022",
            "--module",
            "ESNext",
            "--moduleResolution",
            "Bundler",
            "--lib",
            "ES2022,DOM",
            "--typeRoots",
            typeRoots,
            join(root, "consumer.ts"),
          ],
          { cwd: root, encoding: "utf8", stdio: "pipe" }
        );
        console.log(
          `${compiler}: no-peer root/schema skipLibCheck:false passed`
        );
      } catch (error) {
        throw new Error(
          `${compiler}: no-peer root/schema declarations failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`
        );
      }
    }
  }
);
