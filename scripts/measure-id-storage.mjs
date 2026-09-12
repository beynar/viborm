#!/usr/bin/env node

/**
 * What an identifier column costs a real database.
 *
 * The bundle measurement answers what the dependency swap costs a consumer's
 * JavaScript. This answers the other half: a text spelling of an identifier and
 * its compact storage, side by side, over the same rows, on the two engines
 * that have a native answer — PostgreSQL's `uuid` / `bytea` and MySQL's
 * `BINARY(n)`. Table size is not derivable from the column width: the row
 * header, the alignment, the page fill and (on InnoDB) the clustering all move
 * with it, and only the engine can say by how much.
 *
 * Every table below holds the SAME rows in both spellings — one identifier and
 * one 16-character payload column — so the difference between two rows of the
 * report is the storage and nothing else. Sizes are read after `VACUUM ANALYZE`
 * (PostgreSQL) and `ANALYZE TABLE` (MySQL), which is what makes them stable
 * rather than dependent on when autovacuum last ran.
 *
 * InnoDB clusters on the primary key, so an identifier that IS the primary key
 * has `INDEX_LENGTH` 0 and its whole cost is inside `DATA_LENGTH`. The `_sec`
 * tables carry the same identifier as a secondary `UNIQUE` index beside an
 * ordinary auto-increment key instead, which is where the index side of the
 * saving becomes visible.
 *
 * `insertMs` is a single wall time for the batched load of one table. It is a
 * DIRECTION, not a benchmark: one run, one laptop container, no warm-up and no
 * repetition. Sizes are deterministic at a given row count; insert times are
 * not, and `--repeat` exists to show how far they move.
 *
 * Both containers are the project's own (`docs/architecture/…` and
 * `tests/README.md` name them). Every table is dropped before and after; the
 * script creates no database and drops none.
 *
 * Usage:
 *   PG_TEST_CONNECTION_STRING=… MYSQL_TEST_CONNECTION_STRING=… \
 *     node scripts/measure-id-storage.mjs [--rows N] [--repeat N] \
 *       [--merge <measurement.json>] [--out <path>]
 *
 * With `--merge` the result is written into that file's `databaseStorage` key,
 * which is exactly how `native-ids-evidence/final.json` carries it —
 * `measure-bundle.mjs` knows nothing about this block and drops it on a rerun.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const DEFAULT_ROWS = 200_000;
const BATCH = 1000;
/** One fixed payload beside every identifier, so only the key differs. */
const PAYLOAD = "payload-0123456";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** One ULID's 16 bytes: 48 bits of ascending time, 80 bits of randomness. */
function ulidBytes(millis, random) {
  const bytes = new Uint8Array(16);
  let time = millis;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes.set(random, 6);
  return bytes;
}

/**
 * Crockford base32 of 16 bytes, as the 26 characters a ULID is written in.
 *
 * Done in `BigInt` rather than with shifts and masks: 128 bits into 26 symbols
 * is 130 bits, the two leading zero bits ride in the first symbol, and the
 * arithmetic form says that in one line each.
 */
function ulidText(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  const symbols = new Array(26);
  for (let index = 25; index >= 0; index -= 1) {
    symbols[index] = CROCKFORD[Number(value % 32n)];
    value /= 32n;
  }
  return symbols.join("");
}

/** `n` ULIDs, ascending in time the way a real table accumulates them. */
function ulids(count) {
  const base = Date.UTC(2025, 0, 1);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const random = new Uint8Array(10);
    for (let byte = 0; byte < 10; byte += 1) {
      random[byte] = Math.floor(Math.random() * 256);
    }
    const bytes = ulidBytes(base + index, random);
    rows.push({ bytes: Buffer.from(bytes), text: ulidText(bytes) });
  }
  return rows;
}

