import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { BunSQLDriver } from "@drivers/bun-sql";
import { sql } from "@sql";
import { JsonParameter } from "@src/sql/json-parameter";
import { expect, test, vi } from "vitest";

/**
 * The JSON parameter carrier (`src/sql/json-parameter.ts`).
 *
 * PostgreSQL binds JSON as canonical text and lets the server cast it from the
 * parameter's column context. Nothing downstream can tell that text from an
 * ordinary string, so Bun SQL — which JSON-encodes a string bound to a
 * `json`/`jsonb` parameter — stored `"[1,2,3]"` where `[1,2,3]` was meant
 * (upstream Drizzle #5287). The carrier is the distinction, and it needs no
 * per-transport hook: it renders as its canonical text under the only two
 * protocols a PostgreSQL transport can reach a bound value through.
 *
 * Physical evidence per provider lives in the probes:
 * `.audit-probes/p1/bun-sql-json.ts` (Bun) and
 * `.audit-probes/p1/pglite-json-unchanged.ts` (PGlite, byte-for-byte
 * unchanged).
 */

const JSON_VALUES: [string, unknown][] = [
  ["object", { nested: { value: 123 }, 'a"b': "c\\d" }],
  ["array", [1, 2, 3]],
  ["string primitive", "plain json string primitive"],
  ["number primitive", 42],
  ["boolean primitive", true],
  ["json null", null],
  ["empty object", {}],
  ["empty array", []],
];

function bunResult() {
  return Object.assign([], { count: 0 });
}

type BunSQLClient = NonNullable<
  NonNullable<ConstructorParameters<typeof BunSQLDriver>[0]>["client"]
>;

function bunClient(
  array: BunSQLClient["array"],
  unsafe: BunSQLClient["unsafe"]
): BunSQLClient {
  const tagged = async (
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<unknown[]> => [];
  return Object.assign(tagged, {
    array,
    unsafe,
    begin: () => {
      throw new Error("not used");
    },
    close: () => Promise.resolve(),
    reserve: () => {
      throw new Error("not used");
    },
  });
}

for (const [label, value] of JSON_VALUES) {
  test(`a ${label} carrier renders as canonical JSON text under both binding protocols`, () => {
    const carrier = JsonParameter.from(value);
    const canonical = JSON.stringify(value);

    // String coercion — what postgres.js binds an unknown-typed parameter with.
    expect(String(carrier)).toBe(canonical);
    // JSON serialization — what node-postgres, Neon, PGlite, the postgres.js
    // `json` type override and Bun's object encoder all reach it through.
    expect(JSON.stringify(carrier)).toBe(canonical);
    // What an opted-in `includeParams` snapshot shows, since diagnostics read
    // own properties and would otherwise report `{}`.
    expect(carrier?.json).toBe(canonical);
  });
}

test("both PostgreSQL JSON sites bind the carrier, and nothing else does", () => {
  const postgres = new PostgresAdapter();
  const value = { nested: { value: 123 } };

  const written = postgres.literals.json(value);
  const compared = postgres.json.value(value);

  expect(written.values).toHaveLength(1);
  expect(written.values[0]).toBeInstanceOf(JsonParameter);
  expect(compared.values[0]).toBeInstanceOf(JsonParameter);
  // The statement text is untouched: the carrier changes the bound value, not
  // the placeholder or any cast around it.
  expect(written.toStatement("$n")).toBe("$1");
  expect(compared.toStatement("$n")).toBe("$1");

  // MySQL and SQLite already bind through their own dialect spellings and see
  // no carrier — the defect and its fix are PostgreSQL-local.
  for (const adapter of [new MySQLAdapter(), new SQLiteAdapter()]) {
    expect(adapter.literals.json(value).values[0]).toBe(JSON.stringify(value));
    expect(adapter.json.value(value).values[0]).toBe(JSON.stringify(value));
  }
});

test("a value JSON.stringify cannot represent still binds undefined", () => {
  const postgres = new PostgresAdapter();

  // `JSON.stringify` answers `undefined` rather than text for these, which
  // providers send as SQL NULL. Carrying them would bind the text "undefined".
  expect(JsonParameter.from(undefined)).toBeUndefined();
  expect(JsonParameter.from(() => "x")).toBeUndefined();
  expect(postgres.literals.json(undefined).values).toEqual([undefined]);
});

test("the driver seam hands the carrier to the provider verbatim", async () => {
  const array = vi.fn(() => ({ serializedValues: "unused" }));
  const unsafe = vi.fn(async () => bunResult());
  const driver = new BunSQLDriver({ client: bunClient(array, unsafe) });
  const carrier = driver.adapter.literals.json([1, 2, 3]).values[0];

  await driver._execute(sql`INSERT INTO t (data) VALUES (${carrier})`);

  // Bun receives the carrier itself: its object encoder is the one that gets
  // the document right for every JSON type, including the number, boolean and
  // null primitives no bare JavaScript value can express to it.
  expect(unsafe).toHaveBeenCalledWith("INSERT INTO t (data) VALUES ($1)", [
    carrier,
  ]);
  // A carrier is not a list, so Bun's ORM list encoding never sees it.
  expect(array).not.toHaveBeenCalled();

  // The prepared-statement seam carries it identically, so a batched write and
  // a single write bind the same value.
  expect(
    driver._prepare(sql`INSERT INTO t (data) VALUES (${carrier})`).params
  ).toEqual([carrier]);
});

test("a safe tagged raw fragment binds no carrier", async () => {
  const unsafe = vi.fn(async () => bunResult());
  const driver = new BunSQLDriver({
    client: bunClient(vi.fn(), unsafe),
  });
  const document = { nested: { value: 123 } };

  await driver._execute(sql`SELECT ${document}`, {
    model: "$raw",
    operation: "$queryRaw",
  });

  // Raw interpolations never pass through `literals.json`: the caller owns the
  // physical representation and keeps the provider's own semantics.
  expect(unsafe).toHaveBeenCalledWith("SELECT $1", [document]);
});
