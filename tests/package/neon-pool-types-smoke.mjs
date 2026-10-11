/**
 * D6: a Neon WebSocket `Pool` type-checks as `viborm/pg`'s supplied `pool`
 * against the repository's `@types/pg` AND the newest one a consumer installs.
 *
 * Neon bundles its own copy of the pg declarations, so whether its `Pool` is
 * accepted depends on the consumer's `@types/pg`: 8.16.0 accepted the full
 * `Pool` type and 8.23.1 refused it (TS2322: its `PoolClient` became a whole
 * `Client`). The newest version is installed beside the consumer — from the
 * npm cache when it is warm — and linked as the consumer's `@types/pg`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPackedConsumer,
  packedArchive,
  repositoryRoot,
} from "./packed-consumer.mjs";

/** The newest `@types/pg` when this was written; bump it as releases land. */
const NEWEST_TYPES_PG = "8.23.1";

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-neon-pool-types-"));
try {
  const consumerRoot = join(fixtureRoot, "consumer");
  createPackedConsumer(
    consumerRoot,
    packedArchive(fixtureRoot),
    "viborm-neon-pool-types",
    ["pg", "@neondatabase/serverless", "@types/pg"]
  );
  writeFileSync(
    join(consumerRoot, "consumer.ts"),
    `import { Pool as NeonPool } from "@neondatabase/serverless";
import { Pool } from "pg";
import { s } from "viborm";
import { createClient } from "viborm/pg";

const schema = { account: s.model({ id: s.string().id() }).map("accounts") };
export const neon = createClient({
  pool: new NeonPool({ connectionString: "postgres://u:p@ep-x.neon.tech/db" }),
  schema,
});
export const pg = createClient({ pool: new Pool(), schema });
// @ts-expect-error a number is not a pool
export const wrong = createClient({ pool: 42, schema });
`
  );
  const typeCheck = (label) => {
    try {
      execFileSync(
        process.execPath,
        [
          join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "nodenext",
          "--moduleResolution",
          "nodenext",
          "--types",
          "node",
          "--typeRoots",
          join(repositoryRoot, "node_modules", "@types"),
          "consumer.ts",
        ],
        { cwd: consumerRoot, encoding: "utf8", stdio: "pipe" }
      );
    } catch (error) {
      throw new Error(
        `A Neon Pool is refused with @types/pg ${label}:\n${error.stdout ?? ""}${error.stderr ?? ""}`
      );
    }
    console.log(`@types/pg ${label}: Neon Pool accepted, a non-pool refused`);
  };
  typeCheck("from the repository");

  const newest = join(fixtureRoot, "newest");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      newest,
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      `@types/pg@${NEWEST_TYPES_PG}`,
    ],
    { stdio: "pipe" }
  );
  const linked = join(consumerRoot, "node_modules", "@types", "pg");
  rmSync(linked);
  symlinkSync(join(newest, "node_modules", "@types", "pg"), linked, "dir");
  typeCheck(NEWEST_TYPES_PG);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