/** `n` random uuids — the shape that fragments a btree, which is the point. */
function uuids(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const text = randomUUID();
    rows.push({ text, bytes: Buffer.from(text.replaceAll("-", ""), "hex") });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const PG_TABLES = [
  { name: "sz_ulid_text", type: "text", source: "ulid", form: "text" },
  { name: "sz_ulid_bytea", type: "bytea", source: "ulid", form: "bytes" },
  { name: "sz_uuid_text", type: "text", source: "uuid", form: "text" },
  { name: "sz_uuid_native", type: "uuid", source: "uuid", form: "text" },
];

async function measurePostgres(url, rows, values) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const tables = {};
  try {
    for (const table of PG_TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${table.name}`);
      await client.query(
        `CREATE TABLE ${table.name} (id ${table.type} PRIMARY KEY, payload text NOT NULL)`
      );
      const source = values[table.source];
      const started = process.hrtime.bigint();
      for (let offset = 0; offset < rows; offset += BATCH) {
        const slice = source.slice(offset, offset + BATCH);
        const binds = [];
        const placeholders = slice.map((row, index) => {
          binds.push(table.form === "bytes" ? row.bytes : row.text, PAYLOAD);
          return `($${index * 2 + 1}, $${index * 2 + 2})`;
        });
        await client.query(
          `INSERT INTO ${table.name} (id, payload) VALUES ${placeholders.join(",")}`,
          binds
        );
      }
      const insertMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      await client.query(`VACUUM ANALYZE ${table.name}`);
      const size = await client.query(
        `SELECT pg_total_relation_size($1) AS total,
                pg_relation_size($1) AS heap,
                pg_indexes_size($1) AS indexes,
                (SELECT count(*) FROM ${table.name}) AS n`,
        [table.name]
      );
      const row = size.rows[0];
      tables[table.name] = {
        totalBytes: Number(row.total),
        heapBytes: Number(row.heap),
        indexBytes: Number(row.indexes),
        rows: Number(row.n),
        insertMs,
      };
      await client.query(`DROP TABLE ${table.name}`);
    }
  } finally {
    await client.end();
  }
  return {
    sizes:
      "pg_total_relation_size / pg_relation_size / pg_indexes_size, after VACUUM ANALYZE",
    tables,
  };
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const MYSQL_TABLES = [
  { name: "sz_ulid_text", type: "varchar(191)", source: "ulid", form: "text" },
  { name: "sz_ulid_binary", type: "binary(16)", source: "ulid", form: "bytes" },
  { name: "sz_uuid_text", type: "varchar(191)", source: "uuid", form: "text" },
  { name: "sz_uuid_binary", type: "binary(16)", source: "uuid", form: "bytes" },
];

async function measureMysql(url, rows, values) {
  const { default: mysql } = await import("mysql2/promise");
  const connection = await mysql.createConnection(url);
  const tables = {};
  try {
    for (const table of MYSQL_TABLES) {
      for (const secondary of [false, true]) {
        const name = secondary ? `${table.name}_sec` : table.name;
        await connection.query(`DROP TABLE IF EXISTS ${name}`);
        await connection.query(
          secondary
            ? `CREATE TABLE ${name} (rowId bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, id ${table.type} NOT NULL, payload varchar(64) NOT NULL, UNIQUE KEY ${name}_id (id))`
            : `CREATE TABLE ${name} (id ${table.type} NOT NULL PRIMARY KEY, payload varchar(64) NOT NULL)`
        );
        const source = values[table.source];
        const started = process.hrtime.bigint();
        for (let offset = 0; offset < rows; offset += BATCH) {
          const slice = source.slice(offset, offset + BATCH);
          const binds = [];
          for (const row of slice) {
            binds.push(table.form === "bytes" ? row.bytes : row.text, PAYLOAD);
          }
          const placeholders = slice.map(() => "(?,?)").join(",");
          await connection.query(
            `INSERT INTO ${name} (id, payload) VALUES ${placeholders}`,
            binds
          );
        }
        const insertMs = Number(
          (process.hrtime.bigint() - started) / 1_000_000n
        );
        await connection.query(`ANALYZE TABLE ${name}`);
        const [sizes] = await connection.query(
          `SELECT DATA_LENGTH AS dataLength, INDEX_LENGTH AS indexLength
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
          [name]
        );
        const [counted] = await connection.query(
          `SELECT COUNT(*) AS n FROM ${name}`
        );
        const dataLength = Number(sizes[0].dataLength);
        const indexLength = Number(sizes[0].indexLength);
        tables[name] = {
          dataLength,
          indexLength,
          totalBytes: dataLength + indexLength,
          rows: Number(counted[0].n),
          insertMs,
        };
        await connection.query(`DROP TABLE ${name}`);
      }
    }
  } finally {
    await connection.end();
  }
  return {
    sizes:
      "information_schema.TABLES DATA_LENGTH / INDEX_LENGTH, after ANALYZE TABLE; InnoDB clusters on the primary key, so a primary-key identifier has INDEX_LENGTH 0 and the `_sec` tables carry the same identifier as a secondary UNIQUE index instead",
    tables,
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const NUMERIC_FLAGS = new Set(["--rows", "--repeat"]);
const PATH_FLAGS = new Map([
  ["--merge", "merge"],
  ["--out", "out"],
]);

function parseArguments(argv) {
  const options = { rows: DEFAULT_ROWS, repeat: 1 };
  let pending;
  for (const argument of argv) {
    if (pending === undefined) {
      if (NUMERIC_FLAGS.has(argument) || PATH_FLAGS.has(argument)) {
        pending = argument;
        continue;
      }
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (pending === "--rows") options.rows = Number(argument);
    else if (pending === "--repeat") options.repeat = Number(argument);
    else options[PATH_FLAGS.get(pending)] = argument;
    pending = undefined;
  }
  if (pending !== undefined) {
    throw new Error(`Missing value for ${pending}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const pgUrl = process.env.PG_TEST_CONNECTION_STRING;
  const mysqlUrl = process.env.MYSQL_TEST_CONNECTION_STRING;
  if (!(pgUrl && mysqlUrl)) {
    throw new Error(
      "Both PG_TEST_CONNECTION_STRING and MYSQL_TEST_CONNECTION_STRING are required."
    );
  }
  const runs = [];
  for (let run = 0; run < options.repeat; run += 1) {
    const values = { ulid: ulids(options.rows), uuid: uuids(options.rows) };
    runs.push({
      postgres: await measurePostgres(pgUrl, options.rows, values),
      mysql: await measureMysql(mysqlUrl, options.rows, values),
    });
  }
  const block = {
    note: "Produced by `node scripts/measure-id-storage.mjs`; `measure-bundle.mjs` knows nothing about this key and drops it on a rerun. `runs` is always a list: every run is a full load of fresh values into fresh tables, so a size that moves between runs is a size no single run may be quoted for. `insertMs` is one wall time per table and is a direction, not a benchmark.",
    rows: options.rows,
    commands: [
      `PG_TEST_CONNECTION_STRING=… MYSQL_TEST_CONNECTION_STRING=… node scripts/measure-id-storage.mjs --rows ${options.rows} --repeat ${options.repeat}`,
    ],
    runs,
  };
  const text = `${JSON.stringify(block, null, 1)}\n`;
  if (options.merge) {
    const document = JSON.parse(readFileSync(options.merge, "utf8"));
    document.databaseStorage = block;
    writeFileSync(options.merge, `${JSON.stringify(document, null, 1)}\n`);
    process.stdout.write(`merged into ${options.merge}\n`);
    return;
  }
  if (options.out) {
    writeFileSync(options.out, text);
    process.stdout.write(`wrote ${options.out}\n`);
    return;
  }
  process.stdout.write(text);
}

await main();
