// U4 repair round: what the credential-free WALK collects, before and after the
// one-line `extendedLocalExclusions` entry. The "before" module is a transient
// copy of the current file with that one line removed; it is deleted again.
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const root = "/private/tmp/viborm-sm";
const entry = '  "tests/unit/migrations/mysql-defaults-docker.test.ts",\n';
const src = readFileSync(
  `${root}/scripts/credential-free-test-manifest.mjs`,
  "utf8"
);
if (!src.includes(entry)) throw new Error("entry not present");
const beforePath = `${root}/scripts/.u4-walk-before.mjs`;
writeFileSync(beforePath, src.replace(entry, ""));

const witness = "tests/unit/migrations/mysql-defaults-docker.test.ts";
const report = (label, mod) => {
  const files = mod.EXTENDED_LOCAL_TESTS;
  const shards = mod.EXTENDED_LOCAL_TEST_SHARDS;
  const where = shards
    .map((shard, index) => [index + 1, shard.tests ?? shard])
    .filter(([, tests]) => tests.includes(witness))
    .map(([index]) => index);
  console.log(
    `${label} | EXTENDED_LOCAL_TESTS=${files.length} | witness collected=${files.includes(witness)} | shards=${shards.length} | witness in shard=${where.length ? where.join(",") : "none"}`
  );
  return shards.map((shard) => JSON.stringify(shard.tests ?? shard));
};

try {
  const before = report(
    "before (walk adopts it)",
    await import(beforePath)
  );
  const after = report(
    "after  (named, skipped)",
    await import(`${root}/scripts/credential-free-test-manifest.mjs`)
  );
  const changed = before
    .map((shard, index) => (shard === after[index] ? null : index + 1))
    .filter((index) => index !== null);
  console.log(
    `shards whose contents differ between before and after: ${changed.length ? changed.join(", ") : "none"}`
  );
} finally {
  rmSync(beforePath, { force: true });
}
