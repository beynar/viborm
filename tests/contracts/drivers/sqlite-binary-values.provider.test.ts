import { LibSQLDriver } from "@drivers/libsql";
import { SQLite3Driver } from "@drivers/sqlite3";
import { describe, expect, test } from "vitest";

describe("local SQLite provider binary values", () => {
  test("SQLite3 round-trips empty and non-UTF-8 blobs", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const backing = new Uint8Array([91, 0, 255, 128, 92]);

    try {
      await driver._executeRaw(
        "CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)"
      );
      await driver._executeRaw("INSERT INTO blobs VALUES (?, ?)", [
        1,
        new ArrayBuffer(0),
      ]);
      await driver._executeRaw("INSERT INTO blobs VALUES (?, ?)", [
        2,
        backing.subarray(1, 4),
      ]);
      const result = await driver._executeRaw<{ payload: Uint8Array }>(
        "SELECT payload FROM blobs ORDER BY id"
      );

      expect(result.rows.map((row) => Array.from(row.payload))).toEqual([
        [],
        [0, 255, 128],
      ]);
    } finally {
      await driver.disconnect();
    }
  });

  test("libSQL round-trips ArrayBuffer and exact typed-array subviews", async () => {
    const driver = new LibSQLDriver({ dataDir: ":memory:" });
    const backing = new Uint8Array([90, 0, 255, 128, 89]);

    try {
      await driver._executeRaw(
        "CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)"
      );
      await driver._executeRaw("INSERT INTO blobs VALUES (?, ?)", [
        1,
        new ArrayBuffer(0),
      ]);
      await driver._executeRaw("INSERT INTO blobs VALUES (?, ?)", [
        2,
        new DataView(backing.buffer, 1, 3),
      ]);
      const result = await driver._executeRaw<{ payload: ArrayBuffer }>(
        "SELECT payload FROM blobs ORDER BY id"
      );

      expect(
        result.rows.map((row) => Array.from(new Uint8Array(row.payload)))
      ).toEqual([[], [0, 255, 128]]);
    } finally {
      await driver.disconnect();
    }
  });
});
