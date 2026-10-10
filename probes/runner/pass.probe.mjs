// Runner self-test: the consumer resolves viborm and every linked driver.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "RUNNER-PASS",
  title: "The consumer resolves viborm and its drivers",
  plan: "phase-0/M0.1",
  needs: [],
  source: "scripts/probe-corpus.mjs",
};

const DRIVERS = [
  "@electric-sql/pglite",
  "pg",
  "postgres",
  "mysql2",
  "@libsql/client",
  "@neondatabase/serverless",
];

export default async function probe(ctx) {
  writeFileSync(join(ctx.tmpDir, "written"), ctx.version);
  for (const driver of DRIVERS) import.meta.resolve(driver);
  return {
    status: typeof createClient === "function" ? "pass" : "fail",
    evidence: `viborm ${ctx.version} loaded viborm/sqlite3 and resolved ${DRIVERS.length} more drivers`,
  };
}
