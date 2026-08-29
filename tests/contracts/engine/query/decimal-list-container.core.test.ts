/**
 * The PHYSICAL decimal-list container, read at the result boundary.
 *
 * A decimal list has two physical spellings and they are not distinguishable by
 * inspection, exactly like the scalar's two: on PostgreSQL the column is a
 * native `NUMERIC(p,s)[]` whose members arrive as exact decimal TEXT, and on
 * every JSON-backed provider the column holds a JSON array of unscaled
 * COEFFICIENT strings (plan 6.1). At scale 2 the member `"120"` is logical 120
 * in the first vocabulary and logical 1.2 in the second, so the vocabulary is
 * declared by the adapter and never guessed from the value.
 *
 * MySQL is the reason the list fact is its own declaration rather than the
 * scalar's: its scalar columns are `DECIMAL(p,s)` and answer with decimal text,
 * while its list columns are JSON — which cannot hold an exact decimal at all —
 * and answer with coefficient strings. One adapter, two vocabularies.
 *
 * Driver-free on purpose: every row below is a physical container handed to the
 * parser directly, which is the only way to write down the containers no
 * correct provider ever sends.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { QueryEngineError } from "@errors";
import { compileCacheResultCodec } from "@query-engine/result/cache-result-codec";
import { parseResult } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import { s } from "@schema";
import {
  indexFor,
  parserFor,
  prepareSchema,
} from "@tests/fixtures/query-scope";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

const MONEY = { precision: 16, scale: 2 } as const;

const basket = s
  .model({
    id: s.string().id(),
    amounts: s.decimal(MONEY).array(),
    optionalAmounts: s.decimal(MONEY).array().nullable(),
  })
  .map("decimal_list_container_baskets");

const schema = { basket };
prepareSchema(schema);

const READ_ARGS = {
  select: { id: true, amounts: true, optionalAmounts: true },
} as const;

/** One read parsed exactly as production parses it. */
function read(
  adapter: DatabaseAdapter,
  row: Record<string, unknown>
): Record<string, unknown> {
  const rows = parseResult<Record<string, unknown>[]>(
    parserFor(adapter, basket),
    "findMany",
    [{ id: "b-1", optionalAmounts: null, ...row }],
    READ_ARGS
  );
  const [parsed] = rows;
  if (!parsed) throw new Error("expected one parsed row");
  return parsed;
}

