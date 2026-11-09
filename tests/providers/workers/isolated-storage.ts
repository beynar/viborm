/**
 * The D1 storage frames the Workers pool's `isolatedStorage` kept until it was
 * removed (`@cloudflare/vitest-pool-workers` 0.13, the Vitest 4 pool).
 *
 * The pool now isolates storage per test FILE. These suites were written for
 * its old stack instead: a test's writes, its `beforeEach` hooks' included,
 * were undone after it, and a `describe` block's `beforeAll` writes after the
 * block — while a file's own `beforeAll` schema stayed for every test. This
 * setup file restores that stack on the one binding the suites write, `DB`:
 * every test, and every nested `describe`, opens a frame by capturing the
 * database and closes it by putting the capture back.
 *
 * A capture is the user schema (`sqlite_master`, creation order) and each
 * table's rows as SQLite `quote()` literals, so integers past 2^53, reals,
 * text and blobs return byte for byte, with the AUTOINCREMENT counters.
 * Rowids a table does not name as a column are not kept. Anything else a test
 * could leave — a virtual table — fails the frame by name rather than being
 * restored partially.
 */
import { env, reset } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { RunnerTestSuite } from "vitest";
import { beforeEach, TestRunner } from "vitest";

interface SchemaObject {
  readonly type: "table" | "index" | "view" | "trigger";
  readonly name: string;
  readonly sql: string;
}

interface Capture {
  readonly objects: readonly SchemaObject[];
  /** One `INSERT` per row, its values written as literals. */
  readonly rows: readonly string[];
  readonly sequences: readonly { name: string; seq: number }[];
}

const VIRTUAL_TABLE = /^\s*CREATE\s+VIRTUAL/i;

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function hasSequenceTable(db: D1Database): Promise<boolean> {
  const { results } = await db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
    )
    .all();
  return results.length > 0;
}

async function userObjects(db: D1Database): Promise<SchemaObject[]> {
  const { results } = await db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT GLOB '_cf_*'
       ORDER BY rowid`
    )
    .all<SchemaObject>();
  for (const object of results) {
    if (object.type === "table" && VIRTUAL_TABLE.test(object.sql)) {
      throw new Error(
        `isolated-storage cannot capture the virtual table ${object.name}.`
      );
    }
  }
  return results;
}

async function capture(db: D1Database): Promise<Capture> {
  const objects = await userObjects(db);
  const rows: string[] = [];
  for (const { type, name } of objects) {
    if (type !== "table") continue;
    const { results: columns } = await db
      .prepare(
        "SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid"
      )
      .bind(name)
      .all<{ name: string }>();
    if (columns.length === 0) continue;
    const names = columns.map((column) => quoteIdentifier(column.name));
    const literals = names
      .map((column) => `quote(${column})`)
      .join(" || ',' || ");
    const { results } = await db
      .prepare(`SELECT ${literals} AS v FROM ${quoteIdentifier(name)}`)
      .all<{ v: string }>();
    for (const { v } of results) {
      rows.push(
        `INSERT INTO ${quoteIdentifier(name)} (${names.join(", ")}) VALUES (${v})`
      );
    }
  }
  const sequences = (await hasSequenceTable(db))
    ? (
        await db
          .prepare("SELECT name, seq FROM sqlite_sequence")
          .all<{ name: string; seq: number }>()
      ).results
    : [];
  return { objects, rows, sequences };
}

async function restore(db: D1Database, frame: Capture): Promise<void> {
  // Below SQL: D1 cannot switch foreign keys off, and a DELETE or DROP of a
  // table whose parent is missing — a state a test may legitimately leave —
  // fails to prepare. `reset()` clears every binding's storage instead.
  await reset();
  const create = (type: SchemaObject["type"]) =>
    frame.objects
      .filter((object) => object.type === type)
      .map(({ sql }) => sql);
  const statements = [
    // The frame is consistent; only its intermediate states are not.
    "PRAGMA defer_foreign_keys = ON",
    ...create("table"),
    ...frame.rows,
    // The rows above advanced each counter to their largest key; a counter
    // past it (rows deleted since) is put back as it was.
    ...frame.sequences.flatMap(({ name, seq }) => [
      `DELETE FROM sqlite_sequence WHERE name = ${quoteLiteral(name)}`,
      `INSERT INTO sqlite_sequence (name, seq) VALUES (${quoteLiteral(name)}, ${seq})`,
    ]),
    ...create("index"),
    ...create("view"),
    ...create("trigger"),
  ];
  if (statements.length === 1) return;
  await db.batch(statements.map((sql) => db.prepare(sql)));
}

const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function openFrame(): Promise<() => Promise<void>> {
  const frame = await capture(env.DB);
  return () => restore(env.DB, frame);
}

/** Opens a frame around every nested `describe`, outside its own hooks. */
function frameSuites(suite: RunnerTestSuite): void {
  for (const task of suite.tasks) {
    if (task.type !== "suite") continue;
    TestRunner.getSuiteHooks(task).beforeAll.unshift(openFrame);
    frameSuites(task);
  }
}

// The file's hooks were all collected before its first `beforeAll` runs. A
// hook registered on the collector itself is handed that file.
TestRunner.getCurrentSuite().on("beforeAll", (file) => {
  frameSuites(file);
});

// Registered before the file's own hooks: it runs first, and its cleanup last.
beforeEach(openFrame);
