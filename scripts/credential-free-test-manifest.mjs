import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
 * 1536 MiB ceiling on their own. The allowlisted 2560 MiB exception exists for
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

const LOCAL_IMPORT = /from\s+"((?:\.\.?\/|@tests\/)[^"]+)"/g;

function resolveLocalImport(specifier, importer) {
  const base = specifier.startsWith("@tests/")
    ? resolve(projectRoot, "tests", specifier.slice("@tests/".length))
    : resolve(projectRoot, dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(projectRoot, candidate).replaceAll("\\", "/");
    }
  }
  return undefined;
}

/**
 * Does this file reach a live PGlite database, DIRECTLY OR THROUGH ITS OWN
 * LOCAL IMPORTS?
 *
 * Following the import graph is the point. Splitting the heavy suites moved
 * their database setup into sibling `*-fixtures.ts` modules, so a piece like
 * relation-key-update-legality-occupied-to-many.test.ts contains no mention of
 * PGlite at all while importing a module that opens one - and it measured
 * 1582 MiB alone. A content match on the test file alone cannot see that.
 */
function bootsLivePGlite(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  let source;
  try {
    source = readFileSync(resolve(projectRoot, file), "utf8");
  } catch {
    return false;
  }
  if (PGLITE_SOURCE.test(source)) return true;
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const dependency = resolveLocalImport(match[1], file);
    if (dependency && bootsLivePGlite(dependency, seen)) return true;
  }
  return false;
}

/**
 * A suite that uses `usePGliteSchemaFamily` shares the worker's ONE database and
 * takes only a private schema, so such suites pack: six of them measured
 * 1554 MiB against 1494 for a single one. They are grouped, not isolated.
 *
 * A suite that builds its own `new PGlite()` still costs a full ~1.3 GiB
 * instance and keeps running alone.
 */
const SHARED_FAMILY = /usePGliteSchemaFamily/;

function usesSharedFamily(file) {
  try {
    return SHARED_FAMILY.test(readFileSync(resolve(projectRoot, file), "utf8"));
  } catch {
    return false;
  }
}

export const EXTENDED_LOCAL_SHARED_FAMILY_TESTS = Object.freeze(
  EXTENDED_LOCAL_TESTS.filter(
    (file) => bootsLivePGlite(file) && usesSharedFamily(file)
  )
);

const SHARED_FAMILY_SHARD_SIZE = 20;

const shardCount = Math.ceil(
  EXTENDED_LOCAL_SHARED_FAMILY_TESTS.length / SHARED_FAMILY_SHARD_SIZE
);

export const EXTENDED_LOCAL_SHARED_FAMILY_SHARDS = Object.freeze(
  Array.from(
    { length: shardCount },
    // Round-robin, not contiguous slices. The list is sorted by path, so a
    // contiguous tail shard collected every cache suite at once and peaked
    // 2596 MiB against the 2560 ceiling with only 10 suites in it. Dealing the
    // files out spreads the heavy ones across every shard.
    (_unused, index) =>
      Object.freeze(
        EXTENDED_LOCAL_SHARED_FAMILY_TESTS.filter(
          (_file, position) => position % shardCount === index
        )
      )
  )
);

/**
 * Only a file that CONSTRUCTS an instance pays for one. `bootsLivePGlite` walks
 * imports, so it also flags files that merely reach a module capable of building
 * one - the docker legs skipped locally, and suites whose behavior module opens
 * at most a couple of databases between them. Measured: all 49 such files in ONE
 * process peak at 2182 MiB, against the 1536 an isolated one is given. They pack.
 */
const OWN_INSTANCE =
  /new PGlite\(|open(?:Borrowed|Test)PGlite|new \w*PGliteDriver\(/;

// The shared fixture builds the worker's ONE instance. Reaching it is what makes
// a suite cheap, so it must not count as building an instance of one's own.
const SHARED_FIXTURE = "tests/fixtures/drivers/pglite.ts";

/**
 * Walks local imports, exactly as `bootsLivePGlite` does. Reading only the test
 * file is not enough: an oracle or behavior module builds the instances on the
 * suite's behalf. `located-parent-ref-oracle-create.test.ts` constructs nothing
 * itself and still costs 2397 MiB through its helper.
 */
function buildsOwnInstance(file, seen = new Set()) {
  if (seen.has(file) || file.endsWith(SHARED_FIXTURE)) return false;
  seen.add(file);
  let source;
  try {
    source = readFileSync(resolve(projectRoot, file), "utf8");
  } catch {
    // Unreadable: assume the expensive shape and isolate it.
    return true;
  }
  if (OWN_INSTANCE.test(source)) return true;
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const dependency = resolveLocalImport(match[1], file);
    if (dependency && buildsOwnInstance(dependency, seen)) return true;
  }
  return false;
}

export const EXTENDED_LOCAL_PGLITE_TESTS = Object.freeze(
  EXTENDED_LOCAL_TESTS.filter(
    (file) =>
      bootsLivePGlite(file) &&
      !usesSharedFamily(file) &&
      buildsOwnInstance(file)
  )
);

const EXTENDED_LOCAL_IMPORTED_PGLITE_TESTS = EXTENDED_LOCAL_TESTS.filter(
  (file) =>
    bootsLivePGlite(file) && !usesSharedFamily(file) && !buildsOwnInstance(file)
);

const IMPORTED_PGLITE_SHARD_SIZE = 17;

export const EXTENDED_LOCAL_IMPORTED_PGLITE_SHARDS = Object.freeze(
  Array.from(
    {
      length: Math.ceil(
        EXTENDED_LOCAL_IMPORTED_PGLITE_TESTS.length / IMPORTED_PGLITE_SHARD_SIZE
      ),
    },
    (_unused, index) =>
      Object.freeze(
        EXTENDED_LOCAL_IMPORTED_PGLITE_TESTS.slice(
          index * IMPORTED_PGLITE_SHARD_SIZE,
          (index + 1) * IMPORTED_PGLITE_SHARD_SIZE
        )
      )
  )
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
