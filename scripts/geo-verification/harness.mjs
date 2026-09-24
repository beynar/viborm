/**
 * Plumbing shared by the geo verification scripts: VibORM's polygon codec
 * bundled from this checkout's source, the seeded generators the documented
 * runs used, and the adapters' `withinPolygon` predicates on PGlite + PostGIS
 * and, when MYSQL_TEST_CONNECTION_STRING is set, on MySQL 8.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);

// ---------------------------------------------------------------------------
// The codec, from src/
// ---------------------------------------------------------------------------

const ESBUILD_STORE_DIRECTORY = /^esbuild@(\d+)\.(\d+)\.(\d+)$/;

/** esbuild as scripts/measure-bundle.mjs finds it: direct, else pnpm's store. */
async function loadEsbuild() {
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  try {
    const mod = await import(requireFromRepo.resolve("esbuild"));
    return mod.default ?? mod;
  } catch {
    // not a direct dependency; fall through to the virtual store
  }
  const store = join(repoRoot, "node_modules", ".pnpm");
  const newest = (existsSync(store) ? readdirSync(store) : [])
    .map((name) => ({ name, version: ESBUILD_STORE_DIRECTORY.exec(name) }))
    .filter(({ version }) => version)
    .sort((a, b) => {
      for (let part = 1; part <= 3; part += 1) {
        const difference = Number(a.version[part]) - Number(b.version[part]);
        if (difference !== 0) return difference;
      }
      return 0;
    })
    .at(-1);
  if (!newest) throw new Error("esbuild not found; run `pnpm install`");
  const entry = join(store, newest.name, "node_modules/esbuild/lib/main.js");
  const mod = await import(entry);
  return mod.default ?? mod;
}

/**
 * `validateGeoPolygon` from src/validation/primitives/geo-area-codec.ts and
 * `geoPolygonJson` from src/adapters/shared/geo-point.ts, bundled in memory
 * with the repository's tsconfig paths.
 */
export async function loadCodec() {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { validateGeoPolygon } from "./src/validation/primitives/geo-area-codec.ts";',
        'export { geoPolygonJson } from "./src/adapters/shared/geo-point.ts";',
      ].join("\n"),
      loader: "ts",
      resolveDir: repoRoot,
      sourcefile: "geo-verification-entry.ts",
    },
    bundle: true,
    format: "esm",
    logLevel: "error",
    platform: "node",
    tsconfig: join(repoRoot, "tsconfig.json"),
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

// ---------------------------------------------------------------------------
// Seeded generators, exactly as the documented runs drew their numbers
// ---------------------------------------------------------------------------

// biome-ignore-start lint/suspicious/noBitwiseOperators: xorshift is bitwise by definition
/** xorshift32 in [0, 1) (review round 3, geo-review3 and mysql-departure). */
export function xorshift32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4_294_967_296;
  };
}

/**
 * The review round 7 variant: its middle shift is arithmetic (`>>`), so it is
 * a different stream from `xorshift32` for the same seed. Kept so its seeds
 * replay.
 */
export function xorshift32Arithmetic(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4_294_967_296;
  };
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: xorshift is bitwise by definition

/** Park and Miller's minimal standard generator, multiplier 48271, in (0, 1). */
export function minimalStandard(seed) {
  let s = seed;
  return () => {
    s = (s * 48_271) % 2_147_483_647;
    return s / 2_147_483_647;
  };
}

const FLAG = /^--([^=]+)(?:=(.*))?$/;

/** Command-line flags of the form `--name=value`. */
export function flags(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const argument of argv) {
    const match = FLAG.exec(argument);
    if (match) out[match[1]] = match[2] ?? true;
    else out._.push(argument);
  }
  return out;
}

/** "1111,2222" or "301-306" to [1111, 2222] or [301, ..., 306]. */
export function seedList(text) {
  return String(text)
    .split(",")
    .flatMap((part) => {
      const [from, to] = part.split("-").map(Number);
      if (to === undefined) return [from];
      return Array.from({ length: to - from + 1 }, (_, index) => from + index);
    });
}

// ---------------------------------------------------------------------------
// Databases: the adapters' own point encoding and polygon predicate
// ---------------------------------------------------------------------------

const MYSQL_SKIPPED =
  "MySQL skipped: MYSQL_TEST_CONNECTION_STRING is not set (e.g. mysql://root:password@127.0.0.1:3307/viborm)";

export const mysqlConfigured = () =>
  Boolean(process.env.MYSQL_TEST_CONNECTION_STRING);

/**
 * PGlite with PostGIS always; MySQL only when configured. Each gets a points
 * table with the column types VibORM migrations create and a spatial index.
 */
