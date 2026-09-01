import { readdirSync, readFileSync } from "node:fs";
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

/**
 * The extended estate splits in two, because only one half may use the raised
 * ceiling.
 *
 * A single live PGlite instance costs a measured 1294 MiB floor and the
 * heaviest file measured 1747 MiB, so 62% of these files exceed the ordinary
 * 1536 MiB ceiling on their own. The allowlisted 1792 MiB exception exists for
 * exactly that, but it is conditioned on ISOLATION: one process must not be
 * able to accumulate several databases. Packing three PGlite files into one
 * process is precisely the accumulation the condition forbids.
 *
 * So a file that boots PGlite runs ALONE, and only those stages may select the
 * raised ceiling. Everything else keeps the ordinary 1536 MiB and the existing
 * three-file packing, which is what its measured footprint supports.
 */
// Deliberately broad and case-insensitive. A token list missed
// `import { createClient as PGliteCreateClient } from "@drivers/pglite"`,
// and 24 PGlite-touching files stayed packed - one of them put a supposedly
// ordinary shard 3.2 MiB over the ceiling. Over-matching costs only isolation,
// a file running alone that need not; under-matching breaks the run.
const PGLITE_SOURCE = /pglite/i;
/@electric-sql\/pglite|PGliteDriver|usePGliteSchemaFamily|openTestPGlite|openBorrowedPGlite/;

function bootsLivePGlite(file) {
  try {
    return PGLITE_SOURCE.test(readFileSync(resolve(projectRoot, file), "utf8"));
  } catch {
    return false;
  }
}

export const EXTENDED_LOCAL_PGLITE_TESTS = Object.freeze(
  EXTENDED_LOCAL_TESTS.filter(bootsLivePGlite)
);

const EXTENDED_LOCAL_ORDINARY_TESTS = EXTENDED_LOCAL_TESTS.filter(
  (file) => !bootsLivePGlite(file)
);

const EXTENDED_LOCAL_SHARD_SIZE = 3;

export const EXTENDED_LOCAL_TEST_SHARDS = Object.freeze(
  Array.from(
    {
      length: Math.ceil(
        EXTENDED_LOCAL_ORDINARY_TESTS.length / EXTENDED_LOCAL_SHARD_SIZE
      ),
    },
    (_, index) =>
      Object.freeze(
        EXTENDED_LOCAL_ORDINARY_TESTS.slice(
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
