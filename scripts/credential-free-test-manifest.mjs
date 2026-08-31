import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsRoot = resolve(projectRoot, "tests");

const extendedLocalExclusions = new Set([
  "tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts",
  "tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts",
  "tests/unit/migrations/mysql-strict-mode-docker.test.ts",
]);

function testFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...testFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(projectRoot, path).replaceAll("\\", "/"));
    }
  }
  return files;
}

export const EXTENDED_LOCAL_TESTS = Object.freeze(
  testFiles(testsRoot)
    .filter(
      (file) =>
        !(
          file.endsWith(".core.test.ts") ||
          file.startsWith("tests/package/") ||
          file.startsWith("tests/providers/") ||
          extendedLocalExclusions.has(file)
        )
    )
    .sort()
);

// Six live-PGlite files in one process peaked just over 3072 MiB on three
// shards. No single file needs that much (the heaviest measured is ~2.2 GiB),
// so the accumulation is what has to come down, not the ceiling.
const EXTENDED_LOCAL_SHARD_SIZE = 3;

export const EXTENDED_LOCAL_TEST_SHARDS = Object.freeze(
  Array.from(
    {
      length: Math.ceil(
        EXTENDED_LOCAL_TESTS.length / EXTENDED_LOCAL_SHARD_SIZE
      ),
    },
    (_, index) =>
      Object.freeze(
        EXTENDED_LOCAL_TESTS.slice(
          index * EXTENDED_LOCAL_SHARD_SIZE,
          (index + 1) * EXTENDED_LOCAL_SHARD_SIZE
        )
      )
  )
);

export const PGLITE_PROVIDER_TESTS = Object.freeze([
  "tests/providers/local/pglite-vector.test.ts",
  "tests/providers/local/pglite.test.ts",
]);
