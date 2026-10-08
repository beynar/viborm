import { Buffer as NodeBuffer } from "node:buffer";
import { createClient } from "@client/client";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { afterEach, describe, expect, test, vi } from "vitest";

type D1Database = ConstructorParameters<typeof D1Driver>[0]["database"];
type BunOptions = NonNullable<ConstructorParameters<typeof BunSQLiteDriver>[0]>;
type BunClient = NonNullable<BunOptions["client"]>;
type SQLite3Options = NonNullable<
  ConstructorParameters<typeof SQLite3Driver>[0]
>;
type SQLite3Client = NonNullable<SQLite3Options["client"]>;

const D1_ROW_STATEMENT_REGEX = /\b(?:INSERT|UPDATE|SELECT)\b/i;
const D1_MUTATION_STATEMENT_REGEX = /\b(?:INSERT|UPDATE)\b/i;

function binaryBytes(value: unknown): number[] | undefined {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    );
  }
  return undefined;
}

function createD1BinaryFixture() {
  const bindings: unknown[][] = [];
  let storedPayload: number[] = [];

  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...params: unknown[]) {
          values = params;
          bindings.push(params);
          return statement;
        },
        async run() {
          const payload = values.map(binaryBytes).find(Boolean);
          if (payload) {
            storedPayload = payload;
          }
          const returnsRow = D1_ROW_STATEMENT_REGEX.test(sql);
          return {
            success: true,
            results: returnsRow
              ? [{ id: "blob-1", payload: [...storedPayload] }]
              : [],
            meta: {
              changes: D1_MUTATION_STATEMENT_REGEX.test(sql) ? 1 : 0,
              last_row_id: 0,
            },
          };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };

  return {
    bindings,
    database: database as unknown as D1Database,
  };
}