export async function openDatabases({ mysql: wantMysql = true } = {}) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { postgis } = await import("@electric-sql/pglite-postgis");
  const pg = await PGlite.create({ extensions: { postgis } });
  await pg.exec(
    "CREATE EXTENSION IF NOT EXISTS postgis; CREATE TABLE pts (id int PRIMARY KEY, location geography(Point,4326) NOT NULL); CREATE INDEX pts_gist ON pts USING GIST (location);"
  );
  const table = `geo_verification_${process.pid}`;
  let my;
  if (wantMysql && mysqlConfigured()) {
    const { default: mysql } = await import("mysql2/promise");
    my = await mysql.createConnection(process.env.MYSQL_TEST_CONNECTION_STRING);
    await my.query(`DROP TABLE IF EXISTS ${table}`);
    await my.query(
      `CREATE TABLE ${table} (id int PRIMARY KEY, location POINT SRID 4326 NOT NULL, SPATIAL INDEX sp (location))`
    );
  } else if (wantMysql) {
    process.stdout.write(`${MYSQL_SKIPPED}\n`);
  }
  return { pg, my, table };
}

export async function closeDatabases({ pg, my, table }) {
  if (my) {
    await my.query(`DROP TABLE IF EXISTS ${table}`);
    await my.end();
  }
  await pg.close();
}

// postgres-adapter.ts withinPolygon, with the point column for its point.
const POSTGIS_WITHIN =
  "SELECT id FROM pts WHERE ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, location)";
// mysql-adapter.ts withinPolygon.
const mysqlWithin = (table, hint) =>
  `SELECT id FROM ${table} ${hint} WHERE ST_Intersects(ST_GeomFromGeoJSON(?, 1, 4326), location)`;

/**
 * Which of `points` each database matches for the polygon GeoJSON `json`:
 * `{ pg, pgIndex, my, myIndex }`, each a Set of point indices, or a string
 * starting "ERR" when the database raised. `pgIndex`/`myIndex` force the
 * spatial index; `pg`/`my` force a table scan. MySQL keys are absent when it
 * is not configured.
 */
export async function answer(
  { pg, my, table },
  json,
  points,
  { index = true } = {}
) {
  const out = {};
  try {
    await pg.query("DELETE FROM pts");
    // postgres-adapter.ts geoPoint.value
    await pg.query(
      "INSERT INTO pts SELECT i::int - 1, ST_SetSRID(ST_MakePoint(x, y), 4326)::geography FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(x, y, i)",
      [points.map((p) => p.longitude), points.map((p) => p.latitude)]
    );
    await pg.exec(
      "SET enable_seqscan = on; SET enable_indexscan = off; SET enable_bitmapscan = off;"
    );
    out.pg = new Set(
      (await pg.query(POSTGIS_WITHIN, [json])).rows.map((row) => row.id)
    );
    if (index) {
      await pg.exec(
        "SET enable_seqscan = off; SET enable_indexscan = on; SET enable_bitmapscan = on;"
      );
      out.pgIndex = new Set(
        (await pg.query(POSTGIS_WITHIN, [json])).rows.map((row) => row.id)
      );
    }
  } catch (error) {
    out.pg = `ERR ${error.message.split("\n")[0]}`;
  }
  if (!my) return out;
  try {
    await my.query(`DELETE FROM ${table}`);
    // mysql-adapter.ts geoPoint.value
    const rows = points.map(
      () =>
        "(?, ST_GeomFromText(CONCAT('POINT(', ?, ' ', ?, ')'), 4326, 'axis-order=long-lat'))"
    );
    await my.query(
      `INSERT INTO ${table} VALUES ${rows.join(",")}`,
      points.flatMap((p, id) => [id, p.longitude, p.latitude])
    );
    const [scan] = await my.query(mysqlWithin(table, "IGNORE INDEX (sp)"), [
      json,
    ]);
    out.my = new Set(scan.map((row) => row.id));
    if (index) {
      const [indexed] = await my.query(mysqlWithin(table, "FORCE INDEX (sp)"), [
        json,
      ]);
      out.myIndex = new Set(indexed.map((row) => row.id));
    }
  } catch (error) {
    out.my = `ERR ${error.message.split("\n")[0]}`;
  }
  return out;
}

/** Fixed-width text table of an array of flat objects. */
export function table(rows) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const cells = rows.map((row) =>
    columns.map((column) => String(row[column] ?? ""))
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => line[index].length))
  );
  const line = (values) =>
    values.map((value, index) => value.padEnd(widths[index])).join("  ");
  return [
    line(columns),
    line(widths.map((width) => "-".repeat(width))),
    ...cells.map(line),
  ].join("\n");
}
