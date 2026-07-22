#!/usr/bin/env node
// T3d — the full-estate blast-radius gate (P6 Stage 0).
//
// Runs the ENTIRE local estate with the V1 fallback globally disabled
// (vitest.blast-radius.config.ts -> tests/query-engine-v2/blast-radius.setup.ts:
// a V2 decline re-throws instead of routing to V1), then asserts the observed
// fallback-off failure set equals the documented residual
// (tests/query-engine-v2/blast-radius-residual.ts) EXACTLY:
//   · observed  \ allowlist  (a NEW decline pushed behind the fallback) -> RED
//   · allowlist \ observed   (a listed class absorbed but not delisted) -> RED
// Green iff the only fallback-off failures are the enumerated, design-noted
// boundaries. P6 Stage 0 reads this: it shrinks toward EMPTY as the subsystems
// land, and is EMPTY when V1 is deletable.
//
// Usage: node scripts/blast-radius-gate.mjs
// Docker-only driver legs (pg, mysql) self-skip without their connection strings;
// never export those in this shell.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const residualPath = join(
  root,
  "tests/query-engine-v2/blast-radius-residual.ts"
);

// Read the typed allowlist as text and extract the quoted test keys. A key is a
// string literal that starts with `tests/` and carries a ` > ` separator — the
// doc comments never contain that shape, so this is comment-safe and needs no TS
// runtime. The residual module stays the single typed source of truth.
const residualText = readFileSync(residualPath, "utf8");
const allowlist = new Set(
  [...residualText.matchAll(/"(tests\/[^"]+ > [^"]+)"/g)].map((m) => m[1])
);
if (allowlist.size === 0) {
  console.error("blast-radius gate: allowlist is empty — refusing to run.");
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), "blast-radius-"));
const jsonOut = join(outDir, "estate.json");

console.error(
  `blast-radius gate: running the full estate fallback-off (allowlist: ${allowlist.size})…`
);
const run = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.blast-radius.config.ts",
    "--reporter=json",
    "--outputFile",
    jsonOut,
  ],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] }
);
if (run.error) {
  console.error(`blast-radius gate: failed to launch vitest: ${run.error}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(jsonOut, "utf8"));
} catch (error) {
  console.error(`blast-radius gate: could not read the JSON report: ${error}`);
  process.exit(2);
}

const observed = new Set();
for (const file of report.testResults ?? []) {
  const relFile = relative(root, file.name).split("\\").join("/");
  for (const assertion of file.assertionResults ?? []) {
    if (assertion.status !== "failed") continue;
    const suite = (assertion.ancestorTitles ?? []).join(" > ");
    const key = suite
      ? `${relFile} > ${suite} > ${assertion.title}`
      : `${relFile} > ${assertion.title}`;
    observed.add(key);
  }
}

const unexpected = [...observed].filter((k) => !allowlist.has(k)).sort();
const missing = [...allowlist].filter((k) => !observed.has(k)).sort();

if (unexpected.length === 0 && missing.length === 0) {
  console.error(
    `blast-radius gate: GREEN — the only fallback-off failures are the ${allowlist.size} documented residual boundaries.`
  );
  process.exit(0);
}

if (unexpected.length > 0) {
  console.error(
    `\nblast-radius gate: RED — ${unexpected.length} UNEXPECTED fallback-off failure(s) (a decline pushed behind the fallback, or a new reachable shape):`
  );
  for (const key of unexpected) console.error(`  + ${key}`);
}
if (missing.length > 0) {
  console.error(
    `\nblast-radius gate: RED — ${missing.length} residual entr(y/ies) NO LONGER fail (absorbed?): delete them from blast-radius-residual.ts:`
  );
  for (const key of missing) console.error(`  - ${key}`);
}
process.exit(1);
