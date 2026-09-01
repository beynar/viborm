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

/**
 * Provider suites are enumerated FROM DISK, by filename prefix.
 *
 * They used to be hardcoded lists. When the six heaviest suites were split so
 * each piece could typecheck under the 1280 MB shard heap, every hardcoded list
 * silently kept naming only the original file, so the new pieces would have run
 * nowhere - a worse failure than the one the split fixed, because it is quiet.
 * Deriving them means a new piece is picked up the moment it exists.
 */
function providerTestFiles(directory, prefix) {
  const relative = `tests/providers/${directory}`;
  return Object.freeze(
    readdirSync(resolve(projectRoot, relative))
      .filter(
        (file) =>
          file.endsWith(".test.ts") &&
          (file === `${prefix}.test.ts` || file.startsWith(`${prefix}-`))
      )
      .sort()
      .map((file) => `${relative}/${file}`)
  );
}

export const PGLITE_PROVIDER_TESTS = providerTestFiles("local", "pglite");
export const SQLITE3_PROVIDER_TESTS = providerTestFiles("local", "sqlite3");
export const LIBSQL_PROVIDER_TESTS = providerTestFiles("local", "libsql");
