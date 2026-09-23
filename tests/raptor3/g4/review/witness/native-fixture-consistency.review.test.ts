/**
 * Review probe. Claim under attack: `tests/raptor3/g4/native/read-envelope-native.test.ts`
 * is registered as `g4-read-envelope-pg-contracts` / `-mysql-contracts` with 4
 * expected cells and reported as BLOCKED (never executed) purely because no
 * provider answers.
 *
 * The file cannot be imported here (`tests/raptor3/transitions/live-world.ts`
 * asserts a live provider and port at module load), so the probe reads its
 * source and then reproduces the fixture's own CREATE TABLE / INSERT contract
 * on SQLite, which enforces NOT NULL identically to PostgreSQL and to MySQL in
 * strict mode. If the reproduction is rejected, the suite would fail at seeding
 * on any provider, so "blocked" understates its state.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const SOURCE = "tests/raptor3/g4/native/read-envelope-native.test.ts";

describe("review probe: the native read-envelope fixture", () => {
  it("declares payload_value NOT NULL and seeds it NULL in every row", () => {
    const source = readFileSync(SOURCE, "utf8");
    assert.match(
      source,
      /quote\("payload_value"\)\}\s*\$\{blobType\}\s*NOT NULL/,
      "payload_value is no longer declared NOT NULL"
    );
    const nulls = source.match(/payload_value:\s*null/g) ?? [];
    assert.equal(
      nulls.length,
      3,
      "the seeded rows no longer supply a NULL payload_value"
    );
  });

  it("is rejected by a database that enforces the declaration", () => {
    const database = new Database(":memory:");
    database.exec(
      `CREATE TABLE g4_native_specimens (
         id INTEGER NOT NULL,
         label_value TEXT NOT NULL,
         count_value INTEGER,
         big_value BIGINT NOT NULL,
         amount_value DECIMAL(12,3) NOT NULL,
         moment_value TEXT NOT NULL,
         status_value TEXT NOT NULL,
         document_value TEXT,
         payload_value BLOB NOT NULL,
         PRIMARY KEY(id)
       )`
    );
    // The live harness inserts every key present on the fixture row, so the
    // NULL is sent explicitly (tests/raptor3/transitions/live-world.ts:404-414).
    const insert = database.prepare(
      `INSERT INTO g4_native_specimens
        (id,label_value,count_value,big_value,amount_value,moment_value,status_value,document_value,payload_value)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    assert.throws(
      () =>
        insert.run(
          1,
          "Alpha",
          10,
          "9007199254740993",
          "123456.001",
          "2024-01-15T10:30:00.123Z",
          "ACTIVE",
          null,
          null
        ),
      /NOT NULL constraint failed: g4_native_specimens\.payload_value/
    );
    database.close();
  });

  it("never projects a blob, JSON, date, time, point, vector or list value", () => {
    const source = readFileSync(SOURCE, "utf8");
    // The three specimen reads select only these five fields.
    for (const projected of ["id: true", "big: true", "amount: true", "moment: true", "status: true"])
      assert.ok(source.includes(projected), projected);
    for (const absent of ["payload: true", "document: true"])
      assert.equal(
        source.includes(absent),
        false,
        `${absent} is projected after all — the coverage claim would then hold`
      );
    // ...and the file's own header claims the spatial tiers it does not test.
    assert.ok(source.includes("plus the spatial tiers (SC-13, SC-14, Q-O02)"));
    assert.equal(
      /s\.point\(\)|s\.vector\(\)/.test(source),
      false,
      "a spatial column appeared — the header would then be accurate"
    );
  });
});