function createBunBinaryFixture() {
  const bindings: unknown[][] = [];
  const statement = {
    columnNames: [],
    all: vi.fn(() => []),
    get: vi.fn(() => null),
    run: vi.fn((...values: unknown[]) => {
      bindings.push(values);
      return { changes: 1, lastInsertRowid: 1 };
    }),
    // Real bun:sqlite statements carry this; see sqlite-integer-safety.test.ts
    safeIntegers: vi.fn(() => statement),
    values: vi.fn(() => []),
  };
  const database = {
    query: vi.fn((sql: string) =>
      sql === "PRAGMA foreign_keys"
        ? { get: () => ({ foreign_keys: 1 }) }
        : statement
    ),
    prepare: vi.fn(() => statement),
    run: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction:
      <T>(fn: () => T) =>
      () =>
        fn(),
  };
  return {
    bindings,
    driver: new BunSQLiteDriver({
      client: database as unknown as BunClient,
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("D1 Worker binary values", () => {
  test("creates, updates, reads, and batches exact bytes without Buffer", async () => {
    const blob = s.model({
      id: s.string().id(),
      payload: s.blob(),
    });
    const fixture = createD1BinaryFixture();
    const driver = new D1Driver({ database: fixture.database });
    const client = createClient({ schema: { blob }, driver });
    const backing = new Uint8Array([99, 0, 255, 128, 77]);
    const nonUtf8Subview = backing.subarray(1, 4);

    vi.stubGlobal("Buffer", undefined);
    try {
      const created = await client.blob.create({
        data: { id: "blob-1", payload: nonUtf8Subview },
      });
      const emptied = await client.blob.update({
        where: { id: "blob-1" },
        data: { payload: new Uint8Array() },
      });
      const read = await client.blob.findUnique({ where: { id: "blob-1" } });

      await driver._executeBatch([
        {
          sql: "INSERT INTO blobs (payload) VALUES (?)",
          params: [new Uint8Array([1, 2, 3])],
        },
        {
          sql: "UPDATE blobs SET payload = ?",
          params: [nonUtf8Subview],
        },
      ]);

      expect(Array.from(created.payload)).toEqual([0, 255, 128]);
      expect(Array.from(emptied.payload)).toEqual([]);
      expect(Array.from(read?.payload ?? [])).toEqual([]);

      const boundBytes = fixture.bindings
        .flat()
        .map(binaryBytes)
        .filter((bytes) => bytes !== undefined);
      expect(boundBytes).toEqual([[0, 255, 128], [], [1, 2, 3], [0, 255, 128]]);

      const boundBinary = fixture.bindings
        .flat()
        .filter((value) => binaryBytes(value) !== undefined);
      expect(
        boundBinary.every(
          (value) =>
            value instanceof ArrayBuffer ||
            (value instanceof Uint8Array &&
              Object.getPrototypeOf(value) === Uint8Array.prototype)
        )
      ).toBe(true);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("local SQLite binary values", () => {
  test("SQLite3 converts binary values to Buffer locally without a global Buffer", async () => {
    const bindings: unknown[][] = [];
    const statement = {
      reader: false,
      run: (...values: unknown[]) => {
        bindings.push(values);
        return { changes: 1 };
      },
    };
    const database = {
      prepare: () => statement,
      exec: vi.fn(),
      close: vi.fn(),
    };
    const driver = new SQLite3Driver({
      client: database as unknown as SQLite3Client,
    });
    const backing = new Uint8Array([91, 0, 255, 128, 92]);
    const buffer = NodeBuffer.from([0, 255, 128]);
    const view = new DataView(backing.buffer, 1, 3);
    const parameters: unknown[] = [true, false, undefined, null, buffer, view];
    const statementSql = "INSERT INTO blobs VALUES (?, ?, ?, ?, ?, ?)";
    const batchQueries = [{ sql: statementSql, params: parameters }];
    Object.freeze(parameters);
    Object.freeze(batchQueries);
    vi.stubGlobal("Buffer", undefined);

    try {
      await driver._executeRaw("INSERT INTO blobs VALUES (?)", [
        new ArrayBuffer(0),
      ]);
      await driver._executeRaw("INSERT INTO blobs VALUES (?)", [
        backing.subarray(1, 4),
      ]);
      await driver._executeRaw(statementSql, parameters);
      await driver._executeBatch(batchQueries);

      expect(
        bindings.slice(0, 2).map(([value]) => NodeBuffer.isBuffer(value))
      ).toEqual([true, true]);
      expect(bindings.slice(0, 2).map(([value]) => binaryBytes(value))).toEqual(
        [[], [0, 255, 128]]
      );
      expect(bindings).toHaveLength(4);
      for (const values of bindings.slice(2)) {
        expect(values.slice(0, 4)).toEqual([1, 0, null, null]);
        expect(values[4]).toBe(buffer);
        expect(NodeBuffer.isBuffer(values[5])).toBe(true);
        expect(binaryBytes(values[5])).toEqual([0, 255, 128]);
      }
      expect(parameters).toEqual([true, false, undefined, null, buffer, view]);
    } finally {
      await driver.disconnect();
    }
  });

  test("Bun SQLite receives Uint8Array for ArrayBuffer and exact subviews", async () => {
    const fixture = createBunBinaryFixture();
    const backing = new Uint8Array([88, 0, 255, 128, 87]);
    const bytes = backing.subarray(1, 4);
    const view = new DataView(backing.buffer, 1, 3);
    const parameters: unknown[] = [true, false, undefined, null, bytes, view];
    const statementSql = "INSERT INTO blobs VALUES (?, ?, ?, ?, ?, ?)";
    const batchQueries = [{ sql: statementSql, params: parameters }];
    Object.freeze(parameters);
    Object.freeze(batchQueries);
    vi.stubGlobal("Buffer", undefined);

    try {
      await fixture.driver._executeRaw("INSERT INTO blobs VALUES (?)", [
        new ArrayBuffer(0),
      ]);
      await fixture.driver._executeRaw("INSERT INTO blobs VALUES (?)", [
        new DataView(backing.buffer, 1, 3),
      ]);
      await fixture.driver._executeRaw(statementSql, parameters);
      await fixture.driver._executeBatch(batchQueries);

      expect(
        fixture.bindings.slice(0, 2).map(([value]) => binaryBytes(value))
      ).toEqual([[], [0, 255, 128]]);
      expect(
        fixture.bindings
          .slice(0, 2)
          .every(([value]) => value instanceof Uint8Array)
      ).toBe(true);
      expect(fixture.bindings).toHaveLength(4);
      for (const values of fixture.bindings.slice(2)) {
        expect(values.slice(0, 4)).toEqual([1, 0, null, null]);
        expect(values[4]).toBe(bytes);
        expect(values[5]).toBeInstanceOf(Uint8Array);
        expect(binaryBytes(values[5])).toEqual([0, 255, 128]);
      }
      expect(parameters).toEqual([true, false, undefined, null, bytes, view]);
    } finally {
      await fixture.driver.disconnect();
    }
  });
});