/** The canonical text of every member of a parsed list. */
function members(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected a list, received ${typeof value}`);
  }
  return value.map((member) => {
    if (!(member instanceof Decimal)) {
      throw new Error(`expected a Decimal member, received ${typeof member}`);
    }
    // Through the codec, so a member that is a Decimal but not an exact one is
    // a failure rather than a rendering.
    const canonical = canonicalizeDecimal(member);
    if (canonical === undefined) {
      throw new Error("a materialized member is not an exact decimal");
    }
    return canonical;
  });
}

/** The first row of a materialized read, named rather than asserted away. */
function firstRowOf(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error("expected a row array");
  const [row] = value;
  if (typeof row !== "object" || row === null) {
    throw new Error("expected a result row");
  }
  return row;
}

function refusalOf(
  adapter: DatabaseAdapter,
  row: Record<string, unknown>
): string {
  try {
    read(adapter, row);
  } catch (error) {
    if (error instanceof QueryEngineError) return error.message;
    throw error;
  }
  throw new Error(`expected a refusal for ${JSON.stringify(row)}`);
}

const LIST_DOMAIN_REFUSAL = /exact decimal/i;
const REQUIRED_LIST_REFUSAL = /list/i;

/**
 * The member past 2^53, spelled as the JSON NUMBER a container must never hold.
 * Built from its text rather than written as a literal: the literal is already
 * the rounded neighbour, which is the loss this case exists to catch.
 */
const ROUNDED_NUMBER_MEMBER = Number("90071992547409.93");

describe("the declared list vocabulary", () => {
  test("the shipped adapters declare which spelling their list columns hold", () => {
    // The scalar and the list are DIFFERENT declarations, and MySQL is where
    // they differ: `DECIMAL(p,s)` answers with text, its JSON list answers with
    // coefficients. Reading one from the other would decode every MySQL list
    // member at the wrong scale.
    const shipped: DatabaseAdapter[] = [
      new PostgresAdapter(),
      new MySQLAdapter(),
      new SQLiteAdapter(),
    ];

    expect(
      shipped.map((adapter) => adapter.result.decimalRepresentation)
    ).toEqual([undefined, undefined, "coefficient"]);
    expect(
      shipped.map((adapter) => adapter.result.decimalListRepresentation)
    ).toEqual([undefined, "coefficient", "coefficient"]);
  });
});

describe("a native array of exact decimal text", () => {
  const pg = new PostgresAdapter();

  test("every member materializes as a fresh Decimal at the field's scale", () => {
    const row = read(pg, { amounts: ["1.20", "-0.03", "90071992547409.93"] });

    expect(members(row.amounts)).toEqual(["1.2", "-0.03", "90071992547409.93"]);
    const [first] = row.amounts as Decimal[];
    const again = read(pg, { amounts: ["1.20"] }).amounts as Decimal[];
    expect(first).not.toBe(again[0]);
  });

  test("order and multiplicity survive verbatim", () => {
    expect(
      members(read(pg, { amounts: ["1.2", "1.2", "-0.03"] }).amounts)
    ).toEqual(["1.2", "1.2", "-0.03"]);
  });

  test("an empty list stays empty and a nullable list stays null", () => {
    const row = read(pg, { amounts: [], optionalAmounts: null });
    expect(row.amounts).toEqual([]);
    expect(row.optionalAmounts).toBeNull();
  });

  test("a JSON NUMBER member is refused rather than rounded", () => {
    // The hazard §6.1 names: 90071992547409.93 is past 2^53 and a JSON numeric
    // token would already have been rounded by the time it reached here.
    expect(refusalOf(pg, { amounts: [ROUNDED_NUMBER_MEMBER] })).toMatch(
      LIST_DOMAIN_REFUSAL
    );
  });

  test("a coefficient spelling is refused in the text vocabulary", () => {
    // "120" is a legal decimal TEXT, so this one is NOT caught by the grammar:
    // it is caught by the vocabulary, which is why the vocabulary is declared.
    expect(members(read(pg, { amounts: ["120"] }).amounts)).toEqual(["120"]);
  });

  for (const spelling of ["+1.2", "01.2", "1.", ".5", "1e3", "1,2"]) {
    test(`the off-grammar member '${spelling}' is refused`, () => {
      expect(refusalOf(pg, { amounts: [spelling] })).toMatch(
        LIST_DOMAIN_REFUSAL
      );
    });
  }

  test("a member outside the column's declared domain is refused", () => {
    expect(refusalOf(pg, { amounts: ["1.234"] })).toMatch(LIST_DOMAIN_REFUSAL);
    expect(refusalOf(pg, { amounts: ["99999999999999999"] })).toMatch(
      LIST_DOMAIN_REFUSAL
    );
  });

  test("a NULL member is refused: elements are never nullable", () => {
    expect(refusalOf(pg, { amounts: ["1.2", null] })).toMatch(
      LIST_DOMAIN_REFUSAL
    );
  });

  test("a required list that arrives null is refused", () => {
    expect(refusalOf(pg, { amounts: null })).toMatch(REQUIRED_LIST_REFUSAL);
  });
});

describe("a JSON container of unscaled coefficients", () => {
  const sqlite = new SQLiteAdapter();

  test("every member is rescaled from its coefficient", () => {
    const row = read(sqlite, {
      amounts: '["120","-3","9007199254740993"]',
    });

    expect(members(row.amounts)).toEqual(["1.2", "-0.03", "90071992547409.93"]);
  });

  test("a coefficient past 2^53 survives, because it never becomes a number", () => {
    const row = read(sqlite, { amounts: '["9007199254740993"]' });
    expect(members(row.amounts)).toEqual(["90071992547409.93"]);
    // The neighbouring coefficient is a DIFFERENT value, and both land on the
    // same IEEE-754 double: a container read through JSON numbers collapses
    // them into one answer.
    expect(
      members(read(sqlite, { amounts: '["9007199254740992"]' }).amounts)
    ).toEqual(["90071992547409.92"]);
  });

  test("order and multiplicity survive verbatim", () => {
    expect(
      members(read(sqlite, { amounts: '["120","120","-3"]' }).amounts)
    ).toEqual(["1.2", "1.2", "-0.03"]);
  });

  test("an empty container stays empty", () => {
    expect(read(sqlite, { amounts: "[]" }).amounts).toEqual([]);
  });

  test("MySQL reads the same container as SQLite", () => {
    expect(
      members(read(new MySQLAdapter(), { amounts: '["120"]' }).amounts)
    ).toEqual(["1.2"]);
  });

  for (const container of [
    "[120]",
    "[1.2]",
    '["0120"]',
    '["+120"]',
    '["-0"]',
    '["1.20"]',
    '["1e3"]',
    "[null]",
    '["120",null]',
    '[["120"]]',
    '[{"v":"120"}]',
    '["120"',
    "not json",
    '{"0":"120"}',
    '"120"',
    "120",
    "null",
    "[true]",
  ]) {
    test(`the hostile container ${container} fails loudly`, () => {
      expect(refusalOf(sqlite, { amounts: container })).toMatch(
        LIST_DOMAIN_REFUSAL
      );
    });
  }

  test("a coefficient outside the column's declared precision is refused", () => {
    // 17 digits in a precision-16 column: the container is well-formed and the
    // value is not one this column can hold.
    expect(refusalOf(sqlite, { amounts: '["99999999999999999"]' })).toMatch(
      LIST_DOMAIN_REFUSAL
    );
  });

  test("a native array is refused where a container was promised", () => {
    // The container is a STRING on these providers. An array here means the
    // driver, the adapter or the projection changed under the decode.
    expect(refusalOf(sqlite, { amounts: ["120"] })).toMatch(
      LIST_DOMAIN_REFUSAL
    );
  });
});

describe("the cache boundary of a decimal list", () => {
  function codec() {
    const shape = buildExpectedResultShape(
      basket,
      "findMany",
      READ_ARGS,
      indexFor(basket)
    );
    if (!shape) throw new Error("the test read has no expected result shape");
    return compileCacheResultCodec(basket, "findMany", "findMany", shape);
  }

  const parsedRows = () =>
    parseResult<Record<string, unknown>[]>(
      parserFor(new PostgresAdapter(), basket),
      "findMany",
      [
        {
          id: "b-1",
          amounts: ["1.20", "-0.03", "90071992547409.93"],
          optionalAmounts: null,
        },
      ],
      READ_ARGS
    );

  test("a snapshot holds canonical text and every hit is a fresh member", () => {
    const cache = codec();
    const stored = JSON.parse(JSON.stringify(cache.snapshot(parsedRows())));

    // Canonical text, and no coefficient: the snapshot is the LOGICAL value,
    // never the physical container that produced it.
    expect(JSON.stringify(stored)).toContain('"90071992547409.93"');
    expect(JSON.stringify(stored)).not.toContain("9007199254740993");

    const first = firstRowOf(cache.materialize(stored));
    const second = firstRowOf(cache.materialize(stored));
    const firstMembers = first.amounts;
    const secondMembers = second.amounts;

    expect(members(firstMembers)).toEqual([
      "1.2",
      "-0.03",
      "90071992547409.93",
    ]);
    expect(members(secondMembers)).toEqual(members(firstMembers));
    expect(Array.isArray(firstMembers) && firstMembers[0]).not.toBe(
      Array.isArray(secondMembers) && secondMembers[0]
    );
  });

  test("a nullable list keeps its null across the store", () => {
    const cache = codec();
    const stored = JSON.parse(JSON.stringify(cache.snapshot(parsedRows())));
    expect(firstRowOf(cache.materialize(stored)).optionalAmounts).toBeNull();
  });
});
